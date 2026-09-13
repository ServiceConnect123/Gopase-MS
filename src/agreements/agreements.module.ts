import { Module } from '@nestjs/common';
import { FirebaseModule } from '../firebase/firebase.module';
import { SheetsModule } from '../sheets/sheets.module';
import { AgreementsService } from './agreements.service';
import { AgreementsController } from './agreements.controller';

@Module({
  imports: [FirebaseModule, SheetsModule],
  controllers: [AgreementsController],
  providers: [AgreementsService],
  exports: [AgreementsService],
})
export class AgreementsModule {}
