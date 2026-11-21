import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { FirebaseService } from '../firebase/firebase.service';
import { conjuntoPropioDelRequest } from './conjunto-scope';
import { IS_PUBLIC_KEY } from './public.decorator';

/** Roles que pueden operar el WhatsApp (enviar, vincular, desvincular). */
export type WspRol = 'admin' | 'superadmin' | 'propietario' | 'inquilino';

const WSP_ROLES_KEY = 'wspRoles';

/**
 * Roles permitidos para un endpoint protegido por WspAccessGuard.
 * Por defecto (sin decorador): admin y superAdmin.
 */
export const WspRoles = (...roles: WspRol[]) => SetMetadata(WSP_ROLES_KEY, roles);

/**
 * Guard de los endpoints SENSIBLES de WhatsApp (enviar mensajes, QR, vincular,
 * desvincular). Antes eran @Public(): cualquiera con la URL podía enviar
 * mensajes desde el número de un conjunto o desvincularlo.
 *
 * A diferencia del JwtAuthGuard global, este guard SIEMPRE exige un JWT válido,
 * aunque AUTH_GUARD_ENABLED esté apagado: estos endpoints no pueden quedar
 * abiertos por un interruptor de rollout.
 *
 * Solo valida identidad y rol. El CONJUNTO se valida en el controller con
 * `assertConjuntoPermitido`, porque el body puede venir cifrado y el
 * PayloadCryptoInterceptor (que lo descifra) corre DESPUÉS de los guards.
 */
@Injectable()
export class WspAccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;
    // Respeta @Public() en un handler (p. ej. /whatsapp/status con el guard a nivel de clase).
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;
    const req = context.switchToHttp().getRequest();
    if (String(req?.method || '').toUpperCase() === 'OPTIONS') return true;

    const header = String(req?.headers?.authorization || '');
    const [scheme, token] = header.split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !token) {
      throw new UnauthorizedException('Falta el token de autenticación.');
    }
    let payload: any;
    try {
      payload = this.jwt.verify(token.trim());
    } catch {
      throw new UnauthorizedException('Token inválido o expirado.');
    }
    req.user = payload;

    const permitidos =
      this.reflector.getAllAndOverride<WspRol[]>(WSP_ROLES_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) || ['admin', 'superadmin'];
    const rol = String(payload?.rol || '').toLowerCase() as WspRol;
    if (!permitidos.includes(rol)) {
      throw new ForbiddenException('No tienes permisos para usar WhatsApp.');
    }
    return true;
  }
}

export function esSuperAdmin(req: any): boolean {
  return String(req?.user?.rol || '').toLowerCase() === 'superadmin';
}

const norm = (s: unknown) => String(s ?? '').trim().toLowerCase();

/**
 * Verifica que el usuario autenticado (req.user, puesto por WspAccessGuard)
 * pueda operar sobre `conjunto`:
 *   - superAdmin: cualquiera, incluida la sesión global (conjunto vacío).
 *   - admin: solo SU conjunto (por nombre o id). Conjunto vacío = sesión global
 *     de goPase => prohibido, salvo que `permitirGlobal` lo autorice.
 */
export async function assertConjuntoPermitido(
  req: any,
  firebase: FirebaseService,
  conjunto: string | null | undefined,
  opts: { permitirGlobal?: boolean } = {},
): Promise<void> {
  if (esSuperAdmin(req)) return;
  const objetivo = norm(conjunto);
  if (!objetivo) {
    if (opts.permitirGlobal) return;
    throw new ForbiddenException('Debes indicar el conjunto.');
  }
  const propio = norm(await conjuntoPropioDelRequest(req, firebase));
  const propioId = norm(req?.user?.conjuntoId);
  if ((propio && propio === objetivo) || (propioId && propioId === objetivo)) return;
  throw new ForbiddenException('No tienes acceso a ese conjunto.');
}
