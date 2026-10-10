// ==========================================
// activity-audit · core · fail-safe
// ==========================================
// Patrón de tolerancia a fallos: una operación de persistencia NUNCA debe
// propagar errores ni bloquear la aplicación principal.

import type { AuditLogger } from './ports';

/**
 * Ejecuta una operación de persistencia de forma NO bloqueante y tolerante a
 * fallos: se dispara en el siguiente microtask (fire-and-forget) y cualquier
 * error se traga (se loguea), de modo que un fallo de Firebase/red jamás afecta
 * al request de la app host.
 */
export function fireAndForget(
  op: () => Promise<void>,
  logger: AuditLogger,
  context: string,
): void {
  // Sin await: la API responde sin esperar a la persistencia.
  queueMicrotask(() => {
    void runSafe(op, logger, context);
  });
}

/** Versión await-able: ejecuta y absorbe el error (devuelve true si tuvo éxito). */
export async function runSafe(
  op: () => Promise<void>,
  logger: AuditLogger,
  context: string,
): Promise<boolean> {
  try {
    await op();
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`[activity-audit] ${context} falló (ignorado): ${msg}`);
    return false;
  }
}
