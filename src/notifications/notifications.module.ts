import { Module } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { NotificationsController } from './notifications.controller';
import { PendingPaymentsRepository } from './pending-payments.repository';
import { WspQueueService } from './wsp-queue.service';
import { FirebaseModule } from '../firebase/firebase.module';
import { AuthModule } from '../auth/auth.module';
import { PaymentsModule } from '../payments/payments.module';
import { WhatsappModule } from '../whatsapp/whatsapp.module';

@Module({
  imports: [FirebaseModule, AuthModule, WhatsappModule, PaymentsModule],
  controllers: [NotificationsController],
  providers: [NotificationsService, PendingPaymentsRepository, WspQueueService],
})
export class NotificationsModule {}
