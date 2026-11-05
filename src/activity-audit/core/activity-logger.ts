// ==========================================
// activity-audit · core · ActivityLogger (caso de uso)
// ==========================================

import type { ActivityStore, Clock, AuditLogger, ErrorReporter } from './ports';
import type {
  ActivityInput,
  ActivityLog,
  ActivityQuery,
  ActivitySummary,
  OpeningsSummary,
  ScreenViewsSummary,
  RequestContext,
} from './types';
import { summarizeActivity, summarizeOpenings, summarizeScreenViews } from './activity-summary';
import { fireAndForget, runSafe } from './fail-safe';

export interface ActivityLoggerDeps {
  store: ActivityStore;
  clock: Clock;
  logger: AuditLogger;
  /** Entorno de ejecución a estampar por defecto en cada log (p. ej. 'qa' | 'prod'). */
  environment?: string;
  /** Reporter de errores técnicos (opcional). Sin él, el comportamiento no cambia. */
  reporter?: ErrorReporter;
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
    this.report(input, entry);
    fireAndForget(
      () => this.deps.store.append(entry),
      this.deps.logger,
      `append vista=${entry.vista} usuario=${entry.usuario}`,
    );
  }

  /** Variante await-able para flujos donde se quiera confirmar la escritura. */
  async logAwait(input: ActivityInput): Promise<boolean> {
    const entry = this.normalize(input);
    this.report(input, entry);
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

  /**
   * Resumen agregado de la actividad de un conjunto (módulos más usados, acciones
   * por día, usuarios activos). Lee toda la ventana, por eso se cachea 60 s por
   * (conjunto, ambiente, días). Si el store falla devuelve null (nunca lanza).
   */
  async summary(filter: { conjunto: string; ambiente?: string; dias?: number }): Promise<ActivitySummary | null> {
    const dias = Math.min(Math.max(filter.dias ?? 14, 1), 14);
    const key = `${filter.conjunto}|${filter.ambiente ?? ''}|${dias}`;
    const ahora = this.deps.clock.now();
    const hit = this.summaryCache.get(key);
    if (hit && ahora.getTime() - hit.at < 60_000) return hit.value;

    try {
      const { logs, truncado } = await this.deps.store.scan({
        conjunto: filter.conjunto,
        ambiente: filter.ambiente,
        dias,
      });
      const value = summarizeActivity(logs, { conjunto: filter.conjunto, dias, ahora, truncado });
      this.summaryCache.set(key, { at: ahora.getTime(), value });
      // Evita crecer sin límite si se consultan muchos conjuntos.
      if (this.summaryCache.size > 200) this.summaryCache.delete(this.summaryCache.keys().next().value as string);
      return value;
    } catch (e) {
      this.deps.logger.error(`summary falló: ${(e as Error)?.message}`);
      return null;
    }
  }

  private readonly summaryCache = new Map<string, { at: number; value: ActivitySummary }>();
  private readonly openingsCache = new Map<string, { at: number; value: OpeningsSummary }>();
  private readonly screenViewsCache = new Map<string, { at: number; value: ScreenViewsSummary }>();

  /**
   * Aperturas de la app por usuario y por día (para Monitoreo > Sesiones). Lee
   * toda la ventana, así que no depende del límite de 500 de `query`. Cacheado
   * 60 s. `conjunto` opcional (vacío = todos). Devuelve null si el store falla.
   */
  async openings(filter: { conjunto?: string; ambiente?: string; dias?: number }): Promise<OpeningsSummary | null> {
    const dias = Math.min(Math.max(filter.dias ?? 14, 1), 14);
    const key = `${filter.conjunto ?? ''}|${filter.ambiente ?? ''}|${dias}`;
    const ahora = this.deps.clock.now();
    const hit = this.openingsCache.get(key);
    if (hit && ahora.getTime() - hit.at < 60_000) return hit.value;

    try {
      const { logs, truncado } = await this.deps.store.scan({
        conjunto: filter.conjunto,
        ambiente: filter.ambiente,
        dias,
      });
      const value = summarizeOpenings(logs, { conjunto: filter.conjunto, dias, ahora, truncado });
      this.openingsCache.set(key, { at: ahora.getTime(), value });
      if (this.openingsCache.size > 200) this.openingsCache.delete(this.openingsCache.keys().next().value as string);
      return value;
    } catch (e) {
      this.deps.logger.error(`openings falló: ${(e as Error)?.message}`);
      return null;
    }
  }

  /**
   * Vistas de pantalla por pantalla y por día (Monitoreo > Pantallas más usadas).
   * Mismo patrón que `openings`: lee toda la ventana vía `scan` y cachea 60 s.
   * `conjunto` opcional (vacío = todos). Devuelve null si el store falla.
   */
  async screenViews(filter: { conjunto?: string; ambiente?: string; dias?: number }): Promise<ScreenViewsSummary | null> {
    const dias = Math.min(Math.max(filter.dias ?? 14, 1), 14);
    const key = `${filter.conjunto ?? ''}|${filter.ambiente ?? ''}|${dias}`;
    const ahora = this.deps.clock.now();
    const hit = this.screenViewsCache.get(key);
    if (hit && ahora.getTime() - hit.at < 60_000) return hit.value;

    try {
      const { logs, truncado } = await this.deps.store.scan({
        conjunto: filter.conjunto,
        ambiente: filter.ambiente,
        dias,
      });
      const value = summarizeScreenViews(logs, { conjunto: filter.conjunto, dias, ahora, truncado });
      this.screenViewsCache.set(key, { at: ahora.getTime(), value });
      if (this.screenViewsCache.size > 200) this.screenViewsCache.delete(this.screenViewsCache.keys().next().value as string);
      return value;
    } catch (e) {
      this.deps.logger.error(`screenViews falló: ${(e as Error)?.message}`);
      return null;
    }
  }

  /** Elimina un log puntual (día + id). Fail-safe: nunca lanza. */
  async remove(day: string, id: string): Promise<boolean> {
    return runSafe(
      () => this.deps.store.remove(day, id),
      this.deps.logger,
      `remove day=${day} id=${id}`,
    );
  }

  /** Borrado masivo por filtro. Devuelve cuántos borró (0 si falla). */
  async removeByFilter(filter: ActivityQuery): Promise<number> {
    try {
      return await this.deps.store.removeByFilter(filter);
    } catch (e) {
      this.deps.logger.error(`removeByFilter falló: ${(e as Error)?.message}`);
      return 0;
    }
  }

  /** Etiqueta la petición en curso (usuario/conjunto/rol) para errores posteriores. */
  bindRequest(ctx: RequestContext): void {
    try {
      this.deps.reporter?.setRequestContext(ctx);
    } catch (e) {
      this.deps.logger.warn(`[activity-audit] bindRequest falló (ignorado): ${(e as Error)?.message}`);
    }
  }

  /**
   * Entrega la actividad al reporter: siempre como migaja de pan y, si trae un
   * error técnico, lo reporta y deja su id en `meta.errorEventId`. Nunca lanza.
   */
  private report(input: ActivityInput, entry: ActivityLog): void {
    const reporter = this.deps.reporter;
    if (!reporter) return;
    try {
      reporter.breadcrumb(entry);
      if (input.error !== undefined) {
        const eventId = reporter.captureError(input.error, {
          vista: entry.vista,
          usuario: entry.usuario,
          conjunto: entry.conjunto,
          ambiente: entry.ambiente,
          statusCode: entry.meta?.statusCode,
        });
        if (eventId) entry.meta = { ...(entry.meta ?? {}), errorEventId: eventId };
      }
    } catch (e) {
      this.deps.logger.warn(`[activity-audit] reporter falló (ignorado): ${(e as Error)?.message}`);
    }
  }

  private normalize(input: ActivityInput): ActivityLog {
    return {
      vista: input.vista,
      usuario: input.usuario || 'anonimo',
      conjunto: input.conjunto,
      // El entorno del log: lo que traiga el input o, si no, el del backend.
      ambiente: input.ambiente ?? this.deps.environment,
      detalle: input.detalle ?? {},
      evidenciaUrl: input.evidenciaUrl,
      meta: input.meta,
      timestamp: input.timestamp ?? this.deps.clock.now(),
    };
  }
}
