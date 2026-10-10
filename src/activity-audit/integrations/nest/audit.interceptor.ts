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
    const method = String(req?.method || 'GET').toUpperCase();
    const path = String(req?.route?.path ?? req?.originalUrl ?? req?.url ?? '');

    // Solo se auditan ESCRITURAS significativas (crear/editar/eliminar). Las
    // lecturas (GET) no se registran para no inundar el log. Tampoco se audita
    // el propio módulo de auditoría (evita auto-registro en bucle).
    const isWrite = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);
    if (!isWrite || path.startsWith('/audit')) return next.handle();

    // Rutas que el FRONTEND ya audita con un log enriquecido (usuario legible,
    // mes, conjunto y captura de evidencia). Se omiten aquí para no duplicar el
    // registro. El /drive/upload también se ignora (es parte de la captura).
    if (isSelfAudited(path)) return next.handle();

    const start = Date.now();
    return next.handle().pipe(
      tap({
        next: () => this.emit(req, method, path, start, 200),
        error: (e) => this.emit(req, method, path, start, e?.status ?? 500),
      }),
    );
  }

  private emit(req: any, method: string, path: string, start: number, statusCode: number): void {
    try {
      const { accion, recurso } = describe(method, path);
      // Vista legible para el monitoreo, p. ej. "Eliminó Pago" / "Creó Propietario".
      const vista = `${accion} ${recurso}`;
      const usuario =
        req?.user?.uid || req?.user?.username || req?.body?.usuario || req?.body?.username || 'anonimo';
      const conjunto =
        req?.user?.conjunto || req?.body?.conjunto || req?.query?.conjunto || undefined;

      this.activity.log({
        vista,
        usuario: String(usuario),
        conjunto: conjunto ? String(conjunto) : undefined,
        detalle: {
          accion,
          recurso,
          metodo: method,
          endpoint: path,
          id: req?.params?.id ?? req?.params?.usuario ?? undefined,
          params: req?.params ?? {},
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

/**
 * Rutas auditadas por el frontend con evidencia (captura) para evitar un log
 * duplicado del interceptor. Hoy: pagos (crear/editar/eliminar/revisar) y la
 * subida de la propia captura a Drive.
 */
function isSelfAudited(path: string): boolean {
  const seg = path.split('/').filter(Boolean)[0] || '';
  return seg === 'payments' || seg === 'drive';
}

/** Verbo de acción legible según el método HTTP. */
function accionDeMetodo(method: string): string {
  switch (method) {
    case 'POST': return 'Creó';
    case 'PUT':
    case 'PATCH': return 'Editó';
    case 'DELETE': return 'Eliminó';
    default: return 'Acción';
  }
}

/** Nombre de recurso legible a partir del primer segmento de la ruta. */
const RESOURCE_LABELS: Record<string, string> = {
  payments: 'Pago',
  users: 'Usuario',
  properties: 'Conjunto',
  zones: 'Zona común',
  reservations: 'Reserva',
  roles: 'Rol',
  reports: 'Reporte',
  events: 'Evento',
  agreements: 'Acuerdo',
  guests: 'Invitado',
  profile: 'Perfil',
  drive: 'Archivo',
  notifications: 'Notificación',
  auth: 'Autenticación',
};

function recursoDeRuta(path: string): string {
  const seg = path.split('/').filter(Boolean)[0] || '';
  return RESOURCE_LABELS[seg] || (seg ? seg.charAt(0).toUpperCase() + seg.slice(1) : 'Recurso');
}

/**
 * Sub-rutas POST que NO son "crear un registro" sino acciones/consultas con
 * una etiqueta propia más clara. La clave es el último segmento de la ruta.
 */
const ACTION_OVERRIDES: Record<string, { accion: string; recurso: string }> = {
  import: { accion: 'Importó', recurso: 'por carga masiva' },
  review: { accion: 'Revisó', recurso: 'Pago' },
  'duplicates/validate': { accion: 'Validó', recurso: 'Pago duplicado' },
  preference: { accion: 'Generó', recurso: 'link de pago' },
  'analyze-receipt': { accion: 'Analizó', recurso: 'comprobante' },
  'finance-chat': { accion: 'Consultó', recurso: 'IA financiera' },
};

function describe(method: string, path: string): { accion: string; recurso: string } {
  const segs = path.split('/').filter(Boolean);
  // Detecta sub-rutas de acción (p. ej. payments/review, payments/import).
  const sub1 = segs.slice(1).join('/'); // todo tras el recurso
  const subLast = segs[segs.length - 1] || '';
  const override = ACTION_OVERRIDES[sub1] || ACTION_OVERRIDES[subLast];
  if (method === 'POST' && override) return override;

  return { accion: accionDeMetodo(method), recurso: recursoDeRuta(path) };
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
