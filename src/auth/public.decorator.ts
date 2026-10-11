import { SetMetadata } from '@nestjs/common';

/** Clave de metadata que marca una ruta como pública (sin JWT de usuario). */
export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Marca un endpoint (o un controller entero) como PÚBLICO: el JwtAuthGuard no
 * exigirá token. Úsalo en login, health/status, docs y rutas de ops que se
 * protegen por otro mecanismo (x-sync-token).
 *
 *   @Public()
 *   @Post('login')
 *   login() { ... }
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
