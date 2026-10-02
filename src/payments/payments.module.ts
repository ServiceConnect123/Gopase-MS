import { Module } from '@nestjs/common';
import { FirebaseModule } from '../firebase/firebase.module';
import { PropertiesModule } from '../properties/properties.module';
import { ReportsModule } from '../reports/reports.module';
import { PaymentsService } from './payments.service';
import { PaymentsImportService } from './payments-import.service';
import { PaymentsController } from './payments.controller';

@Module({
  imports: [FirebaseModule, PropertiesModule, ReportsModule],
  controllers: [PaymentsController],
  providers: [PaymentsService, PaymentsImportService],
  exports: [PaymentsService],
})
export class PaymentsModule {}
