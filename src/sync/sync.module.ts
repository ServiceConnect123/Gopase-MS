import { Module } from '@nestjs/common';
import { SheetsModule } from '../sheets/sheets.module';
import { FirebaseModule } from '../firebase/firebase.module';
import { SyncService } from './sync.service';
import { SyncController } from './sync.controller';

@Module({
  imports: [SheetsModule, FirebaseModule],
  controllers: [SyncController],
  providers: [SyncService],
  exports: [SyncService],
})
export class SyncModule {}
