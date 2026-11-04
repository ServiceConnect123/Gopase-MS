// ==========================================
// activity-audit · integración NestJS · guard de superAdmin
// ==========================================
// Exige que el JWT verificado (req.user, lo deja el guard global de auth) tenga
// rol "superAdmin". Falla CERRADO: sin token o sin rol -> 403. Ojo: si el guard
// global está desactivado (AUTH_GUARD_ENABLED != 'true') nadie llena req.user y
// los endpoints protegidos con este guard quedan inaccesibles, a propósito.

import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';

@Injectable()
export class SuperAdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return false;
    const req = context.switchToHttp().getRequest();
    const rol = String(req?.user?.rol ?? '').trim();
    if (rol !== 'superAdmin') {
      throw new ForbiddenException('Solo el superAdmin puede ver los errores técnicos.');
    }
    return true;
  }
}
