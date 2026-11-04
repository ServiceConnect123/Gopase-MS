// ==========================================
// activity-audit · adapter Sentry · errores ya reportados
// ==========================================
// Evita reportar dos veces la misma excepción: el AuditInterceptor la captura
// (para enlazar su id en el log de monitoreo) y luego el filtro global la volvería
// a ver. WeakSet: no retiene memoria de excepciones ya descartadas.
const reported = new WeakSet<object>();

/** Marca la excepción como ya enviada a Sentry. Ignora valores no-objeto. */
export function markReported(error: unknown): void {
  if (error !== null && typeof error === 'object') reported.add(error as object);
}

export function wasReported(error: unknown): boolean {
  return error !== null && typeof error === 'object' && reported.has(error as object);
}
