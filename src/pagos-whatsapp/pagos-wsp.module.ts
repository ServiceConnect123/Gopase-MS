import { Module } from '@nestjs/common';
import { FirebaseModule } from '../firebase/firebase.module';
import { PaymentsModule } from '../payments/payments.module';
import { DriveModule } from '../drive/drive.module';
import { PropertiesModule } from '../properties/properties.module';
import { WhatsappModule } from '../whatsapp/whatsapp.module';
import { PagosWspService } from './pagos-wsp.service';
import { PagosWspController } from './pagos-wsp.controller';

@Module({
  imports: [FirebaseModule, PaymentsModule, DriveModule, PropertiesModule, WhatsappModule],
  controllers: [PagosWspController],
  providers: [PagosWspService],
})
export class PagosWspModule {}
