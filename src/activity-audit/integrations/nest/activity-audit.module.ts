// ==========================================
// activity-audit · integración NestJS · DynamicModule
// ==========================================

import { DynamicModule, Logger, Module } from '@nestjs/common';
import { ActivityLogger } from '../../core/activity-logger';
import { SessionTracker } from '../../core/session-tracker';
import { systemClock, type AuditLogger } from '../../core/ports';
import { NoopActivityStore, NoopSessionStore } from '../../adapters/memory/noop.store';
import {
  resolveAuditApp,
  auditDatabase,
  type AuditFirebaseCredentials,
} from '../../adapters/rtdb/audit-firebase.provider';
import { RtdbActivityStore } from '../../adapters/rtdb/rtdb-activity.store';
import { RtdbSessionStore } from '../../adapters/rtdb/rtdb-session.store';
import { ACTIVITY_LOGGER, SESSION_TRACKER } from './activity-audit.tokens';
import { AuditController } from './audit.controller';

export interface ActivityAuditOptions {
  /** Credenciales del proyecto Firebase SEPARADO (RTDB) para la auditoría. */
  credentials: AuditFirebaseCredentials;
  /** Rutas RTDB (opcional). */
  paths?: { activity?: string; sessions?: string };
}

/**
 * Módulo de auditoría y analítica de sesiones. Se registra con `forRoot(...)`
 * pasándole las credenciales del proyecto aislado. Si faltan o fallan, el
 * módulo arranca en modo DESHABILITADO (stores no-op): la app nunca cae.
 */
@Module({})
export class ActivityAuditModule {
  static forRoot(options: ActivityAuditOptions): DynamicModule {
    const logger = new Logger('ActivityAudit');
    const auditLogger: AuditLogger = {
      warn: (m) => logger.warn(m),
      error: (m) => logger.error(m),
    };

    // Resolver los stores UNA vez (compartidos por logger y tracker).
    const { activityStore, sessionStore, enabled } = buildStores(options, auditLogger);
    if (enabled) {
      logger.log('Auditoría de actividad habilitada (proyecto Firebase aislado).');
    } else {
      logger.warn('Auditoría deshabilitada: sin credenciales válidas. Usando stores no-op.');
    }

    return {
      module: ActivityAuditModule,
      global: true,
      controllers: [AuditController],
      providers: [
        {
          provide: ACTIVITY_LOGGER,
          useValue: new ActivityLogger({ store: activityStore, clock: systemClock, logger: auditLogger }),
        },
        {
          provide: SESSION_TRACKER,
          useValue: new SessionTracker({ store: sessionStore, clock: systemClock, logger: auditLogger }),
        },
      ],
      exports: [ACTIVITY_LOGGER, SESSION_TRACKER],
    };
  }
}

/** Construye los stores reales (RTDB) o cae a no-op si no hay credenciales. */
function buildStores(options: ActivityAuditOptions, logger: AuditLogger) {
  try {
    const app = resolveAuditApp(options.credentials);
    const db = auditDatabase(app);
    return {
      enabled: true,
      activityStore: new RtdbActivityStore(db, options.paths?.activity),
      sessionStore: new RtdbSessionStore(db, options.paths?.sessions),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`[activity-audit] inicialización fallida (${msg}). Modo no-op.`);
    return {
      enabled: false,
      activityStore: new NoopActivityStore(),
      sessionStore: new NoopSessionStore(),
    };
  }
}
