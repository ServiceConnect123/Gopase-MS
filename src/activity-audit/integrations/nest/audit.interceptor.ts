// ==========================================
// activity-audit · integración NestJS · interceptor
// ==========================================

import {
  CallHandler,
  ExecutionContext,
  Inject,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { ActivityLogger } from '../../core/activity-logger';
import { ACTIVITY_LOGGER } from './activity-audit.tokens';

/** Campos que NUNCA deben quedar registrados en los logs de auditoría. */
const SENSITIVE_KEYS = [
  'password',
  'passwordenc',
  'passwordplain',
  'newpassword',
  'token',
  'authorization',
  'privatekey',
  'serviceaccountjson',
];

/**
 * Interceptor global: audita cada request HTTP de forma no bloqueante.
 * No añade latencia (el log es fire-and-forget) y nunca lanza.
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(@Inject(ACTIVITY_LOGGER) private readonly activity: ActivityLogger) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (ctx.getType() !== 'http') return next.handle();

    const req = ctx.switchToHttp().getRequest();
    const start = Date.now();

    return next.handle().pipe(
      tap({
        next: () => this.emit(req, start, 200),
        error: (e) => this.emit(req, start, e?.status ?? 500),
      }),
    );
  }

  private emit(req: any, start: number, statusCode: number): void {
    try {
      const vista = `${req?.method ?? 'GET'} ${req?.route?.path ?? req?.originalUrl ?? req?.url ?? ''}`;
      const usuario =
        req?.user?.uid || req?.user?.username || req?.body?.usuario || req?.body?.username || 'anonimo';

      this.activity.log({
        vista,
        usuario: String(usuario),
        detalle: {
          params: req?.params ?? {},
          query: req?.query ?? {},
          body: redact(req?.body),
        },
        evidenciaUrl: req?.body?.evidenciaUrl,
        meta: {
          ip: req?.ip,
          userAgent: req?.headers?.['user-agent'],
          durationMs: Date.now() - start,
          statusCode,
        },
      });
    } catch {
      /* el interceptor nunca debe romper el request */
    }
  }
}

/** Enmascara credenciales/tokens en el body antes de auditarlo. */
function redact(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object') return {};
  const out: Record<string, unknown> = { ...(body as Record<string, unknown>) };
  for (const key of Object.keys(out)) {
    if (SENSITIVE_KEYS.includes(key.toLowerCase())) out[key] = '[REDACTED]';
  }
  return out;
}
