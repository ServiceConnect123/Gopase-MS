// ==========================================
// activity-audit · adapter RTDB · SessionStore
// ==========================================

import type { Database } from 'firebase-admin/database';
import type { SessionStore } from '../../core/ports';
import type { SessionQuery, SessionSummary } from '../../core/types';

interface RawSummary {
  usuario: string;
  conjunto?: string;
  sesionesIniciadas: number;
  ultimoInicioSesion: number; // epoch ms
  primerInicioSesion: number; // epoch ms
}

/**
 * Métricas de sesión en RTDB bajo /{basePath}/{usuario}. Usa una TRANSACCIÓN
 * para incrementar el contador de forma atómica (seguro ante logins
 * concurrentes) y fijar `primerInicioSesion` solo la primera vez. Una sola
 * escritura por login: no degrada el rendimiento del login.
 */
export class RtdbSessionStore implements SessionStore {
  constructor(
    private readonly getDb: () => Database,
    private readonly basePath = 'session_summaries',
  ) {}

  async recordLogin(usuario: string, at: Date, conjunto?: string): Promise<void> {
    const atMs = at.getTime();
    const ref = this.getDb().ref(`${this.basePath}/${safeKey(usuario)}`);
    await ref.transaction((current: RawSummary | null) => {
      if (!current) {
        return {
          usuario,
          ...(conjunto ? { conjunto } : {}),
          sesionesIniciadas: 1,
          primerInicioSesion: atMs,
          ultimoInicioSesion: atMs,
        } satisfies RawSummary;
      }
      return {
        ...current,
        usuario,
        // Actualiza el conjunto si viene uno nuevo (último conjunto conocido).
        ...(conjunto ? { conjunto } : {}),
        sesionesIniciadas: (current.sesionesIniciadas || 0) + 1,
        ultimoInicioSesion: atMs,
        // primerInicioSesion NO se toca: es inmutable tras el primer login.
        primerInicioSesion: current.primerInicioSesion || atMs,
      } satisfies RawSummary;
    });
  }

  async get(usuario: string): Promise<SessionSummary | null> {
    const snap = await this.getDb().ref(`${this.basePath}/${safeKey(usuario)}`).get();
    if (!snap.exists()) return null;
    return toSummary(snap.val() as RawSummary, usuario);
  }

  /**
   * Lista todos los resúmenes de sesión (ordenados por último login, desc).
   * Filtra por conjunto en memoria. El volumen de usuarios es acotado, así que
   * leer el nodo completo es aceptable.
   */
  async list(filter: SessionQuery): Promise<SessionSummary[]> {
    const snap = await this.getDb().ref(this.basePath).get();
    if (!snap.exists()) return [];
    const all = snap.val() as Record<string, RawSummary>;
    let items = Object.values(all).map((d) => toSummary(d, d.usuario));
    if (filter.conjunto) {
      items = items.filter((s) => (s.conjunto || '') === filter.conjunto);
    }
    items.sort((a, b) => b.ultimoInicioSesion.getTime() - a.ultimoInicioSesion.getTime());
    const limit = Math.min(Math.max(filter.limit ?? 200, 1), 1000);
    return items.slice(0, limit);
  }
}

function toSummary(d: RawSummary, fallbackUser: string): SessionSummary {
  return {
    usuario: d.usuario ?? fallbackUser,
    conjunto: d.conjunto,
    sesionesIniciadas: d.sesionesIniciadas ?? 0,
    ultimoInicioSesion: new Date(d.ultimoInicioSesion ?? 0),
    primerInicioSesion: new Date(d.primerInicioSesion ?? 0),
  };
}

/** Las claves de RTDB no admiten . # $ [ ] / — se sustituyen por "_". */
function safeKey(key: string): string {
  return String(key || 'anonimo').replace(/[.#$/[\]]/g, '_');
}
