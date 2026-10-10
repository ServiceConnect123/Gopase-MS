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
  sesionesIniciadas: number;
  ultimoInicioSesion: Date;
  primerInicioSesion: Date;
}
