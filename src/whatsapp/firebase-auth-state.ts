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
 * Auth state de Baileys persistido en Firebase Realtime Database, guardando
 * TODO el estado (creds + keys) en UN solo nodo:
 *   mirror/wsp_session/<sessionKey> = { payload: "<JSON BufferJSON>" }
 *
 * Reemplaza el antiguo sheets-auth-state (Google Apps Script / Sheets). Motivos:
 *  - Toda la app ya vive en Firebase RTDB; la sesión de WhatsApp era la última
 *    dependencia del Apps Script y rompía la generación del QR cuando Sheets
 *    fallaba o SCRIPT_URL no estaba disponible.
 *  - RTDB es rápido y transaccional; no hay LockService global que sature como
 *    con Apps Script, así que no se necesita el debounce agresivo (igual se
 *    conserva uno corto para agrupar la ráfaga inicial de pre-keys).
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
const WSP_SESSION_ROOT = 'mirror/wsp_session';

/** Sanea una clave para usarla como nodo de RTDB (no admite . # $ / [ ]). */
function safeNodeKey(raw: string): string {
  return String(raw ?? '').trim().replace(/[.#$/\[\]]/g, '_') || DEFAULT_SESSION_KEY;
}

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
  let creds: AuthenticationCreds;
  const keys: { [category: string]: { [id: string]: any } } = {};

  // --- Carga inicial: una sola lectura del nodo ---
  let loaded: { creds?: any; keys?: any } | null = null;
  try {
    const snap = await ref.get();
    if (snap.exists()) {
      const raw = snap.val()?.payload;
      if (raw && typeof raw === 'string') {
        try {
          loaded = JSON.parse(raw, BufferJSON.reviver);
        } catch (e: any) {
          logger.warn(`No se pudo parsear la sesión '${sessionKey}': ${e?.message}`);
        }
      }
    }
  } catch (e: any) {
    logger.warn(`No se pudo leer la sesión '${sessionKey}' de RTDB: ${e?.message}`);
  }

  creds = loaded?.creds || initAuthCreds();
  if (loaded?.keys && typeof loaded.keys === 'object') {
    Object.assign(keys, loaded.keys);
  }

  // --- Persistencia con serialización + debounce corto ---
  let writing = false;
  let pending = false;
  let debounceTimer: NodeJS.Timeout | null = null;

  const doWrite = async (): Promise<void> => {
    if (writing) {
      pending = true;
      return;
    }
    writing = true;
    try {
      const payload = JSON.stringify({ creds, keys }, BufferJSON.replacer);
      await ref.set({ payload, updatedAt: new Date().toISOString() });
    } catch (e: any) {
      logger.error(`Error guardando la sesión '${sessionKey}': ${e?.message}`);
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
    // Agrupa la ráfaga de cambios (p. ej. las pre-keys iniciales) en una escritura.
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
    for (const k of Object.keys(keys)) delete keys[k];
    await ref.remove().catch(() => undefined);
  };

  return {
    state: {
      creds,
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
              if (value) {
                keys[category][id] = value;
              } else {
                delete keys[category][id];
              }
            }
          }
          scheduleWrite();
        },
      },
    },
    saveCreds: async () => {
      scheduleWrite();
    },
    clear,
    flush,
  };
}
