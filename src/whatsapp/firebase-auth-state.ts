import { Logger } from '@nestjs/common';
import {
  AuthenticationCreds,
  AuthenticationState,
  initAuthCreds,
  BufferJSON,
  proto,
  SignalDataTypeMap,
} from '@whiskeysockets/baileys';
import { FirebaseService } from '../firebase/firebase.service';

const logger = new Logger('FirebaseAuthState');

/**
 * Auth state de Baileys persistido en Firebase Realtime Database.
 *
 * Formato v2 (actual), una entrada por clave:
 *   mirror/wsp_session/<node> = {
 *     v: 2,
 *     creds: "<JSON BufferJSON>",
 *     keys: { <categoria>: { <idCodificado>: "<JSON BufferJSON>" } },
 *     updatedAt: "<ISO>"
 *   }
 *
 * Antes (v1) todo el estado iba en un solo string `payload`, y CADA cambio de
 * una clave (pre-keys, sesiones, reintentos por "Bad MAC") volvía a serializar
 * y subir el estado completo — varios MB en sesiones con historial de grupos —
 * cada ~800 ms. Ese JSON.stringify síncrono bloqueaba el event loop y la API
 * dejaba de responder. Ahora solo se suben las claves que cambiaron
 * (`ref.update` con rutas parciales). Las sesiones v1 se migran solas al cargar.
 *
 * La sesión sobrevive a reinicios/redeploys en hosting efímero (Render) sin
 * reescanear el QR.
 */
export interface FirebaseAuthStateResult {
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
  /** Borra la sesión del RTDB (para forzar nuevo QR). */
  clear: () => Promise<void>;
  /** Fuerza el guardado pendiente inmediatamente (flush del debounce). */
  flush: () => Promise<void>;
}

const DEFAULT_SESSION_KEY = 'session';
/** Nodo raíz donde se guardan las sesiones de WhatsApp. */
export const WSP_SESSION_ROOT = 'mirror/wsp_session';
const FORMAT_VERSION = 2;
/** Entradas por escritura al migrar desde v1 (acota el pico de memoria). */
const MIGRATION_CHUNK = 300;
/**
 * Categorías que no se cargan ni se migran: solo sirven para grupos, y el
 * servicio ignora grupos (shouldIgnoreJid). En sesiones viejas eran la mayor
 * parte del peso. Si alguna llegara a necesitarse, Signal la renegocia.
 */
const DROPPED_CATEGORIES = new Set(['sender-key', 'sender-key-memory']);

/** Sanea una clave para usarla como nodo de RTDB (no admite . # $ / [ ]). */
export function safeNodeKey(raw: string): string {
  return String(raw ?? '').trim().replace(/[.#$/\[\]]/g, '_') || DEFAULT_SESSION_KEY;
}

/** Codifica un id de clave de Signal como nombre de nodo RTDB (reversible). */
function encodeId(id: string): string {
  return encodeURIComponent(id).replace(/\./g, '%2E');
}

function decodeId(enc: string): string {
  try {
    return decodeURIComponent(enc);
  } catch {
    return enc;
  }
}

const serialize = (value: unknown): string => JSON.stringify(value, BufferJSON.replacer);
const deserialize = (raw: string): any => JSON.parse(raw, BufferJSON.reviver);

/**
 * Elimina el nodo de sesión (para relogin/unlink).
 *
 * `sessionKey` identifica la sesión (p. ej. 'session' o 'session:villa mayra').
 */
export async function clearFirebaseSession(
  firebase: FirebaseService,
  sessionKey: string = DEFAULT_SESSION_KEY,
): Promise<number> {
  if (!firebase.isEnabled()) {
    logger.warn('Firebase no disponible: no se pudo limpiar la sesión.');
    return 0;
  }
  const node = safeNodeKey(sessionKey);
  try {
    await firebase.db().ref(`${WSP_SESSION_ROOT}/${node}`).remove();
    logger.log(`Sesión '${sessionKey}' eliminada de RTDB.`);
    return 1;
  } catch (e: any) {
    logger.warn(`No se pudo eliminar la sesión '${sessionKey}': ${e?.message}`);
    return 0;
  }
}

export async function useFirebaseAuthState(
  firebase: FirebaseService,
  sessionKey: string = DEFAULT_SESSION_KEY,
): Promise<FirebaseAuthStateResult> {
  if (!firebase.isEnabled()) {
    throw new Error('Firebase no está inicializado: no se puede cargar la sesión de WhatsApp.');
  }

  const node = safeNodeKey(sessionKey);
  const ref = firebase.db().ref(`${WSP_SESSION_ROOT}/${node}`);

  // Estado completo en memoria.
  let creds: AuthenticationCreds | undefined;
  const keys: { [category: string]: { [id: string]: any } } = {};
  let needsMigration = false;

  // --- Carga inicial: una sola lectura del nodo ---
  try {
    const snap = await ref.get();
    const val = snap.exists() ? snap.val() : null;
    if (val?.v === FORMAT_VERSION) {
      if (typeof val.creds === 'string') {
        try {
          creds = deserialize(val.creds);
        } catch (e: any) {
          logger.warn(`Creds corruptas en la sesión '${sessionKey}': ${e?.message}`);
        }
      }
      for (const [category, entries] of Object.entries<any>(val.keys || {})) {
        if (DROPPED_CATEGORIES.has(category)) {
          // Restos de grupos de una migración anterior: se borran de RTDB para
          // no volver a descargarlos en cada arranque.
          ref.child(`keys/${category}`).remove().catch(() => undefined);
          continue;
        }
        const cat: { [id: string]: any } = (keys[category] = {});
        for (const [encId, raw] of Object.entries<any>(entries || {})) {
          if (typeof raw !== 'string') continue;
          try {
            cat[decodeId(encId)] = deserialize(raw);
          } catch {
            // Clave corrupta: se descarta (Signal la renegocia).
          }
        }
      }
    } else if (typeof val?.payload === 'string') {
      // Formato v1: un solo string con todo. Se migra a v2 abajo.
      try {
        const loaded = deserialize(val.payload);
        creds = loaded?.creds;
        if (loaded?.keys && typeof loaded.keys === 'object') {
          for (const [category, entries] of Object.entries<any>(loaded.keys)) {
            if (!DROPPED_CATEGORIES.has(category)) keys[category] = entries;
          }
        }
        needsMigration = true;
      } catch (e: any) {
        logger.warn(`No se pudo parsear la sesión v1 '${sessionKey}': ${e?.message}`);
      }
    }
  } catch (e: any) {
    logger.warn(`No se pudo leer la sesión '${sessionKey}' de RTDB: ${e?.message}`);
  }

  const resolvedCreds: AuthenticationCreds = creds || initAuthCreds();

  if (needsMigration) {
    await migrateV1(ref, sessionKey, resolvedCreds, keys);
  }

  // --- Persistencia incremental: solo lo que cambió ---
  /** Rutas relativas pendientes de subir (valor serializado o null = borrar). */
  let dirty: Record<string, string | null> = {};
  let credsDirty = false;
  let writing = false;
  let pending = false;
  let debounceTimer: NodeJS.Timeout | null = null;

  const doWrite = async (): Promise<void> => {
    if (writing) {
      pending = true;
      return;
    }
    if (!credsDirty && Object.keys(dirty).length === 0) return;
    writing = true;
    const batch = dirty;
    dirty = {};
    const updates: Record<string, string | number | null> = { ...batch };
    const includesCreds = credsDirty;
    if (includesCreds) {
      credsDirty = false;
      updates.creds = serialize(resolvedCreds);
    }
    updates.v = FORMAT_VERSION;
    updates.updatedAt = new Date().toISOString();
    try {
      await ref.update(updates);
    } catch (e: any) {
      logger.error(`Error guardando la sesión '${sessionKey}': ${e?.message}`);
      // Reencolar lo que no se pudo subir (sin pisar cambios más nuevos).
      dirty = { ...batch, ...dirty };
      if (includesCreds) credsDirty = true;
    } finally {
      writing = false;
      if (pending) {
        pending = false;
        await doWrite();
      }
    }
  };

  const scheduleWrite = (): void => {
    if (debounceTimer) clearTimeout(debounceTimer);
    // Agrupa ráfagas de cambios (p. ej. las pre-keys iniciales) en una escritura.
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      doWrite().catch((e) => logger.error(e));
    }, 800);
  };

  const flush = async (): Promise<void> => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    await doWrite();
  };

  const clear = async (): Promise<void> => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    dirty = {};
    credsDirty = false;
    for (const k of Object.keys(keys)) delete keys[k];
    await ref.remove().catch(() => undefined);
  };

  return {
    state: {
      creds: resolvedCreds,
      keys: {
        get: (type, ids) => {
          const data: { [id: string]: SignalDataTypeMap[typeof type] } = {};
          const cat = keys[type] || {};
          for (const id of ids) {
            let value = cat[id];
            if (type === 'app-state-sync-key' && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }
            data[id] = value;
          }
          return data;
        },
        set: (data) => {
          for (const category in data) {
            if (!keys[category]) keys[category] = {};
            for (const id in data[category]) {
              const value = data[category][id];
              const path = `keys/${category}/${encodeId(id)}`;
              if (value) {
                keys[category][id] = value;
                dirty[path] = serialize(value);
              } else {
                delete keys[category][id];
                dirty[path] = null;
              }
            }
          }
          scheduleWrite();
        },
      },
    },
    // Las credenciales cambian pocas veces (vinculación inicial, rotaciones) y
    // son CRÍTICAS para la persistencia: si el proceso muere (p. ej. Render
    // reciclando el contenedor) antes de volcar el debounce, se perdería el
    // vínculo recién hecho. Por eso se escriben de inmediato (flush).
    saveCreds: async () => {
      credsDirty = true;
      await flush();
    },
    clear,
    flush,
  };
}

/**
 * Migra una sesión v1 (`payload` único) a v2 POR PARTES: sube las claves en
 * lotes de MIGRATION_CHUNK y cede el event loop entre lotes, para no armar el
 * árbol completo en memoria ni congelar la API. El `payload` v1 se borra y se
 * marca `v: 2` en la ÚLTIMA escritura: si el proceso muere a mitad, el próximo
 * arranque vuelve a leer el v1 intacto y repite la migración (idempotente).
 */
async function migrateV1(
  ref: ReturnType<ReturnType<FirebaseService['db']>['ref']>,
  sessionKey: string,
  creds: AuthenticationCreds,
  keys: { [category: string]: { [id: string]: any } },
): Promise<void> {
  const started = Date.now();
  const counts: string[] = [];
  let batch: Record<string, string> = {};
  let inBatch = 0;
  let total = 0;
  const flushBatch = async () => {
    if (!inBatch) return;
    await ref.update(batch);
    batch = {};
    inBatch = 0;
    await new Promise((r) => setImmediate(r));
  };
  try {
    for (const [category, entries] of Object.entries(keys)) {
      let n = 0;
      for (const [id, value] of Object.entries(entries || {})) {
        if (!value) continue;
        batch[`keys/${category}/${encodeId(id)}`] = serialize(value);
        inBatch++;
        n++;
        if (inBatch >= MIGRATION_CHUNK) await flushBatch();
      }
      counts.push(`${category}=${n}`);
      total += n;
    }
    await flushBatch();
    await ref.update({
      v: FORMAT_VERSION,
      creds: serialize(creds),
      payload: null,
      updatedAt: new Date().toISOString(),
    });
    logger.log(
      `Sesión '${sessionKey}' migrada al formato por claves (v2): ${total} claves ` +
        `(${counts.join(', ') || 'ninguna'}) en ${Date.now() - started} ms.`,
    );
  } catch (e: any) {
    logger.error(
      `No se pudo migrar la sesión '${sessionKey}' a v2 (se reintenta en el próximo arranque): ${e?.message}`,
    );
  }
}
