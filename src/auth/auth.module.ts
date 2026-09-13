import { Module } from '@nestjs/common';
import { SheetsModule } from '../sheets/sheets.module';
import { FirebaseModule } from '../firebase/firebase.module';
import { AuthMigrationService } from './auth-migration.service';
import { AuthLoginService } from './auth-login.service';
import { AuthMigrationController } from './auth-migration.controller';

@Module({
  imports: [SheetsModule, FirebaseModule],
  controllers: [AuthMigrationController],
  providers: [AuthMigrationService, AuthLoginService],
  exports: [AuthMigrationService, AuthLoginService],
})
export class AuthModule {}
