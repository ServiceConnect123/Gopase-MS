import { Module } from '@nestjs/common';
import { SheetsModule } from '../sheets/sheets.module';
import { FirebaseModule } from '../firebase/firebase.module';
import { AuthMigrationService } from './auth-migration.service';
import { AuthMigrationController } from './auth-migration.controller';

@Module({
  imports: [SheetsModule, FirebaseModule],
  controllers: [AuthMigrationController],
  providers: [AuthMigrationService],
  exports: [AuthMigrationService],
})
export class AuthModule {}
