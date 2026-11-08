import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { FirebaseModule } from '../firebase/firebase.module';
import { WhatsappModule } from '../whatsapp/whatsapp.module';
import { UsersService } from './users.service';
import { UsersImportService } from './users-import.service';
import { UsersInviteService } from './users-invite.service';
import { UsersController } from './users.controller';

@Module({
  imports: [
    FirebaseModule,
    WhatsappModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_SECRET', 'gopase-secret'),
        signOptions: { expiresIn: '30d' },
      }),
    }),
  ],
  controllers: [UsersController],
  providers: [UsersService, UsersImportService, UsersInviteService],
  exports: [UsersService, UsersInviteService],
})
export class UsersModule {}
