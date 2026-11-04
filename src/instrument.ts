// ==========================================
// Sentry · inicialización (DEBE importarse PRIMERO en main.ts)
// ==========================================
// - Sin SENTRY_DSN no se inicializa nada (modo no-op, igual que activity-audit).
// - Nunca se envían cuerpos de request, cookies ni credenciales: los payloads de
//   goPase pueden llevar datos de pagos / personales (y viajan cifrados).
// - El muestreo de trazas es bajo (10%) para cuidar la cuota.
import * as Sentry from '@sentry/nestjs';

/** Headers que jamás deben salir hacia Sentry. */
const SENSITIVE_HEADERS = [
  'authorization',
  'cookie',
  'set-cookie',
  'x-enc',
  'x-api-key',
  'x-sync-token',
];

/** Quita del evento todo lo sensible (cuerpo, cookies, headers de auth, IP). */
function scrub<T extends { request?: any; user?: any }>(event: T): T {
  if (event.request) {
    delete event.request.data;
    delete event.request.cookies;
    delete event.request.query_string;
    const headers = event.request.headers;
    if (headers && typeof headers === 'object') {
      for (const key of Object.keys(headers)) {
        if (SENSITIVE_HEADERS.includes(key.toLowerCase())) delete headers[key];
      }
    }
  }
  if (event.user) {
    // Solo identificadores; sin email, IP ni teléfono.
    const { id, username } = event.user as { id?: string; username?: string };
    event.user = { id, username } as any;
  }
  return event;
}

const dsn = (process.env.SENTRY_DSN || '').trim();

if (dsn) {
  const rate = Number(process.env.SENTRY_TRACES_SAMPLE_RATE);
  Sentry.init({
    dsn,
    // 'qa' / 'production': se define por servicio (SENTRY_ENVIRONMENT).
    environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'production',
    release: process.env.SENTRY_RELEASE || process.env.RENDER_GIT_COMMIT || undefined,
    tracesSampleRate: Number.isFinite(rate) && rate >= 0 && rate <= 1 ? rate : 0.1,
    // main.ts ya maneja uncaughtException para mantener vivo el proceso
    // (reconexión de WhatsApp): Sentry reporta pero NO debe cerrar el proceso.
    integrations: [
      Sentry.onUncaughtExceptionIntegration({ exitEvenIfOtherHandlersAreRegistered: false }),
    ],
    // 'static' para que beforeSendTransaction (scrub) se aplique a las trazas.
    traceLifecycle: 'static',
    beforeSend: (event) => scrub(event),
    beforeSendTransaction: (event) => scrub(event),
  });
}
