import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { IS_PUBLIC_KEY } from './public.decorator';

/**
 * Guard global de autenticación por JWT propio.
 *
 * - Interruptor por env AUTH_GUARD_ENABLED: si NO es 'true', el guard deja pasar
 *   TODO (modo desactivado). Esto permite desplegar el código sin obligar el
 *   token hasta que los clientes (frontend) ya lo envíen. Rollout seguro.
 * - Rutas marcadas con @Public() nunca exigen token (login, health, docs, ops).
 * - En el resto, exige "Authorization: Bearer <jwt>" válido y adjunta el payload
 *   verificado en req.user (sub = uid, rol, conjuntoId).
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  private readonly logger = new Logger(JwtAuthGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    // Solo aplica a HTTP (deja pasar otros transportes si los hubiera).
    if (context.getType() !== 'http') return true;

    // Interruptor global: si el guard no está habilitado, no exige nada.
    const enabled = this.config.get<string>('AUTH_GUARD_ENABLED', 'false') === 'true';
    if (!enabled) return true;

    // Rutas públicas (login, status, health, docs, ops con x-sync-token).
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest();

    // Las preflight CORS (OPTIONS) nunca llevan token.
    if (String(req?.method || '').toUpperCase() === 'OPTIONS') return true;

    const token = this.extractBearer(req);
    if (!token) {
      throw new UnauthorizedException('Falta el token de autenticación.');
    }

    try {
      const payload = this.jwt.verify(token);
      req.user = payload; // { sub: uid, rol, conjuntoId, iat, exp }
      return true;
    } catch (err: any) {
      this.logger.warn(`[auth] token inválido: ${err?.message}`);
      throw new UnauthorizedException('Token inválido o expirado.');
    }
  }

  /** Extrae el JWT del header Authorization: Bearer <token>. */
  private extractBearer(req: any): string | null {
    const header = String(req?.headers?.authorization || req?.headers?.Authorization || '');
    const [scheme, value] = header.split(' ');
    if (scheme?.toLowerCase() === 'bearer' && value) return value.trim();
    return null;
  }
}
