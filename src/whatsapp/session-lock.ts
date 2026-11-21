import { Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { hostname } from 'os';
import { safeNodeKey } from './firebase-auth-state';

/**
 * Candado por sesión de WhatsApp en RTDB: garantiza que UNA sola instancia del
 * servicio use cada número vinculado.
 *
 * Por qué: en un deploy, Render arranca la instancia nueva antes de apagar la
 * vieja. Las dos se conectaban con las mismas credenciales y las dos guardaban
 * en RTDB las llaves de cifrado (que cambian con cada mensaje). Una pisaba a la
 * otra con llaves viejas y los destinatarios no podían descifrar: el mensaje
 * quedaba en "Esperando este mensaje".
 *
 * Funcionamiento (lease):
 *   mirror/wsp_lock/<sesion> = { owner, until, at }
 *   - Se toma con una transacción si está libre, vencido o ya es propio.
 *   - El dueño lo renueva cada `ttl/3`. Si una instancia muere sin liberarlo,
 *     vence a los `ttl` ms y otra puede tomarlo.
 *   - Al apagarse (SIGTERM) la instancia guarda las llaves, cierra el socket y
 *     lo libera: la nueva conecta en segundos.
 */

export const LOCK_ROOT = 'mirror/wsp_lock';

export interface LockFirebaseLike {
  isEnabled(): boolean;
  db(): {
    ref(path: string): {
      transaction(
        update: (current: any) => any,
      ): Promise<{ committed: boolean; snapshot: { val(): any } }>;
    };
  };
}

export class SessionLock {
  /** Identificador único de este proceso (instancia de Render + uuid). */
  readonly owner: string;

  constructor(
    private readonly firebase: LockFirebaseLike,
    private readonly logger: Logger,
    readonly ttlMs = 45_000,
    owner?: string,
  ) {
    const base = process.env.RENDER_INSTANCE_ID || hostname() || 'local';
    this.owner = owner || `${base}-${randomUUID().slice(0, 8)}`;
  }

  private path(sessionKey: string): string {
    return `${LOCK_ROOT}/${safeNodeKey(sessionKey)}`;
  }

  /**
   * Toma el candado (o lo renueva si ya es propio). Devuelve false si otra
   * instancia lo tiene vigente. Sin Firebase no hay con quién competir: true.
   * Ante un error de red devuelve false: es más seguro esperar que arriesgar
   * dos conexiones simultáneas.
   */
  async acquire(sessionKey: string, now = () => Date.now()): Promise<boolean> {
    if (!this.firebase.isEnabled()) return true;
    try {
      const res = await this.firebase
        .db()
        .ref(this.path(sessionKey))
        .transaction((cur) => {
          const t = now();
          if (cur && cur.owner && cur.owner !== this.owner && Number(cur.until) > t) {
            return undefined; // ocupado por otra instancia: abortar
          }
          return { owner: this.owner, until: t + this.ttlMs, at: new Date(t).toISOString() };
        });
      return !!res.committed && res.snapshot.val()?.owner === this.owner;
    } catch (e: any) {
      this.logger.warn(`[lock ${sessionKey}] No se pudo tomar el candado: ${e?.message}`);
      return false;
    }
  }

  /**
   * Renueva el candado propio. Devuelve false si se perdió (otra instancia lo
   * tomó porque venció). Un error de red NO cuenta como pérdida: se reintenta
   * en la próxima renovación (el TTL da margen para 2 fallos seguidos).
   */
  async renew(sessionKey: string, now = () => Date.now()): Promise<boolean> {
    if (!this.firebase.isEnabled()) return true;
    try {
      const res = await this.firebase
        .db()
        .ref(this.path(sessionKey))
        .transaction((cur) => {
          if (cur && cur.owner && cur.owner !== this.owner) return undefined;
          const t = now();
          return { owner: this.owner, until: t + this.ttlMs, at: new Date(t).toISOString() };
        });
      return !!res.committed && res.snapshot.val()?.owner === this.owner;
    } catch (e: any) {
      this.logger.warn(`[lock ${sessionKey}] No se pudo renovar el candado: ${e?.message}`);
      return true;
    }
  }

  /** Libera el candado si es propio (al apagar o desvincular). */
  async release(sessionKey: string): Promise<void> {
    if (!this.firebase.isEnabled()) return;
    try {
      await this.firebase
        .db()
        .ref(this.path(sessionKey))
        .transaction((cur) => {
          if (cur && cur.owner && cur.owner !== this.owner) return undefined;
          return null;
        });
    } catch (e: any) {
      this.logger.warn(`[lock ${sessionKey}] No se pudo liberar el candado: ${e?.message}`);
    }
  }
}
