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
  ActivityScanQuery,
  ActivitySummary,
  ModuleUsage,
  OpeningsSummary,
  ErrorContext,
  ErrorIssue,
  ErrorIssueQuery,
  ErrorIssueResult,
  RequestContext,
  SessionSummary,
} from './core/types';
export type {
  ActivityStore,
  SessionStore,
  ErrorReporter,
  ErrorIssueSource,
  Clock,
  AuditLogger,
} from './core/ports';
export { systemClock, consoleAuditLogger } from './core/ports';
export { ActivityLogger } from './core/activity-logger';
export { SessionTracker } from './core/session-tracker';
export { summarizeActivity, summarizeOpenings } from './core/activity-summary';
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
export { NoopErrorReporter } from './adapters/memory/noop-error-reporter';

// --- Adapter Sentry (requiere @sentry/nestjs como peerDependency) ---
export { SentryErrorReporter } from './adapters/sentry/sentry-error-reporter';
export { SentryIssuesClient, type SentryIssuesConfig } from './adapters/sentry/sentry-issues.client';

// --- Integración NestJS (opcional) ---
export { ActivityAuditModule, type ActivityAuditOptions } from './integrations/nest/activity-audit.module';
export { AuditInterceptor } from './integrations/nest/audit.interceptor';
export { AuditController } from './integrations/nest/audit.controller';
export { ACTIVITY_LOGGER, SESSION_TRACKER, ERROR_ISSUE_SOURCE } from './integrations/nest/activity-audit.tokens';
export { SuperAdminGuard } from './integrations/nest/super-admin.guard';
