// ==========================================
// activity-audit · core · tipos
// ==========================================
// Sin dependencias de framework ni de Firebase. Son el "lenguaje" del módulo.

/** Un evento de actividad/auditoría (trazabilidad). */
export interface ActivityLog {
  /** Pantalla, sección o endpoint ejecutado. */
  vista: string;
  /** Identificador del usuario (uid, username...). */
  usuario: string;
  /** Conjunto/propiedad al que pertenece la acción (para filtrar por conjunto). */
  conjunto?: string;
  /** Entorno de ejecución del backend que generó el log (p. ej. 'qa' | 'prod'). */
  ambiente?: string;
  /** Información contextual flexible de la acción. */
  detalle: Record<string, unknown>;
  /** URL/referencia a una captura o archivo adjunto (Firebase Storage, etc.). */
  evidenciaUrl?: string;
  /** Momento del evento. La librería lo fija si no se provee. */
  timestamp: Date;
  /** Metadatos técnicos opcionales. */
  meta?: ActivityMeta;
  /** Id de almacenamiento (push key). Solo presente al leer; permite borrar. */
  id?: string;
  /** Partición de día (YYYY-MM-DD) donde está guardado. Solo lectura. */
  day?: string;
}

export interface ActivityMeta {
  ip?: string;
  userAgent?: string;
  requestId?: string;
  durationMs?: number;
  statusCode?: number;
  /**
   * Id del evento en la herramienta de errores (p. ej. Sentry), si esta
   * actividad corresponde a un error técnico reportado. Permite cruzar el log
   * de monitoreo con el detalle técnico del error.
   */
  errorEventId?: string;
}

/** Entrada del logger (sin timestamp: lo pone la librería si falta). */
export type ActivityInput = Omit<ActivityLog, 'timestamp'> & {
  timestamp?: Date;
  /**
   * Error técnico asociado a esta actividad. NO se persiste: se entrega al
   * ErrorReporter (si hay uno) y su id queda en `meta.errorEventId`.
   */
  error?: unknown;
};

/** Un error técnico agrupado (issue) en la herramienta de errores. Sin datos personales. */
export interface ErrorIssue {
  id: string;
  /** Identificador corto legible (p. ej. GOPASE-BACKEND-1A). */
  shortId: string;
  title: string;
  culprit: string;
  /** 'fatal' | 'error' | 'warning' | 'info' | 'debug' */
  level: string;
  /** 'unresolved' | 'resolved' | 'ignored' */
  status: string;
  /** Total de ocurrencias. */
  count: number;
  /** Usuarios distintos afectados. */
  userCount: number;
  firstSeen: string;
  lastSeen: string;
  /** Proyecto de origen (p. ej. gopase-backend). */
  project: string;
  /** Enlace directo al issue en la herramienta de errores. */
  permalink: string;
}

/** Filtros de consulta de errores técnicos. */
export interface ErrorIssueQuery {
  /** 'qa' | 'prod'. Vacío = todos. */
  ambiente?: string;
  /** Ventana relativa: 24h | 7d | 14d | 30d | 90d. */
  periodo?: string;
  /** 'unresolved' (default) | 'resolved' | 'all'. */
  estado?: string;
  /** Máximo de resultados (1-100). */
  limit?: number;
}

/** Resultado de listar errores técnicos. */
export interface ErrorIssueResult {
  issues: ErrorIssue[];
  /** Avisos no fatales (p. ej. un proyecto que no respondió). */
  warnings: string[];
}

/** Contexto que acompaña a un error técnico reportado. */
export interface ErrorContext {
  vista: string;
  usuario: string;
  conjunto?: string;
  ambiente?: string;
  /** Status HTTP del fallo (si aplica): define el nivel en Sentry (4xx warning, 5xx error). */
  statusCode?: number;
}

/** Contexto de la petición en curso (para etiquetar cualquier error posterior). */
export interface RequestContext {
  usuario?: string;
  conjunto?: string;
  rol?: string;
}

/** Resumen de sesiones por usuario (métricas de login). */
export interface SessionSummary {
  usuario: string;
  /** Último conjunto conocido del usuario (para filtrar por conjunto). */
  conjunto?: string;
  sesionesIniciadas: number;
  ultimoInicioSesion: Date;
  primerInicioSesion: Date;
}

/** Filtros de consulta de actividad. */
export interface ActivityQuery {
  conjunto?: string;
  usuario?: string;
  /** Entorno a filtar (p. ej. 'qa' | 'prod'). Vacío/undefined = todos. */
  ambiente?: string;
  /** Máximo de resultados (más recientes primero). */
  limit?: number;
}

/** Filtros de consulta de resúmenes de sesión. */
export interface SessionQuery {
  conjunto?: string;
  limit?: number;
}

/** Filtros para recorrer TODA la actividad de una ventana de días (agregaciones). */
export interface ActivityScanQuery {
  conjunto?: string;
  /** Entorno a filtrar ('qa' | 'prod'). Vacío = todos. */
  ambiente?: string;
  /** Ventana en días hacia atrás (1-14). Por defecto 14. */
  dias?: number;
  /** Tope de eventos leídos para acotar memoria. Por defecto 20000. */
  maxEventos?: number;
}

/** Uso de un módulo (recurso) dentro del resumen de actividad. */
export interface ModuleUsage {
  modulo: string;
  total: number;
  creaciones: number;
  ediciones: number;
  eliminaciones: number;
  otras: number;
  /** Porcentaje sobre el total de acciones de módulos (0-100, 1 decimal). */
  porcentaje: number;
}

/** Resumen agregado de la actividad de un conjunto en una ventana de días. */
export interface ActivitySummary {
  conjunto: string;
  dias: number;
  desde: string;
  hasta: string;
  /** Eventos leídos (incluye aperturas y errores). */
  totalEventos: number;
  /** Acciones sobre módulos (crear/editar/eliminar...), sin aperturas ni errores. */
  totalAcciones: number;
  errores: number;
  usuariosActivos: number;
  ultimaActividad: string | null;
  modulos: ModuleUsage[];
  /** Un punto por día de la ventana (rellena con 0 los días sin actividad). */
  porDia: Array<{ dia: string; acciones: number }>;
  topUsuarios: Array<{ usuario: string; total: number }>;
  /** true si se alcanzó `maxEventos` y el resumen es parcial. */
  truncado: boolean;
}

/** Aperturas de la app ('Abrió la app') en una ventana de días, por usuario y por día. */
export interface OpeningsSummary {
  /** Vacío = todos los conjuntos. */
  conjunto: string;
  dias: number;
  total: number;
  porUsuario: Array<{ usuario: string; total: number; ultima: string }>;
  porDia: Array<{ dia: string; aperturas: number }>;
  /** true si se alcanzó el tope de eventos leídos y el conteo es parcial. */
  truncado: boolean;
}
