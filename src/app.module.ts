import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { NotificationsModule } from './notifications/notifications.module';
import { SyncModule } from './sync/sync.module';
import { AuthModule } from './auth/auth.module';
import { HomeModule } from './home/home.module';
import { ProfileModule } from './profile/profile.module';
import { PaymentsModule } from './payments/payments.module';
import { DriveModule } from './drive/drive.module';
import { UsersModule } from './users/users.module';
import { PropertiesModule } from './properties/properties.module';
import { ZonesModule } from './zones/zones.module';
import { ReservationsModule } from './reservations/reservations.module';
import { RolesModule } from './roles/roles.module';
import { ReportsModule } from './reports/reports.module';
import { EventsModule } from './events/events.module';
import { AgreementsModule } from './agreements/agreements.module';
import { GuestsModule } from './guests/guests.module';
import { FundsModule } from './funds/funds.module';
import { PqrsModule } from './pqrs/pqrs.module';
import { CommunityReportsModule } from './community-reports/community-reports.module';
import { NoticiasModule } from './noticias/noticias.module';
import { BillingModule } from './billing/billing.module';
import { PlansModule } from './plans/plans.module';
import { TagsModule } from './tags/tags.module';
import { OnboardingModule } from './onboarding/onboarding.module';
import { MinutasModule } from './minutas/minutas.module';
import { APP_INTERCEPTOR, APP_GUARD, APP_FILTER } from '@nestjs/core';
import { SentryModule } from '@sentry/nestjs/setup';
import { AllErrorsSentryFilter } from './activity-audit/adapters/sentry/all-errors-sentry.filter';
import { ActivityAuditModule } from './activity-audit/integrations/nest/activity-audit.module';
import { AuditInterceptor } from './activity-audit/integrations/nest/audit.interceptor';
import { SentryErrorReporter } from './activity-audit/adapters/sentry/sentry-error-reporter';
import { SentryIssuesClient } from './activity-audit/adapters/sentry/sentry-issues.client';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { ReadOnlyGuard } from './auth/read-only.guard';
import { ConjuntoMembershipGuard } from './auth/conjunto-membership.guard';
import { FirebaseModule } from './firebase/firebase.module';
import { HealthController } from './health/health.controller';
import { ConfigWebController } from './config-web/config-web.controller';
import { PayloadCryptoInterceptor } from './common/payload-crypto.interceptor';

@Module({
  imports: [
    // Sentry (errores + trazas). Sin SENTRY_DSN queda inerte (ver instrument.ts).
    SentryModule.forRoot(),
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    // Auditoría y analítica de sesiones en un proyecto Firebase SEPARADO
    // (RTDB). Credenciales por env AUDIT_FIREBASE_*. Si faltan, arranca en
    // modo no-op (nunca rompe la app).
    ActivityAuditModule.forRoot({
      credentials: {
        serviceAccountJson: process.env.AUDIT_FIREBASE_SERVICE_ACCOUNT,
        projectId: process.env.AUDIT_FIREBASE_PROJECT_ID,
        clientEmail: process.env.AUDIT_FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.AUDIT_FIREBASE_PRIVATE_KEY,
        databaseURL: process.env.AUDIT_FIREBASE_DATABASE_URL,
      },
      // Entorno que etiqueta los registros. En QA se define AUDIT_ENV=qa; si no
      // se define, se asume 'prod' (más seguro: un log real no se confunde con prueba).
      environment: (process.env.AUDIT_ENV || 'prod').toLowerCase(),
      // No registrar actividad del ambiente QA ni del superAdmin en el monitoreo.
      // El superAdmin realiza operaciones técnicas sobre todos los conjuntos que
      // contaminarían el historial de actividad de cada uno. QA genera ruido de pruebas.
      skipAmbientes: ['qa'],
      skipUsuarios: ['superadmin'],
      // Cruza el monitoreo con Sentry (migas de pan + id del evento de error en
      // meta.errorEventId). Sin SENTRY_DSN queda inerte.
      errorReporter: new SentryErrorReporter(),
      // Lectura de errores técnicos para la pestaña "Errores" del monitoreo
      // (solo superAdmin). Requiere SENTRY_AUTH_TOKEN con scope event:read; sin
      // él el endpoint responde configured=false.
      issueSource: process.env.SENTRY_AUTH_TOKEN
        ? new SentryIssuesClient({
            token: process.env.SENTRY_AUTH_TOKEN,
            org: process.env.SENTRY_ORG || 'sconnectgroup',
            // Por defecto, backend + app (así el monitoreo muestra los issues de
            // ambos sin depender de la variable de entorno).
            projects: (process.env.SENTRY_ISSUE_PROJECTS || 'gopase-backend,gopase-app')
              .split(',')
              .map((p) => p.trim())
              .filter(Boolean),
            apiUrl: process.env.SENTRY_API_URL || undefined,
            webUrl: process.env.SENTRY_WEB_URL || undefined,
          })
        : undefined,
    }),
    NotificationsModule,
    SyncModule,
    AuthModule,
    HomeModule,
    ProfileModule,
    PaymentsModule,
    DriveModule,
    UsersModule,
    PropertiesModule,
    ZonesModule,
    ReservationsModule,
    RolesModule,
    ReportsModule,
    EventsModule,
    AgreementsModule,
    GuestsModule,
    FundsModule,
    PqrsModule,
    CommunityReportsModule,
    NoticiasModule,
    BillingModule,
    PlansModule,
    TagsModule,
    OnboardingModule,
    MinutasModule,
    // Necesario para que ConjuntoMembershipGuard (APP_GUARD) inyecte FirebaseService.
    FirebaseModule,
  ],
  controllers: [HealthController, ConfigWebController],
  providers: [
    // Reporta a Sentry TODO error: excepciones no controladas y también las
    // HttpException (4xx como warning, 5xx como error). Nest sigue respondiendo
    // igual que antes.
    { provide: APP_FILTER, useClass: AllErrorsSentryFilter },
    // Cifrado de payload (ofuscación). Va PRIMERO para descifrar el request
    // antes de que el AuditInterceptor lea el body, y cifrar la respuesta al
    // final. Controlado por PAYLOAD_ENCRYPTION_ENABLED (passthrough si off).
    { provide: APP_INTERCEPTOR, useClass: PayloadCryptoInterceptor },
    // Audita cada request HTTP de forma no bloqueante (global).
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
    // Guard global de autenticación por JWT. Controlado por AUTH_GUARD_ENABLED:
    // mientras no sea 'true', deja pasar todo (permite desplegar sin romper los
    // clientes que aún no envían el token).
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    // Después del JWT: si el conjunto está suspendido por pago, su admin queda en
    // solo lectura (bloquea POST/PUT/PATCH/DELETE, salvo /billing para pagar).
    { provide: APP_GUARD, useClass: ReadOnlyGuard },
    // Pertenencia: un usuario solo puede operar sobre conjuntos en su lista de
    // membresías (bloquea el acceso cruzado de un admin multi-conjunto).
    { provide: APP_GUARD, useClass: ConjuntoMembershipGuard },
  ],
})
export class AppModule {}
