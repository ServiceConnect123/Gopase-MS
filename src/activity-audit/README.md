# activity-audit

Módulo autónomo de **monitorización, auditoría de actividad y analítica de
sesiones**. Diseñado para extraerse como paquete NPM (`@tu-org/activity-audit`)
sin reescribir nada: el core no conoce NestJS ni Firebase.

## Pilares

1. **Auditoría de actividad** — `ActivityLogger.log()`: escritura asíncrona,
   no bloqueante y fail-safe. Estructura: `vista`, `usuario`, `detalle` (JSON),
   `evidenciaUrl?`, `timestamp`, `meta?`.
2. **Métricas de sesión** — `SessionTracker.trackLogin()`: contador atómico por
   usuario (`sesionesIniciadas`, `ultimoInicioSesion`, `primerInicioSesion`).
3. **Captura de pantalla desacoplada** — el backend solo recibe `evidenciaUrl`
   (ya subida a Storage) vía `POST /audit/activity`.

## Arquitectura (Ports & Adapters)

```
core/        casos de uso + puertos (ActivityStore, SessionStore). SIN deps.
adapters/    rtdb (Firebase RTDB) · memory (no-op para modo deshabilitado)
integrations/nest  DynamicModule + interceptor + controller
```

## Aislamiento (requisito clave)

La persistencia vive en un **proyecto Firebase SEPARADO** del transaccional.
`resolveAuditApp()` crea una `App` de firebase-admin **nombrada**
(`activity-audit`) con sus propias credenciales, por lo que nunca toca la App
por defecto ni la RTDB principal.

## Configuración (env del host)

```
AUDIT_FIREBASE_SERVICE_ACCOUNT=   # JSON de la service account del proyecto de auditoría
# o campos sueltos:
AUDIT_FIREBASE_PROJECT_ID=
AUDIT_FIREBASE_CLIENT_EMAIL=
AUDIT_FIREBASE_PRIVATE_KEY=
AUDIT_FIREBASE_DATABASE_URL=      # URL del RTDB del proyecto de auditoría (requerida)
```

Si faltan, el módulo arranca en **modo no-op**: la app funciona igual, sin
auditoría. Nunca cae por un fallo de este módulo (patrón fail-safe).

## Integración NestJS

```ts
// app.module.ts
ActivityAuditModule.forRoot({
  credentials: {
    serviceAccountJson: process.env.AUDIT_FIREBASE_SERVICE_ACCOUNT,
    databaseURL: process.env.AUDIT_FIREBASE_DATABASE_URL,
  },
});
// Interceptor global (audita cada request):
{ provide: APP_INTERCEPTOR, useClass: AuditInterceptor }
```

```ts
// Métrica de sesión en el login:
constructor(@Optional() @Inject(SESSION_TRACKER) private tracker?: SessionTracker) {}
// tras validar credenciales:
this.tracker?.trackLogin(uid);
```

## Endpoints

- `POST /audit/activity` — body `{ vista, usuario, detalle?, evidenciaUrl? }`.
- `GET /audit/sessions/:usuario` — resumen de sesiones del usuario.

## Datos en RTDB (proyecto de auditoría)

```
/activity_logs/{YYYY-MM-DD}/{pushId}   -> { vista, usuario, detalle, evidenciaUrl?, meta?, timestamp, timestampIso }
/session_summaries/{usuario}           -> { usuario, sesionesIniciadas, primerInicioSesion, ultimoInicioSesion }
```

## Extracción a NPM

El core y los adapters no importan nada del host. Para publicarlo: mover
`src/activity-audit/` a su repo, usar `index.ts` como entry, y declarar
`firebase-admin`, `@nestjs/common`, `rxjs` como `peerDependencies`.
