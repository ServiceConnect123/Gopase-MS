// ==========================================
// activity-audit · adapter Sentry · filtro global de errores
// ==========================================
// El SentryGlobalFilter de Sentry ignora toda HttpException (la considera
// "esperada"), así que 4xx y excepciones lanzadas a propósito nunca llegaban a
// Sentry. Este filtro las reporta también:
//   - 5xx  -> nivel error
//   - 4xx  -> nivel warning (validación, permisos, no encontrado)
// Lo demás (excepciones no controladas) lo sigue manejando SentryGlobalFilter.
import { ArgumentsHost, Catch, HttpException } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import * as Sentry from '@sentry/nestjs';
import { SentryGlobalFilter } from '@sentry/nestjs/setup';
import { markReported, wasReported } from './reported-errors';

// 4xx que son RUIDO esperado y NO deben generar evento en Sentry (igual se
// responden al cliente): peticiones a rutas inexistentes (bots/health checks) y
// faltas de token/permiso. Un 4xx de validación (400/422) sí se reporta, porque
// suele indicar un cliente mal integrado.
const STATUS_NO_REPORTAR = new Set<number>([401, 403, 404, 405]);

@Catch()
export class AllErrorsSentryFilter extends SentryGlobalFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    try {
      if (
        host.getType() === 'http' &&
        exception instanceof HttpException &&
        !wasReported(exception) &&
        !STATUS_NO_REPORTAR.has(exception.getStatus()) &&
        Sentry.getClient()
      ) {
        const status = exception.getStatus();
        const req = host.switchToHttp().getRequest();
        Sentry.withScope((scope) => {
          scope.setTag('http_status', String(status));
          scope.setLevel(status >= 500 ? 'error' : 'warning');
          scope.setContext('request', {
            metodo: req?.method,
            ruta: req?.route?.path ?? req?.originalUrl ?? req?.url,
          });
          Sentry.captureException(exception, {
            mechanism: { handled: true, type: 'auto.http.nestjs.all_errors_filter' },
          });
        });
        markReported(exception);
      }
    } catch {
      /* reportar nunca debe romper la respuesta */
    }
    // Si ya se reportó (aquí o en el AuditInterceptor) se responde con el filtro
    // base de Nest, saltando la captura de SentryGlobalFilter para no duplicar el evento.
    if (wasReported(exception)) return BaseExceptionFilter.prototype.catch.call(this, exception, host);
    return super.catch(exception, host);
  }
}
