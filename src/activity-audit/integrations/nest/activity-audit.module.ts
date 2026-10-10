// ==========================================
// activity-audit · integración NestJS · DynamicModule
// ==========================================

import { DynamicModule, Logger, Module } from '@nestjs/common';
import { ActivityLogger } from '../../core/activity-logger';
import { SessionTracker } from '../../core/session-tracker';
import { systemClock, type AuditLogger } from '../../core/ports';
import { NoopActivityStore, NoopSessionStore } from '../../adapters/memory/noop.store';
import {
  createLazyAuditDatabase,
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
  /**
   * Entorno de ejecución del backend (p. ej. 'qa' | 'prod'). Se estampa en
   * cada log para poder separar registros de prueba de los de producción.
   */
  environment?: string;
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
          useValue: new ActivityLogger({
            store: activityStore,
            clock: systemClock,
            logger: auditLogger,
            environment: options.environment,
          }),
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

/**
 * Construye los stores. NO inicializa Firebase aquí (eso ocurre perezosamente
 * en la primera escritura, ya con el runtime levantado): así el bootstrap de
 * Nest nunca falla por el orden de inicialización ni por credenciales malas.
 * Solo decide real vs no-op según haya credenciales mínimas configuradas.
 */
function buildStores(options: ActivityAuditOptions, logger: AuditLogger) {
  const c = options.credentials || ({} as AuditFirebaseCredentials);
  const hasCreds =
    !!c.databaseURL &&
    (!!c.serviceAccountJson ||
      (!!c.projectId && !!c.clientEmail && !!c.privateKey) ||
      !!c.useApplicationDefault);

  if (!hasCreds) {
    return {
      enabled: false,
      activityStore: new NoopActivityStore(),
      sessionStore: new NoopSessionStore(),
    };
  }

  // Resolver perezoso y memoizado: Firebase se inicializa en el primer uso.
  const getDb = createLazyAuditDatabase(c);
  return {
    enabled: true,
    activityStore: new RtdbActivityStore(getDb, options.paths?.activity),
    sessionStore: new RtdbSessionStore(getDb, options.paths?.sessions),
  };
}
