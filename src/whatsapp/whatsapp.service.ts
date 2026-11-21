import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import makeWASocket, {
  DisconnectReason,
  WASocket,
  isJidBroadcast,
  isJidGroup,
  isJidNewsletter,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import { monitorEventLoopDelay } from 'perf_hooks';
import * as qrcodeTerminal from 'qrcode-terminal';
import * as QRCode from 'qrcode';
import pino from 'pino';
import NodeCache from 'node-cache';
import { FirebaseService } from '../firebase/firebase.service';
import {
  clearFirebaseSession,
  safeNodeKey,
  useFirebaseAuthState,
  WSP_SESSION_ROOT,
} from './firebase-auth-state';
import { Entrega, SentMessageStore } from './sent-message.store';

/**
 * libsignal (dependencia de Baileys) imprime con console.error un stack completo
 * por cada mensaje entrante que no logra descifrar ("Bad MAC"). Son esperables
 * (WhatsApp reintenta y renegocia la sesión) pero inundan los logs de Render y
 * escribir a stdout de forma síncrona también cuesta. Se descartan y se resumen
 * en una sola línea por minuto.
 */
let signalNoiseCount = 0;
const originalConsoleError = console.error.bind(console);
console.error = (...args: any[]) => {
  const first = typeof args[0] === 'string' ? args[0] : '';
  if (
    first.startsWith('Session error:') ||
    first.startsWith('Failed to decrypt message with any known session')
  ) {
    signalNoiseCount++;
    return;
  }
  originalConsoleError(...args);
};
setInterval(() => {
  if (signalNoiseCount > 0) {
    new Logger('libsignal').warn(
      `${signalNoiseCount} mensajes entrantes no se pudieron descifrar (Bad MAC) en el último minuto.`,
    );
    signalNoiseCount = 0;
  }
}, 60_000).unref();

/**
 * Medidor del event loop: si algo síncrono (serialización, descifrado) lo
 * bloquea, todas las peticiones HTTP esperan. Se reporta solo cuando el p99 del
 * último minuto supera 200 ms, para poder confirmarlo en los logs de Render.
 */
const loopDelay = monitorEventLoopDelay({ resolution: 20 });
loopDelay.enable();
/** Memoria del proceso en MB, para los logs. */
export function memSummary(): string {
  const m = process.memoryUsage();
  const mb = (n: number) => Math.round(n / 1048576);
  return `rss=${mb(m.rss)}MB heap=${mb(m.heapUsed)}/${mb(m.heapTotal)}MB external=${mb(m.external)}MB`;
}
let minutes = 0;
setInterval(() => {
  const p99 = loopDelay.percentile(99) / 1e6;
  const max = loopDelay.max / 1e6;
  const rssMb = process.memoryUsage().rss / 1048576;
  minutes++;
  if (p99 > 200) {
    new Logger('EventLoop').warn(
      `Event loop bloqueado: p99=${Math.round(p99)}ms, max=${Math.round(max)}ms (último minuto). ${memSummary()}`,
    );
  } else if (rssMb > 400) {
    // Render Starter = 512 MB: por encima de ~400 MB el contenedor está cerca
    // de que lo maten por memoria.
    new Logger('Memoria').warn(`Memoria alta: ${memSummary()}`);
  } else if (minutes % 5 === 0) {
    new Logger('Memoria').log(memSummary());
  }
  loopDelay.reset();
}, 60_000).unref();

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
  /**
   * Vinculación por CÓDIGO (pairing code) en vez de QR. Cuando `usePairing` es
   * true y la sesión aún no está registrada, al conectar se solicita a WhatsApp
   * un código de 8 caracteres para `pairingPhone` en lugar de esperar el QR.
   */
  usePairing: boolean;
  /** Teléfono (solo dígitos, formato internacional) para el pairing code. */
  pairingPhone: string | null;
  /** Último código de emparejamiento emitido (8 caracteres) o null. */
  pairingCode: string | null;
  /**
   * Sesión apagada a propósito (unlink, o restauración automática que resultó
   * no estar vinculada). Con true, el handler de cierre NO reconecta: antes,
   * tras un unlink el socket viejo reconectaba solo y quedaba emitiendo QR.
   */
  stopped: boolean;
  /**
   * Reconexión automática al arrancar el proceso. Si en vez de conectar emite
   * un QR (la sesión no estaba vinculada), se apaga en lugar de quedarse
   * generando QR indefinidamente.
   */
  autoRestore: boolean;
}

/** Resultado detallado de un envío (para la cola y los reportes). */
export interface SendResult {
  ok: boolean;
  /** Motivo del fallo: sin sesión lista, número inválido, sin WhatsApp o error. */
  reason?: 'sin_sesion' | 'numero_invalido' | 'sin_whatsapp' | 'texto_vacio' | 'error';
  error?: string;
  /** Id del mensaje en WhatsApp (para consultar su estado de entrega). */
  messageId?: string;
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

  /** Sesiones activas, indexadas por clave lógica (conjunto normalizado). */
  private readonly sessions = new Map<string, WhatsappSession>();

  /**
   * Cache compartido para reintentos de mensajes (Signal retry protocol).
   * Un único cache por proceso evita colisiones de pre-keys entre sesiones.
   * stdTTL = 60 s (los reintentos de Signal expiran rápido).
   */
  private readonly msgRetryCounterCache = new NodeCache({ stdTTL: 60 });

  /**
   * Mensajes enviados (para reenvíos sin burbujas vacías) y su estado de
   * entrega. Ver `SentMessageStore`.
   */
  private readonly store: SentMessageStore;
  /** Revisión periódica de entregas (reintentos / sin entregar). */
  private revisionTimer: NodeJS.Timeout | null = null;
  private static readonly REVISION_MS = 10 * 60_000;

  constructor(private readonly firebase: FirebaseService) {
    this.store = new SentMessageStore(firebase, this.logger);
  }

  async onModuleInit() {
    // Arranca la sesión por defecto (retrocompatibilidad con el número global).
    // Las sesiones por conjunto se crean on-demand cuando el admin pide su QR
    // o cuando se intenta notificar a ese conjunto.
    this.ensureSession(WhatsappService.DEFAULT_KEY)
      .connect()
      .catch((e) =>
        this.logger.error(`Fallo al iniciar la sesión por defecto: ${e?.message}`),
      );

    // Reconecta las sesiones de conjuntos que ya estaban vinculadas. Antes solo
    // volvían cuando el admin pedía su QR; mientras tanto sus mensajes salían
    // en silencio desde el número global de goPase.
    setTimeout(() => {
      this.restoreConjuntoSessions().catch((e) =>
        this.logger.error(`Fallo restaurando sesiones de conjuntos: ${e?.message}`),
      );
    }, 5000);

    // Entregas: recarga las pendientes de hoy/ayer (tras un reinicio), borra
    // los días vencidos y revisa cada 10 min qué reenviar. Todo en segundo
    // plano, fuera del arranque de la API.
    const arranque = setTimeout(() => {
      this.store
        .cargarRecientes()
        .then((n) => n && this.logger.log(`Entregas de WhatsApp recargadas: ${n}.`))
        .catch(() => undefined);
      this.store.limpiarViejos().catch(() => undefined);
    }, 20_000);
    arranque.unref?.();
    this.revisionTimer = setInterval(() => {
      this.revisarEntregas().catch((e) =>
        this.logger.warn(`Revisión de entregas falló: ${e?.message}`),
      );
    }, WhatsappService.REVISION_MS);
    this.revisionTimer.unref?.();
  }

  /**
   * Arranca, escalonadas, las sesiones de los conjuntos que tienen credenciales
   * guardadas en RTDB. Si alguna resulta no estar vinculada (pide QR), se apaga
   * sola (ver `autoRestore` en el handler de conexión).
   */
  private async restoreConjuntoSessions(): Promise<void> {
    if (!this.firebase.isEnabled()) return;
    const conjuntos = await this.firebase.liveValues<any>('mirror/conjuntos');
    let restauradas = 0;
    for (const c of conjuntos) {
      const key = this.normalizeKey(c?.nombre);
      if (key === WhatsappService.DEFAULT_KEY || this.sessions.has(key)) continue;
      const node = safeNodeKey(this.rowKeyFor(key));
      try {
        // Solo el campo chico `updatedAt`: no descarga el payload de la sesión.
        const snap = await this.firebase.db().ref(`${WSP_SESSION_ROOT}/${node}/updatedAt`).get();
        if (!snap.exists()) continue;
      } catch {
        continue;
      }
      const { session, connect } = this.ensureSession(key);
      session.autoRestore = true;
      connect().catch((e) =>
        this.logger.error(`[${key}] Error restaurando sesión: ${e?.message}`),
      );
      restauradas++;
      // Escalonar: varios handshakes simultáneos pesan en CPU/RAM de Render.
      await new Promise((r) => setTimeout(r, 3000));
    }
    if (restauradas) this.logger.log(`Restauración: ${restauradas} sesiones de conjunto en curso.`);
  }

  /** Apaga una sesión sin borrar sus credenciales y la quita del mapa. */
  private stopSession(session: WhatsappSession): void {
    session.stopped = true;
    session.ready = false;
    session.currentQr = null;
    const sock = session.sock;
    session.sock = null;
    session.connecting = false;
    try {
      sock?.end(undefined);
    } catch {
      // no-op
    }
    if (this.sessions.get(session.key) === session) this.sessions.delete(session.key);
  }

  async onModuleDestroy() {
    if (this.revisionTimer) clearInterval(this.revisionTimer);
    await this.store.flush().catch(() => undefined);
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
        usePairing: false,
        pairingPhone: null,
        pairingCode: null,
        stopped: false,
        autoRestore: false,
      };
      this.sessions.set(key, session);
    }
    return { session, connect: () => this.connect(session!) };
  }

  /** Arranca la conexión de una sesión si aún no está lista ni conectando. */
  private ensureConnected(key: string): WhatsappSession {
    const { session, connect } = this.ensureSession(key);
    // Pedido explícito (QR del admin): la sesión vuelve a estar habilitada.
    session.stopped = false;
    session.autoRestore = false;
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

  /**
   * Vinculación por CÓDIGO (pairing code) para el conjunto. Devuelve un código
   * de 8 caracteres que el admin ingresa en su WhatsApp:
   *   WhatsApp > Dispositivos vinculados > Vincular con número de teléfono.
   *
   * Pensado para cuando el admin abre la app EN EL MISMO teléfono donde tiene
   * WhatsApp (no puede escanear su propio QR). Requiere el número en formato
   * internacional (se normaliza a solo dígitos). Si ya está conectado, devuelve
   * `ready: true` sin generar código.
   */
  async getPairingCode(
    conjunto: string | null | undefined,
    phone: string,
  ): Promise<{ ready: boolean; code: string | null; message?: string }> {
    const key = this.normalizeKey(conjunto);
    const digits = String(phone ?? '').replace(/\D/g, '');
    if (!digits || digits.length < 10) {
      return { ready: false, code: null, message: 'Número de teléfono inválido.' };
    }
    this.logger.log(`[${key}] Pairing code solicitado para número: ${digits} (${digits.length} dígitos)`);

    const { session } = this.ensureSession(key);
    session.stopped = false;
    session.autoRestore = false;
    if (session.ready) {
      return { ready: true, code: null, message: 'WhatsApp ya está conectado.' };
    }

    // Si ya hay un código vigente para el MISMO número, reutilízalo (evita
    // reiniciar el socket en cada poll del frontend).
    if (session.usePairing && session.pairingPhone === digits && session.pairingCode) {
      return { ready: false, code: session.pairingCode };
    }

    // Activa el modo pairing y reinicia el socket para que solicite el código
    // en el próximo connect(). Limpiamos cualquier QR/estado previo.
    session.usePairing = true;
    session.pairingPhone = digits;
    session.pairingCode = null;
    session.currentQr = null;

    // Fuerza una reconexión limpia (el handler connect() pedirá el código).
    // IMPORTANTE: si hay credenciales residuales de una sesión anterior con QR
    // (creds.me está seteado pero creds.registered=false), WhatsApp rechaza el
    // pairing code porque ya reconoce el dispositivo como registrado a medias.
    // Limpiamos la sesión persistida para garantizar un estado limpio.
    try {
      session.sock?.ev.removeAllListeners('connection.update');
      await session.sock?.end(undefined);
    } catch {
      // no-op
    }
    session.sock = null;
    session.connecting = false;

    // Limpiar credenciales residuales antes de pedir el código: evita que
    // WhatsApp rechace el pairing por un creds.me de una sesión previa.
    if (session.clearSession) {
      await session.clearSession().catch(() => undefined);
    }

    this.connect(session).catch((e) =>
      this.logger.error(`[${key}] Error conectando para pairing: ${e?.message}`),
    );

    // Espera a que el código esté disponible (lo genera connect() tras ~5s + reintentos).
    const maxMs = 30000;
    const step = 1000;
    let waited = 0;
    while (waited < maxMs) {
      if (session.ready) return { ready: true, code: null };
      if (session.pairingCode) return { ready: false, code: session.pairingCode };
      await new Promise((r) => setTimeout(r, step));
      waited += step;
    }
    return {
      ready: false,
      code: null,
      message: 'No se pudo generar el código aún. Intenta de nuevo en unos segundos.',
    };
  }

  // ---------------------------------------------------------------------------
  // Conexión (por sesión)
  // ---------------------------------------------------------------------------

  private async connect(session: WhatsappSession): Promise<void> {
    // Evita conexiones concurrentes de la misma sesión: dos sockets con la
    // misma credencial rompen el descifrado ("unable to authenticate data").
    if (session.stopped) {
      this.logger.debug(`connect('${session.key}') ignorado: sesión apagada.`);
      return;
    }
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
      this.logger.log(`[${session.key}] Sesión cargada desde RTDB. ${memSummary()}`);
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
      // ── Corrección "Esperando mensaje" en el dispositivo vinculado ──────────
      // getMessage: WhatsApp lo pide cuando un dispositivo (el destinatario o
      // el propio teléfono del emisor) no pudo descifrar un mensaje y solicita
      // reenviarlo. Se busca en memoria y, tras un reinicio, en RTDB.
      // Si no existe se devuelve undefined: Baileys no reenvía. NUNCA
      // `{ conversation: '' }`: eso se reenviaba y llegaba como burbuja VACÍA.
      getMessage: async (key) => (key.id ? this.store.get(session.key, key.id) : undefined),
      // Evita descargar el historial completo al reconectar (reduce pre-keys
      // duplicadas y colisiones de senderKeys que causan descifrado fallido).
      syncFullHistory: false,
      // Cache de reintentos de mensajes (compartido entre sesiones del proceso).
      // Previene que el contador de reintentos de Signal se pierda entre
      // reconexiones rápidas del mismo proceso.
      msgRetryCounterCache: this.msgRetryCounterCache,
      // No marcar el número como "en línea" al conectar (reduce firma detectable).
      markOnlineOnConnect: false,
      // Este servicio SOLO envía. Sin esto, Baileys descifra todo lo que llega
      // al número vinculado (grupos, estados, canales): cada mensaje cuesta CPU,
      // dispara "Bad MAC" cuando la sender-key no coincide, provoca reintentos y
      // reescrituras de la sesión en RTDB, y bloquea el event loop que también
      // atiende la API (la app "se queda pensando").
      shouldIgnoreJid: (jid) =>
        !!(isJidGroup(jid) || isJidBroadcast(jid) || isJidNewsletter(jid)),
      // Nunca procesar historial (también genera descifrado y escrituras).
      shouldSyncHistoryMessage: () => false,
    });
    session.connecting = false;

    session.sock.ev.on('creds.update', saveCreds);
    this.ackIncomingWithoutDecrypt(session);

    // Guardar mensajes en Firebase (TTL 24h) para que getMessage() los encuentre
    // tras un reinicio de Render.
    session.sock.ev.on('messages.upsert', ({ messages }) => {
      for (const msg of messages) {
        // Solo los mensajes PROPIOS: getMessage() los pide para reenviar la
        // copia al teléfono principal. Guardar los entrantes solo llenaba RAM.
        if (msg.key?.fromMe && msg.key?.id && msg.message) {
          this.store.remember(session.key, msg.key.id, msg.message);
        }
      }
    });

    // Recibos de entrega/lectura (y errores) de los mensajes que envió el
    // servicio. Los de mensajes escritos desde el teléfono se ignoran.
    session.sock.ev.on('messages.update', (updates) => {
      for (const u of updates) {
        const status = u.update?.status;
        if (!u.key?.fromMe || !u.key.id || status == null) continue;
        const error = Array.isArray(u.update?.messageStubParameters)
          ? String(u.update.messageStubParameters[0] ?? '')
          : undefined;
        const e = this.store.actualizarEstado(u.key.id, Number(status), error);
        if (e?.estado === 'error' && e.reintentos < this.store.maxReintentos) {
          // Error en el acuse del servidor: un reenvío con el MISMO id (el
          // destinatario nunca ve duplicados) a los 10 s.
          const t = setTimeout(() => {
            this.reenviar(e).catch(() => undefined);
          }, 10_000);
          t.unref?.();
        }
      }
    });

    // Vinculación por CÓDIGO (pairing code): si se solicitó y la sesión aún no
    // está registrada, pedimos el código a WhatsApp en vez de usar el QR. Debe
    // hacerse recién creado el socket y ANTES de que se registre.
    // - 5s de delay: da margen suficiente para el handshake TLS incluso en cold
    //   start de Render (3s era insuficiente con latencia de red alta).
    // - Reintentos (máx 3): si WhatsApp responde con error transitorio (p.ej.
    //   rate-limit o conexión en progreso) se reintenta cada 3s.
    if (session.usePairing && session.pairingPhone && !state.creds.registered) {
      const sockRef = session.sock;
      const phone = session.pairingPhone;
      const tryRequest = (attempt: number) => {
        // Evita pedir el código si entretanto la sesión conectó o se recicló.
        if (session.sock !== sockRef || session.ready) return;
        sockRef
          .requestPairingCode(phone)
          .then((code) => {
            session.pairingCode = code;
            this.logger.log(
              `[${session.key}] Código de emparejamiento generado para ${phone}: ${code}`,
            );
          })
          .catch((e: any) => {
            this.logger.warn(
              `[${session.key}] Intento ${attempt} de pairing code falló: ${e?.message}`,
            );
            if (attempt < 3 && !session.ready && session.sock === sockRef) {
              // Reintenta en 3s (máx 3 intentos).
              setTimeout(() => tryRequest(attempt + 1), 3000);
            } else {
              session.pairingCode = null;
              this.logger.error(
                `[${session.key}] No se pudo generar el código de emparejamiento tras ${attempt} intentos.`,
              );
            }
          });
      };
      setTimeout(() => tryRequest(1), 5000);
    }

    session.sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr && session.autoRestore) {
        // Restauración automática al arrancar, pero la sesión NO estaba
        // vinculada (pide QR): se apaga en vez de quedar emitiendo QR. Se
        // vuelve a encender cuando el admin pida su QR (getQr/pairing).
        this.logger.warn(
          `[${session.key}] No estaba vinculada (pidió QR); se apaga la restauración automática.`,
        );
        this.stopSession(session);
        return;
      }

      if (qr) {
        session.currentQr = qr;
        this.logger.warn(
          `[${session.key}] Escanea este QR con WhatsApp para vincular el número emisor:`,
        );
        qrcodeTerminal.generate(qr, { small: true });
      }

      if (connection === 'open') {
        session.ready = true;
        // Ya probó estar vinculada: desde aquí se comporta como una sesión normal.
        session.autoRestore = false;
        session.currentQr = null;
        session.consecutiveFailures = 0;
        // Vinculación completada: ya no se necesita el código ni el modo pairing.
        session.pairingCode = null;
        session.usePairing = false;
        session.pairingPhone = null;
        this.logger.log(`[${session.key}] Conexión con WhatsApp establecida.`);
      }

      if (connection === 'close') {
        session.ready = false;
        // Sesión apagada a propósito (unlink / restauración no vinculada): no reconectar.
        if (session.stopped) return;
        const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;
        session.consecutiveFailures++;

        // ÚNICO caso en que las credenciales ya no sirven: WhatsApp cerró el
        // dispositivo vinculado (logout real, statusCode 401). Solo aquí se
        // limpia la sesión para poder generar un QR nuevo. En cualquier otro
        // escenario (timeouts, cold start de Render al despertar, reinicios,
        // pérdidas de red, 5xx) las credenciales SIGUEN siendo válidas, así que
        // NO se borran: solo se reconecta. Borrarlas era lo que obligaba a
        // reescanear el QR y rompía la persistencia del vínculo.
        if (loggedOut) {
          this.logger.error(
            `[${session.key}] WhatsApp cerró la sesión (logout). Limpiando credenciales para regenerar QR...`,
          );
          session.consecutiveFailures = 0;
          session.clearSession?.()
            .catch((e) =>
              this.logger.error(
                `[${session.key}] Error limpiando sesión: ${e?.message}`,
              ),
            )
            .finally(() => {
              // Reconecta para que getQr() pueda emitir un QR nuevo.
              setTimeout(
                () => this.connect(session).catch((e) => this.logger.error(e)),
                3000,
              );
            });
          return;
        }

        // Backoff exponencial acotado (5s, 10s, 20s, 40s... máx 60s). Reintenta
        // indefinidamente SIN borrar credenciales: la sesión se recupera sola
        // cuando la red/servicio vuelve, aunque Render haya dormido el proceso.
        const delay = Math.min(60000, 5000 * 2 ** (session.consecutiveFailures - 1));
        this.logger.warn(
          `[${session.key}] Conexión cerrada (intento ${session.consecutiveFailures}, code=${statusCode ?? 'n/a'}). ` +
            `Reintentando en ${Math.round(delay / 1000)}s SIN borrar la sesión...`,
        );
        setTimeout(
          () => this.connect(session).catch((e) => this.logger.error(e)),
          delay,
        );
      }
    });
  }

  /**
   * Este servicio SOLO envía: los mensajes que llegan al número vinculado no se
   * usan. Aun así Baileys descifraba cada uno, y con sesiones Signal
   * desincronizadas todos fallaban ("Bad MAC"): WhatsApp los reenviaba sin fin
   * y al reconectar entregaba el atraso completo (35k+ por minuto en logs de
   * producción). Ese descifrado congelaba el event loop ~2 min, la API dejaba
   * de responder y WhatsApp cortaba por timeout (408), repitiendo el ciclo.
   *
   * Aquí se intercepta el evento de mensaje ANTES de Baileys: los de terceros
   * solo se confirman (ack, sin descifrar) para que WhatsApp los dé por
   * entregados y no los reenvíe. Los del propio número (el teléfono comparte
   * por ahí claves con el dispositivo vinculado) siguen el flujo normal. Los
   * recibos (`CB:receipt`), incluidos los reintentos de lo que ENVIAMOS, no se
   * tocan.
   */
  private ackIncomingWithoutDecrypt(session: WhatsappSession): void {
    const sock: any = session.sock;
    const ws = sock?.ws;
    if (!ws?.listeners || typeof sock.sendMessageAck !== 'function') {
      this.logger.warn(`[${session.key}] No se pudo instalar el filtro de mensajes entrantes.`);
      return;
    }
    const original: ((node: any) => void)[] = ws.listeners('CB:message');
    ws.removeAllListeners('CB:message');
    this.logger.log(
      `[${session.key}] Filtro de mensajes entrantes activo (se confirman sin descifrar; ${original.length} handler reemplazado).`,
    );
    let acked = 0;
    let timer: NodeJS.Timeout | null = null;
    ws.on('CB:message', (node: any) => {
      // Ningún mensaje entrante se descifra, ni siquiera los de control del
      // propio teléfono (category="peer"): con su sesión Signal dañada, cada
      // uno probaba ~40 sesiones viejas (miles de "Bad MAC") y congelaba el
      // event loop ~16 s. Solo sirven para sincronizar chats/contactos, que
      // este servicio no usa. Los envíos y sus recibos no dependen de ellos.
      acked++;
      if (!timer) {
        timer = setTimeout(() => {
          this.logger.log(`[${session.key}] ${acked} mensajes entrantes confirmados sin descifrar.`);
          acked = 0;
          timer = null;
        }, 15_000);
        timer.unref();
      }
      sock.sendMessageAck(node).catch(() => undefined);
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
    session.stopped = false;
    session.autoRestore = false;
    session.ready = false;
    session.currentQr = null;
    // Relogin vuelve al método por defecto (QR). Si el admin quiere código,
    // usará getPairingCode después.
    session.usePairing = false;
    session.pairingPhone = null;
    session.pairingCode = null;

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
    // Antes de cerrar: evita que el handler de cierre del socket reconecte.
    session.stopped = true;
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

  /** Envía texto. Devuelve true si salió. Ver `sendMessageDetailed` para el motivo. */
  async sendMessage(
    phone: string | number,
    text: string,
    conjunto?: string | null,
  ): Promise<boolean> {
    return (await this.sendMessageDetailed(phone, text, conjunto)).ok;
  }

  async sendMessageDetailed(
    phone: string | number,
    text: string,
    conjunto?: string | null,
  ): Promise<SendResult> {
    return this.deliver(phone, { text }, conjunto);
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
    return (await this.sendImageDetailed(phone, opts, conjunto)).ok;
  }

  async sendImageDetailed(
    phone: string | number,
    opts: { imageUrl?: string; imageBase64?: string; caption?: string },
    conjunto?: string | null,
  ): Promise<SendResult> {
    if (!this.resolveSenderSession(conjunto)) {
      this.logger.warn('WhatsApp no está listo. Imagen no enviada.');
      return { ok: false, reason: 'sin_sesion' };
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
      if (opts.caption) return this.deliver(phone, { text: opts.caption }, conjunto);
      this.logger.warn('No se pudo obtener la imagen a enviar.');
      return { ok: false, reason: 'error', error: 'No se pudo obtener la imagen.' };
    }

    return this.deliver(phone, { image: buffer, caption: opts.caption || undefined }, conjunto);
  }

  /**
   * Envío común: resuelve la sesión, normaliza el número, verifica que tenga
   * WhatsApp (onWhatsApp, con caché) y envía. Antes un número sin WhatsApp se
   * contaba como "enviado".
   */
  private async deliver(
    phone: string | number,
    content: { text: string } | { image: Buffer; caption?: string },
    conjunto?: string | null,
  ): Promise<SendResult> {
    // Nunca enviar un mensaje de texto vacío (llega como burbuja en blanco).
    if ('text' in content && !String(content.text ?? '').trim()) {
      this.logger.warn(`Mensaje vacío para ${phone}: no se envía.`);
      return { ok: false, reason: 'texto_vacio', error: 'El mensaje está vacío.' };
    }
    const session = this.resolveSenderSession(conjunto);
    if (!session) {
      this.logger.warn('WhatsApp no está listo. Mensaje no enviado.');
      return { ok: false, reason: 'sin_sesion' };
    }
    let jid: string;
    try {
      jid = this.toJid(phone);
    } catch (e: any) {
      this.logger.warn(`Número inválido "${phone}": ${e?.message}`);
      return { ok: false, reason: 'numero_invalido', error: e?.message };
    }
    const verificado = await this.checkOnWhatsapp(session, jid);
    if (verificado === null) {
      this.logger.warn(`El número ${phone} no tiene WhatsApp. No se envía.`);
      return { ok: false, reason: 'sin_whatsapp' };
    }
    try {
      const sent = await session.sock!.sendMessage(verificado, content as any);
      const messageId = sent?.key?.id || undefined;
      // Se guarda el mensaje YA (no depende de messages.upsert) para poder
      // reenviarlo si el destinatario lo pide, y se empieza a seguir su entrega.
      // No bloquea: la escritura a RTDB va en un lote en segundo plano.
      if (messageId && sent?.message) {
        this.store.registrarEnvio({
          sesion: session.key,
          conjunto: this.normalizeKey(conjunto),
          to: verificado,
          id: messageId,
          message: sent.message,
          tipo: 'image' in content ? 'imagen' : 'texto',
        });
      }
      this.logger.log(`[${session.key}] ${'image' in content ? 'Imagen' : 'Mensaje'} enviado a ${phone}`);
      return { ok: true, messageId };
    } catch (error: any) {
      this.logger.error(`Error enviando a ${phone}: ${error?.message}`);
      return { ok: false, reason: 'error', error: error?.message };
    }
  }

  /**
   * Reenvía un mensaje con su MISMO id (WhatsApp lo trata como el mismo
   * mensaje: el destinatario no ve duplicados). Solo si la sesión que lo envió
   * está conectada y el mensaje sigue guardado.
   */
  private async reenviar(e: Entrega): Promise<boolean> {
    const session = this.sessions.get(e.sesion);
    if (!session?.ready || !session.sock) return false;
    const msg = await this.store.get(e.sesion, e.id);
    if (!msg) return false;
    try {
      await session.sock.relayMessage(e.to, msg, { messageId: e.id });
      this.store.marcarReintento(e.id);
      this.logger.log(`[${e.sesion}] Reenvío ${e.reintentos}/${this.store.maxReintentos} del mensaje ${e.id}.`);
      return true;
    } catch (err: any) {
      this.logger.warn(`[${e.sesion}] Reenvío de ${e.id} falló: ${err?.message}`);
      return false;
    }
  }

  /** Revisión periódica: reenvía los que no se entregaron y marca los vencidos. */
  private async revisarEntregas(): Promise<void> {
    const pendientes = this.store.revisar();
    for (const e of pendientes) {
      await this.reenviar(e);
      // Pausa corta entre reenvíos (mismo criterio que los envíos masivos).
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  /** Estado de entrega de los mensajes de un día (yyyymmdd), por conjunto. */
  async listarEntregas(fecha: string, conjunto?: string | null) {
    return this.store.listar(fecha, conjunto ? this.normalizeKey(conjunto) : null);
  }

  /** Caché de onWhatsApp: número -> jid verificado (o null si no tiene WhatsApp). */
  private readonly waCheckCache = new Map<string, { jid: string | null; at: number }>();
  private static readonly WA_CHECK_TTL_OK_MS = 24 * 3600_000;
  private static readonly WA_CHECK_TTL_NO_MS = 6 * 3600_000;

  /**
   * Devuelve el jid con el que WhatsApp reconoce el número, o null si el número
   * no tiene WhatsApp. Si la verificación falla (red/protocolo), devuelve el
   * jid original para no bloquear el envío.
   */
  private async checkOnWhatsapp(session: WhatsappSession, jid: string): Promise<string | null> {
    const now = Date.now();
    const hit = this.waCheckCache.get(jid);
    if (hit) {
      const ttl = hit.jid ? WhatsappService.WA_CHECK_TTL_OK_MS : WhatsappService.WA_CHECK_TTL_NO_MS;
      if (now - hit.at < ttl) return hit.jid;
    }
    try {
      const res = await session.sock!.onWhatsApp(jid);
      const r = Array.isArray(res) ? res[0] : undefined;
      if (!r) return jid; // respuesta vacía: no concluyente
      const value = r.exists ? String(r.jid || jid) : null;
      if (this.waCheckCache.size > 5000) this.waCheckCache.clear();
      this.waCheckCache.set(jid, { jid: value, at: now });
      return value;
    } catch (e: any) {
      this.logger.debug(`onWhatsApp falló para ${jid}: ${e?.message}`);
      return jid;
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers (sin cambios de comportamiento)
  // ---------------------------------------------------------------------------

  /**
   * Normaliza un teléfono a JID de WhatsApp.
   *   - "+<cc>..." o "00<cc>...": se respeta el indicativo internacional.
   *   - 10 dígitos sin indicativo: se antepone WHATSAPP_DEFAULT_CC (57 = Colombia).
   *   - Resto: se asume que ya trae indicativo. Fuera de 10..15 dígitos => inválido.
   */
  private toJid(phone: string | number): string {
    const raw = String(phone == null ? '' : phone).trim();
    let digits = raw.replace(/\D/g, '');
    if (!digits) throw new Error('Número de WhatsApp vacío');
    const internacional = raw.startsWith('+') || digits.startsWith('00');
    if (digits.startsWith('00')) digits = digits.slice(2);
    if (!internacional && digits.length === 10) {
      const cc = String(process.env.WHATSAPP_DEFAULT_CC || '57').replace(/\D/g, '') || '57';
      digits = `${cc}${digits}`;
    }
    if (digits.length < 10 || digits.length > 15) {
      throw new Error(`longitud inválida (${digits.length} dígitos)`);
    }
    return `${digits}@s.whatsapp.net`;
  }

  /** Hosts desde los que se aceptan imágenes (comprobantes y noticias en Google Drive). */
  private static readonly IMAGE_HOSTS = [
    'drive.google.com',
    'docs.google.com',
    'drive.usercontent.google.com',
  ];
  private static readonly IMAGE_HOST_SUFFIXES = ['.googleusercontent.com'];
  /** Tope de tamaño de una imagen descargada. */
  private static readonly IMAGE_MAX_BYTES = 10 * 1024 * 1024;

  private isAllowedImageUrl(u: URL): boolean {
    if (u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase();
    return (
      WhatsappService.IMAGE_HOSTS.includes(host) ||
      WhatsappService.IMAGE_HOST_SUFFIXES.some((suf) => host.endsWith(suf))
    );
  }

  /**
   * Descarga una imagen (p. ej. el comprobante en Google Drive) como Buffer, o
   * null si falla.
   *
   * Seguridad: antes descargaba CUALQUIER URL recibida por un endpoint público
   * (SSRF: peticiones a la red interna; y sin tope de tamaño). Ahora:
   *   - Solo https y hosts de Google Drive (lista blanca), también en cada
   *     redirección (se siguen a mano, máx. 5).
   *   - Tope de 10 MB (por Content-Length y mientras se lee el cuerpo).
   *   - Debe ser una imagen (Content-Type image/*).
   */
  private async downloadImage(url: string): Promise<Buffer | null> {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 20000);
    try {
      let current: URL;
      try {
        current = new URL(url);
      } catch {
        this.logger.warn(`URL de imagen inválida: ${url}`);
        return null;
      }
      let res: Response | null = null;
      for (let hop = 0; hop <= 5; hop++) {
        if (!this.isAllowedImageUrl(current)) {
          this.logger.warn(`Imagen rechazada: host no permitido (${current.hostname}).`);
          return null;
        }
        res = await fetch(current, { signal: controller.signal, redirect: 'manual' });
        if (res.status >= 300 && res.status < 400) {
          const loc = res.headers.get('location');
          if (!loc) return null;
          current = new URL(loc, current);
          res = null;
          continue;
        }
        break;
      }
      if (!res) {
        this.logger.warn(`Demasiadas redirecciones descargando la imagen: ${url}`);
        return null;
      }
      if (!res.ok) {
        this.logger.warn(`No se pudo descargar la imagen (${res.status}): ${url}`);
        return null;
      }
      const tipo = String(res.headers.get('content-type') || '').toLowerCase();
      if (tipo && !tipo.startsWith('image/')) {
        this.logger.warn(`El recurso no es una imagen (${tipo}): ${url}`);
        return null;
      }
      const declarado = Number(res.headers.get('content-length') || 0);
      if (declarado > WhatsappService.IMAGE_MAX_BYTES) {
        this.logger.warn(`Imagen demasiado grande (${declarado} bytes): ${url}`);
        return null;
      }
      if (!res.body) return null;
      const chunks: Buffer[] = [];
      let total = 0;
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > WhatsappService.IMAGE_MAX_BYTES) {
          controller.abort();
          this.logger.warn(`Imagen supera ${WhatsappService.IMAGE_MAX_BYTES} bytes: ${url}`);
          return null;
        }
        chunks.push(Buffer.from(value));
      }
      return Buffer.concat(chunks);
    } catch (e: any) {
      this.logger.error(`Error descargando imagen: ${e?.message}`);
      return null;
    } finally {
      clearTimeout(t);
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
