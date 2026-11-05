import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { FirebaseService } from '../firebase/firebase.service';
import { IS_PUBLIC_KEY } from './public.decorator';

/**
 * Pertenencia al conjunto.
 *
 * El "conjunto" sobre el que opera cada request llega desde el cliente
 * (`?conjunto=` o `body.conjunto`), nunca del token. Con un admin que administra
 * VARIOS conjuntos, nada impedía que pidiera datos de un conjunto ajeno. Este
 * guard (global, después del JWT) valida que el conjunto del request esté en la
 * lista de membresías del usuario (mirror/usuarios/{uid}/conjuntos + su activo).
 *
 * Deja pasar (no restringe):
 *   - Rutas @Public() y preflight OPTIONS.
 *   - Si el guard JWT está apagado o no hay req.user (rollout seguro).
 *   - superAdmin: no pertenece a un conjunto, opera sobre todos.
 *   - Requests SIN conjunto en query/body (rutas que no filtran por conjunto, o
 *     que consultan por `username` propio).
 *
 * La comparación es por NOMBRE, case-insensitive (como UsersService.membresias),
 * porque la mayoría de endpoints reciben el nombre del conjunto. Para no leer
 * RTDB en cada request, cachea la lista por usuario unos segundos.
 */
@Injectable()
export class ConjuntoMembershipGuard implements CanActivate {
  private static readonly TTL_MS = 30_000;
  private readonly cache = new Map<string, { at: number; conjuntos: string[] }>();

  constructor(
    private readonly reflector: Reflector,
    private readonly firebase: FirebaseService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest();
    if (String(req?.method || '').toUpperCase() === 'OPTIONS') return true;

    const user = req?.user;
    if (!user) return true; // guard JWT desactivado: no restringe
    if (String(user.rol || '').toLowerCase() === 'superadmin') return true;

    const conjunto = this.conjuntoDelRequest(req);
    if (!conjunto) return true; // ruta que no filtra por conjunto

    const permitidos = await this.conjuntosDe(String(user.sub || ''));
    // Usuario sin membresías registradas (dato incompleto): no bloquear para no
    // romper cuentas viejas; el filtrado del front y el resto de reglas aplican.
    if (permitidos.length === 0) return true;

    const objetivo = this.norm(conjunto);
    if (permitidos.some((c) => this.norm(c) === objetivo)) return true;

    throw new ForbiddenException('No tienes acceso a ese conjunto.');
  }

  /** Conjunto declarado en el request (query o body). Acepta nombre o id. */
  private conjuntoDelRequest(req: any): string {
    const q = req?.query || {};
    const b = req?.body || {};
    const v = q.conjunto ?? b.conjunto ?? b.conjuntoId ?? q.conjuntoId ?? '';
    return String(v ?? '').trim();
  }

  private norm(s: unknown): string {
    return String(s ?? '').trim().toLowerCase();
  }

  private safeKey(raw: unknown): string {
    return String(raw ?? '').trim().replace(/[.#$/\[\]]/g, '_');
  }

  /**
   * Conjuntos del usuario (nombres), por nombre e id, leídos de
   * mirror/usuarios/{uid}. Incluye el conjunto activo (compat con cuentas viejas
   * sin el array). Cacheado unos segundos para no pegarle a RTDB por request.
   */
  private async conjuntosDe(uid: string): Promise<string[]> {
    const key = this.safeKey(uid);
    if (!key) return [];
    const hit = this.cache.get(key);
    const now = Date.now();
    if (hit && now - hit.at < ConjuntoMembershipGuard.TTL_MS) return hit.conjuntos;

    const out: string[] = [];
    const push = (c: unknown) => {
      const v = String(c ?? '').trim();
      if (v) out.push(v);
    };
    try {
      const snap = await this.firebase.db().ref(`mirror/usuarios/${key}`).get();
      if (snap.exists()) {
        const perfil = snap.val() || {};
        if (Array.isArray(perfil.conjuntos)) perfil.conjuntos.forEach(push);
        push(perfil.conjunto);
        push(perfil.conjuntoId);
      }
    } catch {
      // Si falla la lectura, devolvemos lo que haya (posiblemente vacío => no bloquea).
    }
    if (this.cache.size > 2000) this.cache.clear();
    this.cache.set(key, { at: now, conjuntos: out });
    return out;
  }
}
