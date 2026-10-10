// ==========================================
// activity-audit · adapter RTDB · ActivityStore
// ==========================================

import type { Database } from 'firebase-admin/database';
import type { ActivityStore } from '../../core/ports';
import type { ActivityLog, ActivityQuery } from '../../core/types';

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
      ...(log.conjunto ? { conjunto: log.conjunto } : {}),
      detalle: sanitize(log.detalle),
      // RTDB no admite `undefined`: solo se escriben campos presentes.
      ...(log.evidenciaUrl ? { evidenciaUrl: log.evidenciaUrl } : {}),
      ...(log.meta ? { meta: sanitize(log.meta as Record<string, unknown>) } : {}),
      // Guardamos epoch (orden/consultas) e ISO (legible).
      timestamp: log.timestamp.getTime(),
      timestampIso: log.timestamp.toISOString(),
    });
  }

  /**
   * Consulta logs recientes. RTDB no soporta filtros multi-campo, así que se
   * leen los últimos días (particionados por fecha), se combinan y se filtran
   * en memoria por conjunto/usuario. Adecuado para volúmenes de auditoría
   * moderados; para alto volumen conviene migrar a Firestore o BigQuery export.
   */
  async query(filter: ActivityQuery): Promise<ActivityLog[]> {
    const db = this.getDb();
    const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
    const days = recentDays(14); // ventana: últimos 14 días
    const results: ActivityLog[] = [];

    for (const day of days) {
      // Trae a lo sumo `limit` por día ordenados por timestamp (índice recomendado).
      const snap = await db
        .ref(`${this.basePath}/${day}`)
        .orderByChild('timestamp')
        .limitToLast(limit)
        .get();
      if (!snap.exists()) continue;

      const val = snap.val() as Record<string, RawLog>;
      for (const raw of Object.values(val)) {
        if (filter.conjunto && (raw.conjunto || '') !== filter.conjunto) continue;
        if (filter.usuario && (raw.usuario || '') !== filter.usuario) continue;
        results.push(fromRaw(raw));
      }
    }

    // Más recientes primero y recorte al límite.
    results.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
    return results.slice(0, limit);
  }
}

interface RawLog {
  vista: string;
  usuario: string;
  conjunto?: string;
  detalle?: Record<string, unknown>;
  evidenciaUrl?: string;
  meta?: Record<string, unknown>;
  timestamp: number;
  timestampIso?: string;
}

function fromRaw(raw: RawLog): ActivityLog {
  return {
    vista: raw.vista,
    usuario: raw.usuario,
    conjunto: raw.conjunto,
    detalle: raw.detalle ?? {},
    evidenciaUrl: raw.evidenciaUrl,
    meta: raw.meta as ActivityLog['meta'],
    timestamp: new Date(raw.timestamp ?? 0),
  };
}

/** Devuelve las últimas `n` fechas (YYYY-MM-DD, UTC) de más reciente a antigua. */
function recentDays(n: number): string[] {
  const out: string[] = [];
  const now = Date.now();
  for (let i = 0; i < n; i++) {
    out.push(new Date(now - i * 86400000).toISOString().slice(0, 10));
  }
  return out;
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
