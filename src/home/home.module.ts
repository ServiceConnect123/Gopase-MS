import { Module } from '@nestjs/common';
import { SheetsModule } from '../sheets/sheets.module';
import { PaymentsModule } from '../payments/payments.module';
import { HomeService } from './home.service';
import { HomeController } from './home.controller';

@Module({
  imports: [SheetsModule, PaymentsModule],
  controllers: [HomeController],
  providers: [HomeService],
  exports: [HomeService],
})
export class HomeModule {}
