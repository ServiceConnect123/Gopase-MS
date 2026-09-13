import { Logger } from '@nestjs/common';
import {
  AuthenticationCreds,
  AuthenticationState,
  initAuthCreds,
  BufferJSON,
  proto,
  SignalDataTypeMap,
} from '@whiskeysockets/baileys';
import { SheetsService } from '../sheets/sheets.service';

const logger = new Logger('SheetsAuthState');

/**
 * Auth state de Baileys persistido en Google Sheets, guardando TODO el estado
 * (creds + keys) en UNA sola fila:
 *   dato_1 = "session"   (clave fija)
 *   dato_2 = JSON con { creds, keys } serializado con BufferJSON
 *
 * Por qué una sola fila y no una por clave:
 *  - Baileys genera decenas de pre-keys de golpe al conectar. Una fila por
 *    clave implicaría decenas de escrituras concurrentes, y el Apps Script usa
 *    un LockService global -> "Lock timeout". Con una sola fila + debounce, una
 *    ráfaga de cambios se persiste en UNA sola llamada HTTP.
 *  - La hoja no crece sin control.
 *
 * Así la sesión sobrevive a reinicios/redeploys en hosting efímero (Render)
 * sin reescanear el QR, y sin saturar el Apps Script.
 */
export interface SheetsAuthState {
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
  /** Borra la sesión de la hoja (para forzar nuevo QR). */
  clear: () => Promise<void>;
  /** Fuerza el guardado pendiente inmediatamente (flush del debounce). */
  flush: () => Promise<void>;
}

const SESSION_KEY = 'session';

/** Elimina la fila de sesión (para relogin). */
export async function clearSheetsSession(
  sheets: SheetsService,
  sheetName: string,
): Promise<number> {
  const ok = await sheets.delete(sheetName, SESSION_KEY);
  logger.log(`Sesión ${ok ? 'eliminada' : 'no encontrada'} en '${sheetName}'`);
  return ok ? 1 : 0;
}

export async function useSheetsAuthState(
  sheets: SheetsService,
  sheetName: string,
): Promise<SheetsAuthState> {
  // Estado completo en memoria.
  let creds: AuthenticationCreds;
  const keys: { [category: string]: { [id: string]: any } } = {};
  // Si la fila ya existe en la hoja (para decidir create vs update).
  let sessionRowExists = false;

  // --- Carga inicial: una sola lectura de la hoja ---
  const rows = await sheets.read(sheetName);
  let loaded: { creds?: any; keys?: any } | null = null;
  for (const row of rows) {
    const key = (row.dato_1 == null ? '' : row.dato_1.toString()).trim();
    if (key !== SESSION_KEY) continue;
    sessionRowExists = true;
    const raw = row.dato_2 == null ? '' : row.dato_2.toString();
    if (raw) {
      try {
        loaded = JSON.parse(raw, BufferJSON.reviver);
      } catch (e: any) {
        logger.warn(`No se pudo parsear la sesión: ${e?.message}`);
      }
    }
    break;
  }

  creds = loaded?.creds || initAuthCreds();
  if (loaded?.keys && typeof loaded.keys === 'object') {
    Object.assign(keys, loaded.keys);
  }

  // --- Persistencia con serialización + debounce ---
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
      let ok: boolean;
      if (sessionRowExists) {
        ok = await sheets.update(sheetName, SESSION_KEY, [SESSION_KEY, payload]);
        if (!ok) {
          ok = await sheets.create(sheetName, [SESSION_KEY, payload]);
        }
      } else {
        ok = await sheets.create(sheetName, [SESSION_KEY, payload]);
      }
      if (ok) sessionRowExists = true;
      else logger.warn('No se pudo persistir la sesión (se reintentará).');
    } catch (e: any) {
      logger.error(`Error guardando la sesión: ${e?.message}`);
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
    }, 1500);
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
    sessionRowExists = false;
    await sheets.delete(sheetName, SESSION_KEY).catch(() => undefined);
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
          // Una sola escritura (debounced) para toda la ráfaga.
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
