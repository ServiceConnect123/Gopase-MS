import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from './public.decorator';

/**
 * Solo lectura para conjuntos SUSPENDIDOS por falta de pago.
 *
 * Cuando el conjunto no pagó su suscripción, su administrador SÍ puede entrar y
 * ver todo, pero no crear/editar/eliminar nada. Este guard (global, después del
 * JwtAuthGuard) rechaza con 403 cualquier escritura (POST/PUT/PATCH/DELETE) de
 * un usuario cuyo token tiene `suspendido: true`.
 *
 * Se permiten igualmente:
 *   - Lecturas (GET) y preflight (OPTIONS).
 *   - Rutas @Public() (login, ops): no llevan usuario suspendido.
 *   - Pagar la suscripción (/billing*) y leer el perfil propio (/auth*, /profile),
 *     para que el admin pueda regularizar y seguir operando su cuenta.
 *   - superAdmin: nunca se le aplica (no pertenece a un conjunto).
 *
 * Como el flag viaja firmado en el JWT, no hay consulta extra por request. Un
 * token emitido ANTES de la suspensión no trae el flag; el corte efectivo de
 * ese usuario ocurre en su siguiente login (o al expirar el token).
 */
@Injectable()
export class ReadOnlyGuard implements CanActivate {
  // Prefijos que un conjunto suspendido SÍ puede escribir (pagar y gestionar su cuenta).
  private static readonly ESCRITURA_PERMITIDA = ['/billing', '/auth', '/profile'];

  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest();
    const method = String(req?.method || 'GET').toUpperCase();
    const esEscritura = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);
    if (!esEscritura) return true;

    const user = req?.user;
    // Sin usuario (guard JWT desactivado) o token sin el flag: no restringe.
    if (!user || user.suspendido !== true) return true;
    // El superAdmin no pertenece a un conjunto; nunca se le aplica.
    if (String(user.rol || '').toLowerCase() === 'superadmin') return true;

    const path = String(req?.route?.path ?? req?.originalUrl ?? req?.url ?? '').split('?')[0];
    const seg = '/' + (path.split('/').filter(Boolean)[0] || '');
    if (ReadOnlyGuard.ESCRITURA_PERMITIDA.includes(seg)) return true;

    throw new ForbiddenException(
      'El conjunto está suspendido por falta de pago. El acceso es solo de lectura hasta regularizar la suscripción.',
    );
  }
}
