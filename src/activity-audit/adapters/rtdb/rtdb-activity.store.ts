// ==========================================
// activity-audit · adapter RTDB · ActivityStore
// ==========================================

import type { Database } from 'firebase-admin/database';
import type { ActivityStore } from '../../core/ports';
import type { ActivityLog } from '../../core/types';

/**
 * Persiste logs de actividad en Realtime Database bajo una ruta dedicada.
 * Estructura: /{basePath}/{YYYY-MM-DD}/{pushId} = { ...log }.
 *
 * La `Database` se resuelve de forma PEREZOSA (vía `getDb`), en la primera
 * escritura, no al construir el módulo. Así se evita inicializar Firebase
 * durante el bootstrap de Nest (orden de arranque) y cualquier fallo cae dentro
 * del wrapper fail-safe, nunca en el arranque de la app.
 */
export class RtdbActivityStore implements ActivityStore {
  constructor(
    private readonly getDb: () => Database,
    private readonly basePath = 'activity_logs',
  ) {}

  async append(log: ActivityLog): Promise<void> {
    const db = this.getDb();
    const day = log.timestamp.toISOString().slice(0, 10); // YYYY-MM-DD
    const ref = db.ref(`${this.basePath}/${day}`).push();
    await ref.set({
      vista: log.vista,
      usuario: log.usuario,
      detalle: sanitize(log.detalle),
      // RTDB no admite `undefined`: solo se escriben campos presentes.
      ...(log.evidenciaUrl ? { evidenciaUrl: log.evidenciaUrl } : {}),
      ...(log.meta ? { meta: sanitize(log.meta as Record<string, unknown>) } : {}),
      // Guardamos epoch (orden/consultas) e ISO (legible).
      timestamp: log.timestamp.getTime(),
      timestampIso: log.timestamp.toISOString(),
    });
  }
}

/**
 * RTDB rechaza `undefined` y claves vacías. Limpia recursivamente el payload
 * flexible `detalle`/`meta` para no romper la escritura.
 */
function sanitize(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (v === undefined || k === '') continue;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = sanitize(v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}
