import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  cert,
  applicationDefault,
  getApps,
  getApp,
  initializeApp,
  type App,
  type Credential,
  type ServiceAccount,
} from 'firebase-admin/app';
import { getDatabase, type Database, type DataSnapshot } from 'firebase-admin/database';
import { getAuth, type Auth } from 'firebase-admin/auth';

/**
 * Inicializa firebase-admin y expone el Realtime Database del backend.
 *
 * Credenciales (NUNCA en el repo): se leen de variables de entorno. Soporta,
 * en orden de preferencia:
 *   1. FIREBASE_SERVICE_ACCOUNT      -> JSON completo de la service account (string)
 *   2. FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY
 *   3. GOOGLE_APPLICATION_CREDENTIALS -> ruta a archivo (admin lo toma solo)
 *
 * Requiere además:
 *   FIREBASE_DATABASE_URL -> URL del Realtime Database del proyecto (QA o PRD).
 *
 * En QA/PRD basta con configurar estas env en el servicio de Render
 * correspondiente; el mismo código apunta al proyecto que le indiquen.
 */
/** Estado de un path observado en vivo (ver FirebaseService.liveVal). */
interface LiveEntry {
  snap: DataSnapshot | null;
  val: any;
  valReady: boolean;
  values: any[] | null;
  ready: Promise<void>;
}

@Injectable()
export class FirebaseService implements OnModuleInit {
  private readonly logger = new Logger(FirebaseService.name);
  private app: App | null = null;
  private enabled = false;

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    if (getApps().length) {
      this.app = getApp();
      this.enabled = true;
      return;
    }

    const databaseURL = this.config.get<string>('FIREBASE_DATABASE_URL', '');
    if (!databaseURL) {
      this.logger.warn(
        'FIREBASE_DATABASE_URL no configurada: la sincronización a RTDB queda deshabilitada.',
      );
      return;
    }

    try {
      const credential = this.resolveCredential();
      if (!credential) {
        this.logger.warn(
          'Sin credenciales de Firebase: la sincronización a RTDB queda deshabilitada.',
        );
        return;
      }

      this.app = initializeApp({ credential, databaseURL });
      this.enabled = true;
      this.logger.log(`Firebase Admin inicializado (RTDB: ${databaseURL}).`);
    } catch (err: any) {
      this.logger.error(`No se pudo inicializar Firebase Admin: ${err?.message || err}`);
    }
  }

  /** Resuelve la credencial desde las distintas fuentes soportadas. */
  private resolveCredential(): Credential | null {
    // 1. JSON completo de la service account en una sola env var.
    const saJson = this.config.get<string>('FIREBASE_SERVICE_ACCOUNT', '');
    if (saJson) {
      try {
        const parsed = JSON.parse(saJson);
        if (parsed.private_key) {
          parsed.private_key = String(parsed.private_key).replace(/\\n/g, '\n');
        }
        return cert(parsed as ServiceAccount);
      } catch (e: any) {
        this.logger.error(`FIREBASE_SERVICE_ACCOUNT no es un JSON válido: ${e?.message}`);
      }
    }

    // 2. Campos sueltos.
    const projectId = this.config.get<string>('FIREBASE_PROJECT_ID', '');
    const clientEmail = this.config.get<string>('FIREBASE_CLIENT_EMAIL', '');
    let privateKey = this.config.get<string>('FIREBASE_PRIVATE_KEY', '');
    if (projectId && clientEmail && privateKey) {
      // Las env suelen escapar los saltos de línea de la private key.
      privateKey = privateKey.replace(/\\n/g, '\n');
      return cert({ projectId, clientEmail, privateKey });
    }

    // 3. GOOGLE_APPLICATION_CREDENTIALS (ruta a archivo) -> applicationDefault.
    if (this.config.get<string>('GOOGLE_APPLICATION_CREDENTIALS', '')) {
      return applicationDefault();
    }

    return null;
  }

  /** Indica si Firebase quedó inicializado y utilizable. */
  isEnabled(): boolean {
    return this.enabled && this.app != null;
  }

  /** Referencia al Realtime Database. Lanza si Firebase no está inicializado. */
  db(): Database {
    if (!this.app) {
      throw new Error('Firebase Admin no inicializado (revisa las env de Firebase).');
    }
    return getDatabase(this.app);
  }

  // -------------------- Lecturas "vivas" (caché en memoria) --------------------

  /**
   * Estado de cada path observado en vivo. `snap` es el último snapshot que
   * empujó RTDB; `val` se materializa perezosamente (una vez por versión) para
   * no pagar el costo de `snap.val()` en cada cambio del árbol.
   */
  private readonly live = new Map<string, LiveEntry>();

  /** Tope de espera para el primer snapshot antes de caer a un `.get()` normal. */
  private static readonly LIVE_FIRST_LOAD_MS = 15_000;

  /**
   * Valor actual de `path`, servido desde memoria.
   *
   * La primera llamada abre un listener `on('value')` permanente: RTDB descarga
   * el árbol UNA vez y después solo envía los cambios (deltas). Todas las
   * peticiones concurrentes comparten esa misma carga, así que N usuarios
   * abriendo la app no generan N descargas del árbol completo. Las escrituras
   * hechas por este backend (o por cualquier otro cliente) se reflejan de
   * inmediato, por lo que no hace falta invalidar nada a mano.
   *
   * IMPORTANTE: el objeto devuelto es COMPARTIDO entre peticiones; tratarlo como
   * solo lectura (copiar antes de mutar).
   *
   * Usar solo para colecciones que se leen completas con frecuencia (pagos,
   * usuarios, conjuntos): el árbol queda residente en memoria.
   */
  async liveVal<T = any>(path: string): Promise<T | null> {
    const entry = await this.liveEntry(path);
    if (!entry) {
      // Listener no disponible: lectura normal.
      const snap = await this.db().ref(path).get();
      return snap.exists() ? (snap.val() as T) : null;
    }
    if (!entry.valReady) {
      entry.val = entry.snap && entry.snap.exists() ? entry.snap.val() : null;
      entry.valReady = true;
    }
    return entry.val as T | null;
  }

  /**
   * Como `liveVal` pero devuelve `Object.values(...)` del nodo. El array se
   * memoiza por versión y se entrega como copia (el caller puede ordenarlo o
   * filtrarlo sin afectar a otros); los elementos siguen siendo compartidos.
   */
  async liveValues<T = any>(path: string): Promise<T[]> {
    const entry = await this.liveEntry(path);
    if (!entry) {
      const snap = await this.db().ref(path).get();
      return snap.exists() ? (Object.values(snap.val() || {}) as T[]) : [];
    }
    if (!entry.values) {
      const val = await this.liveVal<Record<string, T>>(path);
      entry.values = val ? Object.values(val) : [];
    }
    return entry.values.slice() as T[];
  }

  /** Abre (una sola vez) el listener del path y espera su primer snapshot. */
  private async liveEntry(path: string): Promise<LiveEntry | null> {
    let entry = this.live.get(path);
    if (!entry) {
      const ref = this.db().ref(path);
      let resolveReady!: () => void;
      let rejectReady!: (e: unknown) => void;
      const ready = new Promise<void>((res, rej) => {
        resolveReady = res;
        rejectReady = rej;
      });
      // Evita un unhandledRejection si el listener se cancela sin nadie esperando.
      ready.catch(() => undefined);
      const created: LiveEntry = { snap: null, val: null, valReady: false, values: null, ready };
      entry = created;
      this.live.set(path, created);

      ref.on(
        'value',
        (snap) => {
          created.snap = snap;
          created.valReady = false;
          created.values = null;
          resolveReady();
        },
        (err: any) => {
          // Listener cancelado (p. ej. reglas). Se descarta para reintentar luego.
          this.logger.error(`Listener en vivo de "${path}" cancelado: ${err?.message || err}`);
          this.live.delete(path);
          rejectReady(err);
        },
      );
      this.logger.log(`Listener en vivo abierto para "${path}".`);
    }

    if (entry.snap) return entry;

    // Aún no llegó el primer snapshot: esperarlo con tope.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        entry.ready,
        new Promise<void>((_, rej) => {
          timer = setTimeout(
            () => rej(new Error('timeout')),
            FirebaseService.LIVE_FIRST_LOAD_MS,
          );
        }),
      ]);
      return entry.snap ? entry : null;
    } catch (e: any) {
      this.logger.warn(`Primer snapshot de "${path}" no disponible (${e?.message}); se usa get().`);
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Referencia a Firebase Auth. Lanza si Firebase no está inicializado. */
  auth(): Auth {
    if (!this.app) {
      throw new Error('Firebase Admin no inicializado (revisa las env de Firebase).');
    }
    return getAuth(this.app);
  }

  /**
   * Devuelve las credenciales de la service account (project_id, client_email,
   * private_key) para reutilizarlas con otras APIs de Google (p. ej. Drive).
   * Lee de FIREBASE_SERVICE_ACCOUNT (JSON) o de los campos sueltos. Devuelve
   * null si no hay credenciales por variable de entorno.
   */
  getServiceAccount(): { projectId: string; clientEmail: string; privateKey: string } | null {
    const saJson = this.config.get<string>('FIREBASE_SERVICE_ACCOUNT', '');
    if (saJson) {
      try {
        const parsed = JSON.parse(saJson);
        return {
          projectId: parsed.project_id || '',
          clientEmail: parsed.client_email || '',
          privateKey: String(parsed.private_key || '').replace(/\\n/g, '\n'),
        };
      } catch {
        // cae a los campos sueltos
      }
    }
    const projectId = this.config.get<string>('FIREBASE_PROJECT_ID', '');
    const clientEmail = this.config.get<string>('FIREBASE_CLIENT_EMAIL', '');
    const privateKey = this.config.get<string>('FIREBASE_PRIVATE_KEY', '').replace(/\\n/g, '\n');
    if (projectId && clientEmail && privateKey) {
      return { projectId, clientEmail, privateKey };
    }
    return null;
  }
}
