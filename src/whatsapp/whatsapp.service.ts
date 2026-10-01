import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import makeWASocket, {
  DisconnectReason,
  WASocket,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import * as qrcodeTerminal from 'qrcode-terminal';
import * as QRCode from 'qrcode';
import pino from 'pino';
import { FirebaseService } from '../firebase/firebase.service';
import { clearFirebaseSession, useFirebaseAuthState } from './firebase-auth-state';

/**
 * Representa una sesión de WhatsApp vinculada (una por conjunto, más una
 * sesión por defecto retrocompatible).
 */
interface WhatsappSession {
  /** Clave lógica de la sesión (nombre del conjunto normalizado, o DEFAULT). */
  key: string;
  /** Clave de persistencia (nodo RTDB: `session` o `session:<key>`). */
  sessionKey: string;
  sock: WASocket | null;
  ready: boolean;
  /** Último QR crudo emitido por Baileys, o null si ya está conectado. */
  currentQr: string | null;
  clearSession: (() => Promise<void>) | null;
  flushSession: (() => Promise<void>) | null;
  connecting: boolean;
  consecutiveFailures: number;
}

/**
 * Maneja la conexión con WhatsApp usando Baileys, con MULTI-SESIÓN por conjunto.
 *
 * - Cada conjunto puede vincular su propio número; las notificaciones de ese
 *   conjunto salen desde su sesión. Existe además una sesión por defecto
 *   (clave DEFAULT_KEY) retrocompatible con el comportamiento global anterior.
 * - Cada sesión persiste en la hoja wsp_session en su propia fila:
 *   `session` (por defecto) o `session:<conjunto>`.
 * - Muestra el QR por consola y lo expone vía getQr(conjunto) para HTTP.
 * - Reconecta automáticamente salvo logout; permite relogin(conjunto).
 */
@Injectable()
export class WhatsappService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WhatsappService.name);

  /** Clave de la sesión por defecto (número global histórico). */
  static readonly DEFAULT_KEY = '__default__';
  /** Umbral tras el cual se limpia la sesión y se fuerza un QR nuevo. */
  private static readonly MAX_FAILURES_BEFORE_RESET = 5;

  /** Sesiones activas, indexadas por clave lógica (conjunto normalizado). */
  private readonly sessions = new Map<string, WhatsappSession>();

  constructor(private readonly firebase: FirebaseService) {}

  async onModuleInit() {
    // Arranca la sesión por defecto (retrocompatibilidad con el número global).
    // Las sesiones por conjunto se crean on-demand cuando el admin pide su QR
    // o cuando se intenta notificar a ese conjunto.
    this.ensureSession(WhatsappService.DEFAULT_KEY)
      .connect()
      .catch((e) =>
        this.logger.error(`Fallo al iniciar la sesión por defecto: ${e?.message}`),
      );
  }

  async onModuleDestroy() {
    for (const session of this.sessions.values()) {
      try {
        await session.flushSession?.();
      } catch {
        // no-op
      }
      try {
        await session.sock?.end(undefined);
      } catch {
        // no-op
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Gestión de claves y sesiones
  // ---------------------------------------------------------------------------

  /** Normaliza el nombre de conjunto a una clave estable para indexar sesiones. */
  private normalizeKey(conjunto?: string | null): string {
    const c = (conjunto == null ? '' : String(conjunto)).trim().toLowerCase();
    return c || WhatsappService.DEFAULT_KEY;
  }

  /** Clave de persistencia (nodo RTDB) para una sesión. */
  private rowKeyFor(key: string): string {
    return key === WhatsappService.DEFAULT_KEY ? 'session' : `session:${key}`;
  }

  /**
   * Devuelve la sesión para la clave dada, creando su registro en memoria si no
   * existe. No conecta por sí misma: usa `.connect()` o `ensureConnected()`.
   */
  private ensureSession(key: string): {
    session: WhatsappSession;
    connect: () => Promise<void>;
  } {
    let session = this.sessions.get(key);
    if (!session) {
      session = {
        key,
        sessionKey: this.rowKeyFor(key),
        sock: null,
        ready: false,
        currentQr: null,
        clearSession: null,
        flushSession: null,
        connecting: false,
        consecutiveFailures: 0,
      };
      this.sessions.set(key, session);
    }
    return { session, connect: () => this.connect(session!) };
  }

  /** Arranca la conexión de una sesión si aún no está lista ni conectando. */
  private ensureConnected(key: string): WhatsappSession {
    const { session, connect } = this.ensureSession(key);
    if (!session.ready && !session.connecting && !session.sock) {
      connect().catch((e) =>
        this.logger.error(`Error conectando sesión '${key}': ${e?.message}`),
      );
    }
    return session;
  }

  // ---------------------------------------------------------------------------
  // Estado / QR (por conjunto)
  // ---------------------------------------------------------------------------

  /** True si la sesión del conjunto (o la por defecto) está conectada. */
  isReady(conjunto?: string | null): boolean {
    const key = this.normalizeKey(conjunto);
    return this.sessions.get(key)?.ready ?? false;
  }

  /**
   * Devuelve el QR actual (crudo + PNG dataURL) de la sesión del conjunto.
   * Si la sesión no existe aún, la crea y arranca la conexión para generar QR.
   */
  async getQr(
    conjunto?: string | null,
  ): Promise<{ qr: string; pngDataUrl: string } | null> {
    const key = this.normalizeKey(conjunto);
    const session = this.ensureConnected(key);
    if (session.ready) return null;
    if (!session.currentQr) return null;
    const pngDataUrl = await QRCode.toDataURL(session.currentQr);
    return { qr: session.currentQr, pngDataUrl };
  }

  // ---------------------------------------------------------------------------
  // Conexión (por sesión)
  // ---------------------------------------------------------------------------

  private async connect(session: WhatsappSession): Promise<void> {
    // Evita conexiones concurrentes de la misma sesión: dos sockets con la
    // misma credencial rompen el descifrado ("unable to authenticate data").
    if (session.connecting) {
      this.logger.debug(
        `connect('${session.key}') ignorado: ya hay una conexión en curso.`,
      );
      return;
    }
    session.connecting = true;

    // Cerrar cualquier socket previo de esta sesión antes de crear uno nuevo.
    try {
      session.sock?.ev.removeAllListeners('connection.update');
      await session.sock?.end(undefined);
    } catch {
      // no-op
    }
    session.sock = null;

    let state: Awaited<ReturnType<typeof useFirebaseAuthState>>['state'];
    let saveCreds: () => Promise<void>;
    try {
      const auth = await useFirebaseAuthState(this.firebase, session.sessionKey);
      state = auth.state;
      saveCreds = auth.saveCreds;
      session.clearSession = auth.clear;
      session.flushSession = auth.flush;
    } catch (e: any) {
      session.connecting = false;
      this.logger.error(
        `No se pudo cargar la sesión '${session.key}' desde Firebase: ${e?.message}. Reintentando en 10s...`,
      );
      setTimeout(
        () => this.connect(session).catch((err) => this.logger.error(err)),
        10000,
      );
      return;
    }

    session.sock = makeWASocket({
      auth: state,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
    });
    session.connecting = false;

    session.sock.ev.on('creds.update', saveCreds);

    session.sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        session.currentQr = qr;
        this.logger.warn(
          `[${session.key}] Escanea este QR con WhatsApp para vincular el número emisor:`,
        );
        qrcodeTerminal.generate(qr, { small: true });
      }

      if (connection === 'open') {
        session.ready = true;
        session.currentQr = null;
        session.consecutiveFailures = 0;
        this.logger.log(`[${session.key}] Conexión con WhatsApp establecida.`);
      }

      if (connection === 'close') {
        session.ready = false;
        const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;
        session.consecutiveFailures++;

        if (loggedOut) {
          this.logger.error(
            `[${session.key}] Sesión cerrada (logout). Usa relogin para vincular otro número.`,
          );
          session.consecutiveFailures = 0;
          return;
        }

        if (
          session.consecutiveFailures >=
          WhatsappService.MAX_FAILURES_BEFORE_RESET
        ) {
          this.logger.error(
            `[${session.key}] Sesión inestable tras ${session.consecutiveFailures} intentos. Limpiando credenciales para regenerar QR...`,
          );
          session.consecutiveFailures = 0;
          session.clearSession?.()
            .catch((e) =>
              this.logger.error(
                `[${session.key}] Error limpiando sesión: ${e?.message}`,
              ),
            )
            .finally(() => {
              setTimeout(
                () => this.connect(session).catch((e) => this.logger.error(e)),
                3000,
              );
            });
          return;
        }

        const delay = 5000 * session.consecutiveFailures;
        this.logger.warn(
          `[${session.key}] Conexión cerrada (intento ${session.consecutiveFailures}). Reintentando en ${delay / 1000}s...`,
        );
        setTimeout(
          () => this.connect(session).catch((e) => this.logger.error(e)),
          delay,
        );
      }
    });
  }

  /**
   * Cierra la sesión del conjunto, borra sus credenciales y arranca una nueva
   * conexión que generará un QR nuevo (para vincular otro número).
   */
  async relogin(conjunto?: string | null): Promise<void> {
    const key = this.normalizeKey(conjunto);
    const { session } = this.ensureSession(key);
    this.logger.warn(
      `[${key}] Relogin solicitado: cerrando sesión y limpiando credenciales...`,
    );
    session.ready = false;
    session.currentQr = null;

    try {
      await session.sock?.logout();
    } catch {
      // no-op
    }
    try {
      await session.sock?.end(undefined);
    } catch {
      // no-op
    }
    session.sock = null;

    if (session.clearSession) {
      await session.clearSession().catch((e) =>
        this.logger.error(`[${key}] Error limpiando sesión: ${e?.message}`),
      );
    } else {
      await clearFirebaseSession(this.firebase, session.sessionKey).catch(
        () => undefined,
      );
    }

    await this.connect(session);
  }

  /**
   * Desvincula el WhatsApp de un conjunto: cierra la sesión, borra sus
   * credenciales de la hoja y la deja APAGADA (a diferencia de relogin, no
   * genera un QR nuevo ni reconecta). Elimina la sesión del mapa.
   *
   * Tras desvincular, los envíos del conjunto vuelven al fallback de la sesión
   * por defecto (número global), igual que un conjunto que nunca vinculó.
   */
  async unlink(conjunto?: string | null): Promise<void> {
    const key = this.normalizeKey(conjunto);
    const session = this.sessions.get(key);
    if (!session) {
      // Nada vinculado en memoria; aun así, borramos el registro persistido.
      await clearFirebaseSession(this.firebase, this.rowKeyFor(key)).catch(
        () => undefined,
      );
      this.logger.log(`[${key}] Desvinculación: no había sesión activa en memoria.`);
      return;
    }

    this.logger.warn(`[${key}] Desvinculación solicitada: cerrando y apagando sesión.`);
    session.ready = false;
    session.currentQr = null;

    try {
      await session.sock?.logout();
    } catch {
      // no-op
    }
    try {
      await session.sock?.end(undefined);
    } catch {
      // no-op
    }
    session.sock = null;

    if (session.clearSession) {
      await session.clearSession().catch((e) =>
        this.logger.error(`[${key}] Error limpiando sesión: ${e?.message}`),
      );
    } else {
      await clearFirebaseSession(this.firebase, session.sessionKey).catch(
        () => undefined,
      );
    }

    // Quitar del mapa: queda apagada. No se reconecta ni se genera QR nuevo.
    this.sessions.delete(key);
  }

  // ---------------------------------------------------------------------------
  // Envío de mensajes (enrutado por conjunto, con fallback a la sesión default)
  // ---------------------------------------------------------------------------

  /**
   * Resuelve el socket a usar para enviar: prioriza la sesión del conjunto si
   * está conectada; si no, cae a la sesión por defecto (número global).
   */
  private resolveSenderSession(conjunto?: string | null): WhatsappSession | null {
    const key = this.normalizeKey(conjunto);
    const own = this.sessions.get(key);
    if (own?.ready && own.sock) return own;

    // Fallback: sesión por defecto (compatibilidad con el número global).
    const def = this.sessions.get(WhatsappService.DEFAULT_KEY);
    if (def?.ready && def.sock) {
      if (key !== WhatsappService.DEFAULT_KEY) {
        this.logger.debug(
          `[${key}] sin sesión propia conectada; se usa la sesión por defecto.`,
        );
      }
      return def;
    }
    return null;
  }

  async sendMessage(
    phone: string | number,
    text: string,
    conjunto?: string | null,
  ): Promise<boolean> {
    const session = this.resolveSenderSession(conjunto);
    if (!session) {
      this.logger.warn('WhatsApp no está listo. Mensaje no enviado.');
      return false;
    }
    try {
      const jid = this.toJid(phone);
      await session.sock!.sendMessage(jid, { text });
      this.logger.log(`[${session.key}] Mensaje enviado a ${phone}`);
      return true;
    } catch (error: any) {
      this.logger.error(`Error enviando a ${phone}: ${error?.message}`);
      return false;
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
    conjunto?: string | null,
  ): Promise<boolean> {
    const session = this.resolveSenderSession(conjunto);
    if (!session) {
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
      if (opts.caption) return this.sendMessage(phone, opts.caption, conjunto);
      this.logger.warn('No se pudo obtener la imagen a enviar.');
      return false;
    }

    try {
      const jid = this.toJid(phone);
      await session.sock!.sendMessage(jid, {
        image: buffer,
        caption: opts.caption || undefined,
      });
      this.logger.log(`[${session.key}] Imagen enviada a ${phone}`);
      return true;
    } catch (error: any) {
      this.logger.error(`Error enviando imagen a ${phone}: ${error?.message}`);
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers (sin cambios de comportamiento)
  // ---------------------------------------------------------------------------

  /**
   * Normaliza un número colombiano a JID de WhatsApp.
   * Acepta formatos como "3001234567", "573001234567", "+57 300 123 4567".
   */
  private toJid(phone: string | number): string {
    let digits = String(phone == null ? '' : phone).replace(/\D/g, '');
    if (!digits) throw new Error('Número de WhatsApp vacío');
    if (digits.length === 10) digits = `57${digits}`;
    return `${digits}@s.whatsapp.net`;
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
   * Convierte enlaces de Google Drive a una URL de descarga directa de la
   * imagen. Soporta formatos comunes: /file/d/<id>/view, ?id=<id>,
   * lh3.googleusercontent.com/d/<id>. Si no reconoce el patrón, devuelve la URL tal cual.
   */
  private normalizeDriveUrl(url: string): string {
    if (!url) return url;
    if (url.includes('googleusercontent.com')) return url;

    const idFromPath = url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
    const idFromQuery = url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
    const id = idFromPath?.[1] || idFromQuery?.[1];
    if (id) return `https://drive.google.com/uc?export=download&id=${id}`;
    return url;
  }
}
