import { Module } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { NotificationsController } from './notifications.controller';
import { PendingPaymentsRepository } from './pending-payments.repository';
import { SheetsModule } from '../sheets/sheets.module';
import { WhatsappModule } from '../whatsapp/whatsapp.module';

@Module({
  imports: [SheetsModule, WhatsappModule],
  controllers: [NotificationsController],
  providers: [NotificationsService, PendingPaymentsRepository],
})
export class NotificationsModule {}
