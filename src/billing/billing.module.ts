import { Module } from '@nestjs/common';
import { FirebaseModule } from '../firebase/firebase.module';
import { PlansModule } from '../plans/plans.module';
import { BillingService } from './billing.service';
import { BillingController } from './billing.controller';
import { EpaycoService } from './epayco.service';
import { AppConfigService } from './app-config.service';

@Module({
  imports: [FirebaseModule, PlansModule],
  controllers: [BillingController],
  providers: [BillingService, EpaycoService, AppConfigService],
  exports: [BillingService, EpaycoService, AppConfigService],
})
export class BillingModule {}
