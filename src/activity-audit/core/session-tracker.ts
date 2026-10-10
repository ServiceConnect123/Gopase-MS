// ==========================================
// activity-audit · core · SessionTracker (caso de uso)
// ==========================================

import type { SessionStore, Clock, AuditLogger } from './ports';
import type { SessionSummary } from './types';
import { fireAndForget } from './fail-safe';

export interface SessionTrackerDeps {
  store: SessionStore;
  clock: Clock;
  logger: AuditLogger;
}

/**
 * Métricas de sesión por usuario. `trackLogin()` no bloquea el flujo de
 * autenticación (fire-and-forget) para no degradar el login.
 */
export class SessionTracker {
  constructor(private readonly deps: SessionTrackerDeps) {}

  /** Registra un login. No bloquea ni lanza. */
  trackLogin(usuario: string): void {
    if (!usuario) return;
    const at = this.deps.clock.now();
    fireAndForget(
      () => this.deps.store.recordLogin(usuario, at),
      this.deps.logger,
      `recordLogin usuario=${usuario}`,
    );
  }

  /** Lee el resumen de sesiones de un usuario (para reportes/analítica). */
  getSummary(usuario: string): Promise<SessionSummary | null> {
    return this.deps.store.get(usuario);
  }
}
