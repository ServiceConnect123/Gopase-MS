import { Module } from '@nestjs/common';
import { FirebaseModule } from '../firebase/firebase.module';
import { ReportsService } from './reports.service';
import { ReportsController } from './reports.controller';
import { FinanceImportService } from './finance-import.service';

@Module({
  imports: [FirebaseModule],
  controllers: [ReportsController],
  providers: [ReportsService, FinanceImportService],
  exports: [ReportsService],
})
export class ReportsModule {}
