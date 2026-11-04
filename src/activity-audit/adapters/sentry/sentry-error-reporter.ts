// ==========================================
// activity-audit · adapter Sentry · ErrorReporter
// ==========================================
// Conecta el monitoreo con Sentry. Si Sentry no está inicializado (sin
// SENTRY_DSN) todo queda inerte y no se devuelve ningún id de evento.
//
// Privacidad: solo viajan identificadores (usuario/conjunto) y metadatos de la
// acción. Nunca el body de la petición ni la evidencia (capturas de pantalla).

import * as Sentry from '@sentry/nestjs';
import type { ErrorReporter } from '../../core/ports';
import type { ActivityLog, ErrorContext, RequestContext } from '../../core/types';
import { markReported } from './reported-errors';

export class SentryErrorReporter implements ErrorReporter {
  breadcrumb(log: ActivityLog): void {
    if (!Sentry.getClient()) return;
    Sentry.addBreadcrumb({
      category: 'activity',
      level: 'info',
      message: log.vista,
      data: {
        usuario: log.usuario,
        conjunto: log.conjunto,
        ambiente: log.ambiente,
        accion: log.detalle?.accion,
        recurso: log.detalle?.recurso,
        endpoint: log.detalle?.endpoint,
        statusCode: log.meta?.statusCode,
      },
    });
  }

  captureError(error: unknown, ctx: ErrorContext): string | undefined {
    // Sin cliente (sin DSN) captureException igual devolvería un id que nunca
    // se envió; no lo exponemos para no enlazar a un evento inexistente.
    if (!Sentry.getClient()) return undefined;
    return Sentry.withScope((scope) => {
      scope.setUser({ id: ctx.usuario, username: ctx.usuario });
      scope.setTag('vista', ctx.vista);
      if (ctx.statusCode) scope.setTag('http_status', String(ctx.statusCode));
      // 5xx (o sin status) = error; 4xx (validación, permisos, no encontrado) = warning.
      scope.setLevel(ctx.statusCode && ctx.statusCode < 500 ? 'warning' : 'error');
      if (ctx.conjunto) scope.setTag('conjunto', ctx.conjunto);
      if (ctx.ambiente) scope.setTag('ambiente', ctx.ambiente);
      scope.setContext('actividad', {
        vista: ctx.vista,
        usuario: ctx.usuario,
        conjunto: ctx.conjunto,
        ambiente: ctx.ambiente,
        statusCode: ctx.statusCode,
      });
      markReported(error);
      return Sentry.captureException(error);
    });
  }

  setRequestContext(ctx: RequestContext): void {
    if (!Sentry.getClient()) return;
    const scope = Sentry.getIsolationScope();
    if (ctx.usuario) scope.setUser({ id: ctx.usuario, username: ctx.usuario });
    if (ctx.conjunto) scope.setTag('conjunto', ctx.conjunto);
    if (ctx.rol) scope.setTag('rol', ctx.rol);
  }
}
