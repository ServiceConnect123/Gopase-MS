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
}

export interface ActivityMeta {
  ip?: string;
  userAgent?: string;
  requestId?: string;
  durationMs?: number;
  statusCode?: number;
}

/** Entrada del logger (sin timestamp: lo pone la librería si falta). */
export type ActivityInput = Omit<ActivityLog, 'timestamp'> & { timestamp?: Date };

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
