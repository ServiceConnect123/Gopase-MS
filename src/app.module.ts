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

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
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
  ],
})
export class AppModule {}
