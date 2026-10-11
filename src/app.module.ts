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
import { APP_INTERCEPTOR, APP_GUARD } from '@nestjs/core';
import { ActivityAuditModule } from './activity-audit/integrations/nest/activity-audit.module';
import { AuditInterceptor } from './activity-audit/integrations/nest/audit.interceptor';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { PayloadCryptoInterceptor } from './common/payload-crypto.interceptor';

@Module({
  imports: [
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
  ],
  providers: [
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
  ],
})
export class AppModule {}
