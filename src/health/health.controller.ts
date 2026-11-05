import { Controller, Get, Head } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Public } from '../auth/public.decorator';

/**
 * Salud del servicio. Responde 200 en `/` y `/health` para health checks de la
 * infraestructura (Render) y para los bots/escáneres que golpean la raíz. Antes
 * no existía un controller en `/`, así que esos `GET/HEAD /` daban 404 y
 * generaban ruido en Sentry (NotFoundException: Cannot GET /).
 *
 * Público (sin JWT) y oculto de Swagger.
 */
@Public()
@ApiExcludeController()
@Controller()
export class HealthController {
  @Get()
  @Head()
  root() {
    return { ok: true, service: 'gopase-backend' };
  }

  @Get('health')
  @Head('health')
  health() {
    return { ok: true, status: 'up', ts: new Date().toISOString() };
  }
}
