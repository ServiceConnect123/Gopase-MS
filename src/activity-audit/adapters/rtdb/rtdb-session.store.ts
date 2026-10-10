// ==========================================
// activity-audit · adapter RTDB · SessionStore
// ==========================================

import type { Database } from 'firebase-admin/database';
import type { SessionStore } from '../../core/ports';
import type { SessionSummary } from '../../core/types';

interface RawSummary {
  usuario: string;
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
    private readonly db: Database,
    private readonly basePath = 'session_summaries',
  ) {}

  async recordLogin(usuario: string, at: Date): Promise<void> {
    const atMs = at.getTime();
    const ref = this.db.ref(`${this.basePath}/${safeKey(usuario)}`);
    await ref.transaction((current: RawSummary | null) => {
      if (!current) {
        return {
          usuario,
          sesionesIniciadas: 1,
          primerInicioSesion: atMs,
          ultimoInicioSesion: atMs,
        } satisfies RawSummary;
      }
      return {
        ...current,
        usuario,
        sesionesIniciadas: (current.sesionesIniciadas || 0) + 1,
        ultimoInicioSesion: atMs,
        // primerInicioSesion NO se toca: es inmutable tras el primer login.
        primerInicioSesion: current.primerInicioSesion || atMs,
      } satisfies RawSummary;
    });
  }

  async get(usuario: string): Promise<SessionSummary | null> {
    const snap = await this.db.ref(`${this.basePath}/${safeKey(usuario)}`).get();
    if (!snap.exists()) return null;
    const d = snap.val() as RawSummary;
    return {
      usuario: d.usuario ?? usuario,
      sesionesIniciadas: d.sesionesIniciadas ?? 0,
      ultimoInicioSesion: new Date(d.ultimoInicioSesion ?? 0),
      primerInicioSesion: new Date(d.primerInicioSesion ?? 0),
    };
  }
}

/** Las claves de RTDB no admiten . # $ [ ] / — se sustituyen por "_". */
function safeKey(key: string): string {
  return String(key || 'anonimo').replace(/[.#$/[\]]/g, '_');
}
