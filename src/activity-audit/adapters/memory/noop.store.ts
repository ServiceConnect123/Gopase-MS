// ==========================================
// activity-audit · adapter memory · stores no-op
// ==========================================
// Usados cuando la auditoría está deshabilitada (sin credenciales) para que los
// casos de uso siempre reciban una implementación válida y nunca fallen.

import type { ActivityStore, SessionStore } from '../../core/ports';
import type { SessionSummary } from '../../core/types';

export class NoopActivityStore implements ActivityStore {
  async append(): Promise<void> {
    /* descarta: auditoría deshabilitada */
  }
  async query(): Promise<[]> {
    return [];
  }
  async remove(): Promise<void> {
    /* no-op: auditoría deshabilitada */
  }
  async removeByFilter(): Promise<number> {
    return 0;
  }
}

export class NoopSessionStore implements SessionStore {
  async recordLogin(): Promise<void> {
    /* descarta: auditoría deshabilitada */
  }
  async get(): Promise<SessionSummary | null> {
    return null;
  }
  async list(): Promise<[]> {
    return [];
  }
}
