import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { SheetsModule } from '../sheets/sheets.module';
import { FirebaseModule } from '../firebase/firebase.module';
import { AuthMigrationService } from './auth-migration.service';
import { AuthLoginService } from './auth-login.service';
import { AuthMigrationController } from './auth-migration.controller';

@Module({
  imports: [
    SheetsModule,
    FirebaseModule,
    // JWT propio de la app: firma los tokens de sesión que emite el login y los
    // verifica el guard. El secreto va por env (JWT_SECRET); expiración 30 días
    // (la app no tiene flujo de refresh y no queremos re-login frecuente).
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_SECRET', 'gopase-dev-secret-change-me'),
        // expiresIn admite formato de `ms` (p. ej. '30d'); el tipo del paquete
        // es estricto, por eso se castea el valor de env.
        signOptions: { expiresIn: config.get<string>('JWT_EXPIRES_IN', '30d') as any },
      }),
    }),
  ],
  controllers: [AuthMigrationController],
  providers: [AuthMigrationService, AuthLoginService],
  // Exporta JwtModule para que el guard global (en AppModule) pueda inyectar JwtService.
  exports: [AuthMigrationService, AuthLoginService, JwtModule],
})
export class AuthModule {}
