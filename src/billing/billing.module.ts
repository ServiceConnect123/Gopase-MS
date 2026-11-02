import { Module } from '@nestjs/common';
import { FirebaseModule } from '../firebase/firebase.module';
import { BillingService } from './billing.service';
import { BillingController } from './billing.controller';

@Module({
  imports: [FirebaseModule],
  controllers: [BillingController],
  providers: [BillingService],
  exports: [BillingService],
})
export class BillingModule {}
