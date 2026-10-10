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
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ActivityAuditModule } from './activity-audit/integrations/nest/activity-audit.module';
import { AuditInterceptor } from './activity-audit/integrations/nest/audit.interceptor';

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
    // Audita cada request HTTP de forma no bloqueante (global).
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
  ],
})
export class AppModule {}
