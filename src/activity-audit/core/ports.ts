// ==========================================
// activity-audit · core · puertos (interfaces)
// ==========================================
// Puertos de salida (persistencia) y utilidades abstractas. El core depende
// solo de estas interfaces, nunca de implementaciones concretas (SOLID: DIP).

import type {
  ActivityLog,
  ActivityQuery,
  ErrorContext,
  ErrorIssueQuery,
  ErrorIssueResult,
  RequestContext,
  SessionQuery,
  SessionSummary,
} from './types';

/** Puerto de salida: dónde se guardan/consultan los logs de actividad. */
export interface ActivityStore {
  append(log: ActivityLog): Promise<void>;
  /** Consulta logs recientes con filtros opcionales (conjunto/usuario). */
  query(filter: ActivityQuery): Promise<ActivityLog[]>;
  /** Elimina un log puntual por su día (YYYY-MM-DD) e id de push. */
  remove(day: string, id: string): Promise<void>;
  /** Elimina en masa los logs que cumplen el filtro. Devuelve cuántos borró. */
  removeByFilter(filter: ActivityQuery): Promise<number>;
}

/** Puerto de salida: dónde viven las métricas de sesión. */
export interface SessionStore {
  /**
   * Incrementa de forma ATÓMICA el contador de sesiones del usuario y actualiza
   * ultimoInicioSesion; fija primerInicioSesion solo la primera vez.
   */
  recordLogin(usuario: string, at: Date, conjunto?: string): Promise<void>;
  get(usuario: string): Promise<SessionSummary | null>;
  /** Lista resúmenes de sesión (para la vista de monitoreo). */
  list(filter: SessionQuery): Promise<SessionSummary[]>;
}

/**
 * Puerto de salida: herramienta de errores/trazas técnicas (Sentry u otra).
 * Todos los métodos deben ser síncronos, baratos y NO lanzar.
 */
export interface ErrorReporter {
  /** Anota una actividad como migaja de pan (contexto previo a un error). */
  breadcrumb(log: ActivityLog): void;
  /** Reporta un error técnico. Devuelve el id del evento, si se registró. */
  captureError(error: unknown, ctx: ErrorContext): string | undefined;
  /** Etiqueta la petición en curso (usuario/conjunto/rol) para errores posteriores. */
  setRequestContext(ctx: RequestContext): void;
}

/**
 * Puerto de salida (solo lectura): consulta los errores técnicos ya agrupados
 * en la herramienta de errores, para mostrarlos dentro del monitoreo.
 */
export interface ErrorIssueSource {
  list(query: ErrorIssueQuery): Promise<ErrorIssueResult>;
  /** Resuelve el id de un evento a la URL de su issue. undefined si no se encuentra. */
  resolveEventUrl(eventId: string): Promise<string | undefined>;
}

/** Reloj inyectable (testeable, sin acoplar a Date.now). */
export interface Clock {
  now(): Date;
}

/** Logger mínimo (para que el core no dependa de console ni de Nest Logger). */
export interface AuditLogger {
  warn(message: string): void;
  error(message: string): void;
}

/** Clock por defecto basado en el reloj del sistema. */
export const systemClock: Clock = { now: () => new Date() };

/** Logger por defecto a consola (la app host puede inyectar el suyo). */
export const consoleAuditLogger: AuditLogger = {
  warn: (m) => console.warn(m),
  error: (m) => console.error(m),
};
