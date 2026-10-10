// ==========================================
// activity-audit · core · ActivityLogger (caso de uso)
// ==========================================

import type { ActivityStore, Clock, AuditLogger } from './ports';
import type { ActivityInput, ActivityLog, ActivityQuery } from './types';
import { fireAndForget, runSafe } from './fail-safe';

export interface ActivityLoggerDeps {
  store: ActivityStore;
  clock: Clock;
  logger: AuditLogger;
}

/**
 * Registra actividad de usuario. La escritura es asíncrona y no bloqueante:
 * `log()` retorna void de inmediato y nunca lanza (fail-safe).
 */
export class ActivityLogger {
  constructor(private readonly deps: ActivityLoggerDeps) {}

  /** Registro fire-and-forget (recomendado para no añadir latencia). */
  log(input: ActivityInput): void {
    const entry = this.normalize(input);
    fireAndForget(
      () => this.deps.store.append(entry),
      this.deps.logger,
      `append vista=${entry.vista} usuario=${entry.usuario}`,
    );
  }

  /** Variante await-able para flujos donde se quiera confirmar la escritura. */
  async logAwait(input: ActivityInput): Promise<boolean> {
    const entry = this.normalize(input);
    return runSafe(
      () => this.deps.store.append(entry),
      this.deps.logger,
      `append vista=${entry.vista} usuario=${entry.usuario}`,
    );
  }

  /** Consulta logs recientes con filtros (para la vista de monitoreo). */
  query(filter: ActivityQuery): Promise<ActivityLog[]> {
    return this.deps.store.query(filter);
  }

  private normalize(input: ActivityInput): ActivityLog {
    return {
      vista: input.vista,
      usuario: input.usuario || 'anonimo',
      conjunto: input.conjunto,
      detalle: input.detalle ?? {},
      evidenciaUrl: input.evidenciaUrl,
      meta: input.meta,
      timestamp: input.timestamp ?? this.deps.clock.now(),
    };
  }
}
