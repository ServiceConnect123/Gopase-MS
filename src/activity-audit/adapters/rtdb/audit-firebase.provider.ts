// ==========================================
// activity-audit · adapter RTDB · provider Firebase aislado
// ==========================================
// Inicializa una App de firebase-admin NOMBRADA ("activity-audit"), separada de
// la App por defecto de la app host, apuntando a un PROYECTO Firebase distinto
// (aislamiento total de la BD transaccional principal).

import {
  initializeApp,
  getApps,
  cert,
  applicationDefault,
  type App,
  type AppOptions,
} from 'firebase-admin/app';
import { getDatabase, type Database } from 'firebase-admin/database';

/** Nombre de la App aislada. No colisiona con la App por defecto del host. */
export const AUDIT_APP_NAME = 'activity-audit';

/** Credenciales del PROYECTO de auditoría (separado del transaccional). */
export interface AuditFirebaseCredentials {
  /** JSON completo de la service account (string). Preferido. */
  serviceAccountJson?: string;
  /** O campos sueltos. */
  projectId?: string;
  clientEmail?: string;
  privateKey?: string;
  /** URL del Realtime Database del proyecto de auditoría. Requerida para RTDB. */
  databaseURL?: string;
  /** Usar GOOGLE_APPLICATION_CREDENTIALS (ADC). */
  useApplicationDefault?: boolean;
}

/**
 * Crea/recupera la App aislada de auditoría (idempotente). Lanza si faltan
 * credenciales o databaseURL (quien la invoca debe manejar el fallo como
 * "auditoría deshabilitada", nunca romper la app).
 */
export function resolveAuditApp(cfg: AuditFirebaseCredentials): App {
  const existing = getApps().find((a) => a.name === AUDIT_APP_NAME);
  if (existing) return existing;

  if (!cfg.databaseURL) {
    throw new Error('[activity-audit] AUDIT_FIREBASE_DATABASE_URL no configurada.');
  }

  const options: AppOptions = { databaseURL: cfg.databaseURL };

  if (cfg.useApplicationDefault) {
    options.credential = applicationDefault();
  } else if (cfg.serviceAccountJson) {
    const parsed = JSON.parse(cfg.serviceAccountJson);
    if (parsed.private_key) {
      parsed.private_key = String(parsed.private_key).replace(/\\n/g, '\n');
    }
    options.credential = cert(parsed);
  } else if (cfg.projectId && cfg.clientEmail && cfg.privateKey) {
    options.credential = cert({
      projectId: cfg.projectId,
      clientEmail: cfg.clientEmail,
      privateKey: cfg.privateKey.replace(/\\n/g, '\n'),
    });
  } else {
    throw new Error('[activity-audit] faltan credenciales de Firebase para auditoría.');
  }

  // App NOMBRADA => aislada de la App por defecto del host.
  return initializeApp(options, AUDIT_APP_NAME);
}

/** Database RTDB del proyecto de auditoría (de la App nombrada aislada). */
export function auditDatabase(app: App): Database {
  // Pasar la App explícita: getDatabase(app) usa SU databaseURL, no la App por
  // defecto (evita "The default Firebase app does not exist").
  return getDatabase(app);
}

/**
 * Devuelve una función que resuelve la `Database` de auditoría de forma
 * PEREZOSA y memoizada: la App Firebase se inicializa en el PRIMER uso real
 * (primera escritura), no durante el bootstrap de Nest. Si la inicialización
 * falla, lanza al invocarse; el llamador (fail-safe) absorbe el error.
 */
export function createLazyAuditDatabase(cfg: AuditFirebaseCredentials): () => Database {
  let cached: Database | null = null;
  return () => {
    if (cached) return cached;
    const app = resolveAuditApp(cfg);
    cached = getDatabase(app);
    return cached;
  };
}
