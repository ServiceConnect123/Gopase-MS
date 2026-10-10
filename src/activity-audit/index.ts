// ==========================================
// activity-audit · API pública (barrel)
// ==========================================
// Punto único de importación. Al extraer a un paquete NPM, este archivo pasa a
// ser el `main`/`exports` de la librería.

// --- Core (sin dependencias de framework/Firebase) ---
export type {
  ActivityLog,
  ActivityInput,
  ActivityMeta,
  SessionSummary,
} from './core/types';
export type {
  ActivityStore,
  SessionStore,
  Clock,
  AuditLogger,
} from './core/ports';
export { systemClock, consoleAuditLogger } from './core/ports';
export { ActivityLogger } from './core/activity-logger';
export { SessionTracker } from './core/session-tracker';
export { fireAndForget, runSafe } from './core/fail-safe';

// --- Adapters RTDB ---
export {
  resolveAuditApp,
  auditDatabase,
  createLazyAuditDatabase,
  AUDIT_APP_NAME,
  type AuditFirebaseCredentials,
} from './adapters/rtdb/audit-firebase.provider';
export { RtdbActivityStore } from './adapters/rtdb/rtdb-activity.store';
export { RtdbSessionStore } from './adapters/rtdb/rtdb-session.store';

// --- Adapters no-op (modo deshabilitado / tests) ---
export { NoopActivityStore, NoopSessionStore } from './adapters/memory/noop.store';

// --- Integración NestJS (opcional) ---
export { ActivityAuditModule, type ActivityAuditOptions } from './integrations/nest/activity-audit.module';
export { AuditInterceptor } from './integrations/nest/audit.interceptor';
export { AuditController } from './integrations/nest/audit.controller';
export { ACTIVITY_LOGGER, SESSION_TRACKER } from './integrations/nest/activity-audit.tokens';
