import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import makeWASocket, {
  DisconnectReason,
  WASocket,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import * as qrcodeTerminal from 'qrcode-terminal';
import * as QRCode from 'qrcode';
import pino from 'pino';
import { SheetsService } from '../sheets/sheets.service';
import { clearSheetsSession, useSheetsAuthState } from './sheets-auth-state';

/**
 * Maneja la conexión con WhatsApp usando Baileys.
 * - Persiste la sesión en Google Sheets (hoja wsp_session).
 * - Muestra el QR en consola y lo expone vía getQr() para escanearlo por HTTP.
 * - Reconecta automáticamente salvo que la sesión haya sido cerrada (logout).
 * - Permite relogin() para vincular un número de WhatsApp distinto.
 */
@Injectable()
export class WhatsappService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WhatsappService.name);
  private sock: WASocket | null = null;
  private ready = false;
  private readonly sessionSheet: string;

  /** Último QR emitido (string crudo de Baileys), o null si ya está conectado. */
  private currentQr: string | null = null;
  private clearSession: (() => Promise<void>) | null = null;
  private flushSession: (() => Promise<void>) | null = null;

  /** Evita conexiones concurrentes (que causan sesiones "doble uso"). */
  private connecting = false;
  /** Cierres consecutivos sin llegar a 'open'; alto = sesión probablemente corrupta. */
  private consecutiveFailures = 0;
  /** Umbral tras el cual se limpia la sesión y se fuerza un QR nuevo. */
  private static readonly MAX_FAILURES_BEFORE_RESET = 5;

  static readonly SHEET_SESSION = 'wsp_session';

  constructor(
    private readonly config: ConfigService,
    private readonly sheets: SheetsService,
  ) {
    this.sessionSheet = this.config.get<string>(
      'WHATSAPP_SESSION_SHEET',
      WhatsappService.SHEET_SESSION,
    );
  }

  async onModuleInit() {
    // No await: si el Apps Script no responde, no debe tumbar el arranque.
    // connect() maneja sus propios reintentos.
    this.connect().catch((e) =>
      this.logger.error(`Fallo al iniciar conexión de WhatsApp: ${e?.message}`),
    );
  }

  async onModuleDestroy() {
    // Persistir cualquier cambio pendiente antes de apagar.
    try {
      await this.flushSession?.();
    } catch {
      // no-op
    }
    try {
      await this.sock?.end(undefined);
    } catch {
      // no-op
    }
  }

  isReady(): boolean {
    return this.ready;
  }

  private async connect(): Promise<void> {
    // Evita conexiones concurrentes: dos sockets con la misma sesión provocan
    // fallos de descifrado ("unable to authenticate data").
    if (this.connecting) {
      this.logger.debug('connect() ignorado: ya hay una conexión en curso.');
      return;
    }
    this.connecting = true;

    // Cerrar cualquier socket previo antes de crear uno nuevo.
    try {
      this.sock?.ev.removeAllListeners('connection.update');
      await this.sock?.end(undefined);
    } catch {
      // no-op
    }
    this.sock = null;

    let state: Awaited<ReturnType<typeof useSheetsAuthState>>['state'];
    let saveCreds: () => Promise<void>;
    try {
      const auth = await useSheetsAuthState(this.sheets, this.sessionSheet);
      state = auth.state;
      saveCreds = auth.saveCreds;
      this.clearSession = auth.clear;
      this.flushSession = auth.flush;
    } catch (e: any) {
      // Si no se pudo cargar la sesión (p. ej. Apps Script caído), reintentar
      // sin tumbar el proceso.
      this.connecting = false;
      this.logger.error(
        `No se pudo cargar la sesión desde Sheets: ${e?.message}. Reintentando en 10s...`,
      );
      setTimeout(() => this.connect().catch((err) => this.logger.error(err)), 10000);
      return;
    }

    this.sock = makeWASocket({
      auth: state,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
    });
    // El socket ya se creó; permitir futuras reconexiones desde 'close'.
    this.connecting = false;

    this.sock.ev.on('creds.update', saveCreds);

    this.sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        this.currentQr = qr;
        this.logger.warn(
          'Escanea este QR con WhatsApp para vincular el número emisor ' +
            `(o abre GET /whatsapp/qr):`,
        );
        qrcodeTerminal.generate(qr, { small: true });
      }

      if (connection === 'open') {
        this.ready = true;
        this.currentQr = null;
        this.consecutiveFailures = 0; // conexión sana: reiniciar contador
        this.logger.log('Conexión con WhatsApp establecida.');
      }

      if (connection === 'close') {
        this.ready = false;
        const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;
        this.consecutiveFailures++;

        if (loggedOut) {
          this.logger.error(
            `Sesión cerrada (logout). Usa POST /whatsapp/relogin para vincular otro número.`,
          );
          this.consecutiveFailures = 0;
          return;
        }

        // Si la sesión falla repetidamente sin llegar a conectar, casi siempre
        // está corrupta (errores de descifrado del protocolo Noise). Limpiarla
        // y forzar una vinculación nueva por QR, en vez de reintentar en bucle.
        if (this.consecutiveFailures >= WhatsappService.MAX_FAILURES_BEFORE_RESET) {
          this.logger.error(
            `Sesión inestable tras ${this.consecutiveFailures} intentos. Limpiando credenciales para regenerar QR...`,
          );
          this.consecutiveFailures = 0;
          this.clearSession?.()
            .catch((e) => this.logger.error(`Error limpiando sesión: ${e?.message}`))
            .finally(() => {
              setTimeout(() => this.connect().catch((e) => this.logger.error(e)), 3000);
            });
          return;
        }

        // Backoff creciente (5s, 10s, 15s...) hasta el reset.
        const delay = 5000 * this.consecutiveFailures;
        this.logger.warn(
          `Conexión cerrada (intento ${this.consecutiveFailures}). Reintentando en ${delay / 1000}s...`,
        );
        setTimeout(() => this.connect().catch((e) => this.logger.error(e)), delay);
      }
    });
  }

  /**
   * Cierra la sesión actual, borra las credenciales guardadas en Sheets y
   * arranca una conexión nueva que generará un QR nuevo. Sirve para vincular
   * un número de WhatsApp distinto.
   */
  async relogin(): Promise<void> {
    this.logger.warn('Relogin solicitado: cerrando sesión y limpiando credenciales...');
    this.ready = false;
    this.currentQr = null;

    // Intentar logout limpio (best-effort); ignora errores si ya está caído.
    try {
      await this.sock?.logout();
    } catch {
      // no-op
    }
    try {
      await this.sock?.end(undefined);
    } catch {
      // no-op
    }
    this.sock = null;

    // Limpiar la sesión persistida en Sheets.
    if (this.clearSession) {
      await this.clearSession().catch((e) =>
        this.logger.error(`Error limpiando sesión: ${e?.message}`),
      );
    } else {
      await clearSheetsSession(this.sheets, this.sessionSheet).catch(() => undefined);
    }

    // Reconectar en limpio -> emitirá un QR nuevo.
    await this.connect();
  }

  /** Devuelve el QR actual como string crudo y como dataURL PNG (o null). */
  async getQr(): Promise<{ qr: string; pngDataUrl: string } | null> {
    if (this.ready) return null;
    if (!this.currentQr) return null;
    const pngDataUrl = await QRCode.toDataURL(this.currentQr);
    return { qr: this.currentQr, pngDataUrl };
  }

  /**
   * Normaliza un número colombiano a JID de WhatsApp.
   * Acepta formatos como "3001234567", "573001234567", "+57 300 123 4567".
   */
  private toJid(phone: string | number): string {
    // El teléfono puede llegar como número (Google Sheets) o con formato; se
    // normaliza a string y se dejan solo dígitos.
    let digits = String(phone == null ? '' : phone).replace(/\D/g, '');
    if (!digits) throw new Error('Número de WhatsApp vacío');
    // Si viene sin indicativo (10 dígitos, típico celular CO) le anteponemos 57.
    if (digits.length === 10) digits = `57${digits}`;
    return `${digits}@s.whatsapp.net`;
  }

  async sendMessage(phone: string | number, text: string): Promise<boolean> {
    if (!this.sock || !this.ready) {
      this.logger.warn('WhatsApp no está listo. Mensaje no enviado.');
      return false;
    }
    try {
      const jid = this.toJid(phone);
      await this.sock.sendMessage(jid, { text });
      this.logger.log(`Mensaje enviado a ${phone}`);
      return true;
    } catch (error: any) {
      this.logger.error(`Error enviando a ${phone}: ${error?.message}`);
      return false;
    }
  }

  /**
   * Descarga una imagen desde una URL (p. ej. el comprobante en Google Drive)
   * y devuelve su contenido como Buffer. Devuelve null si falla.
   */
  private async downloadImage(url: string): Promise<Buffer | null> {
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 20000);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(t);
      if (!res.ok) {
        this.logger.warn(`No se pudo descargar la imagen (${res.status}): ${url}`);
        return null;
      }
      const arrayBuffer = await res.arrayBuffer();
      return Buffer.from(arrayBuffer);
    } catch (e: any) {
      this.logger.error(`Error descargando imagen: ${e?.message}`);
      return null;
    }
  }

  /**
   * Envía una imagen por WhatsApp. Acepta la imagen como URL (imageUrl) o como
   * base64 (imageBase64). Si se pasa una URL de Google Drive se intenta
   * normalizar a un enlace de descarga directa.
   */
  async sendImage(
    phone: string | number,
    opts: { imageUrl?: string; imageBase64?: string; caption?: string },
  ): Promise<boolean> {
    if (!this.sock || !this.ready) {
      this.logger.warn('WhatsApp no está listo. Imagen no enviada.');
      return false;
    }

    let buffer: Buffer | null = null;
    if (opts.imageBase64) {
      const clean = opts.imageBase64.replace(/^data:image\/\w+;base64,/, '');
      try {
        buffer = Buffer.from(clean, 'base64');
      } catch {
        buffer = null;
      }
    } else if (opts.imageUrl) {
      buffer = await this.downloadImage(this.normalizeDriveUrl(opts.imageUrl));
    }

    if (!buffer || buffer.length === 0) {
      // Si no se logró obtener la imagen pero hay caption, al menos manda el texto.
      if (opts.caption) return this.sendMessage(phone, opts.caption);
      this.logger.warn('No se pudo obtener la imagen a enviar.');
      return false;
    }

    try {
      const jid = this.toJid(phone);
      await this.sock.sendMessage(jid, { image: buffer, caption: opts.caption || undefined });
      this.logger.log(`Imagen enviada a ${phone}`);
      return true;
    } catch (error: any) {
      this.logger.error(`Error enviando imagen a ${phone}: ${error?.message}`);
      return false;
    }
  }

  /**
   * Convierte enlaces de Google Drive a una URL de descarga directa de la
   * imagen. Soporta formatos comunes: /file/d/<id>/view, ?id=<id>,
   * lh3.googleusercontent.com/d/<id>. Si no reconoce el patrón, devuelve la URL tal cual.
   */
  private normalizeDriveUrl(url: string): string {
    if (!url) return url;
    // lh3.googleusercontent.com/d/<id> ya sirve como imagen directa.
    if (url.includes('googleusercontent.com')) return url;

    const idFromPath = url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
    const idFromQuery = url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
    const id = idFromPath?.[1] || idFromQuery?.[1];
    if (id) return `https://drive.google.com/uc?export=download&id=${id}`;
    return url;
  }
}
