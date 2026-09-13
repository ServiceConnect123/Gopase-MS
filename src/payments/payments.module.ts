import { Module } from '@nestjs/common';
import { FirebaseModule } from '../firebase/firebase.module';
import { PropertiesModule } from '../properties/properties.module';
import { PaymentsService } from './payments.service';
import { PaymentsController } from './payments.controller';

@Module({
  imports: [FirebaseModule, PropertiesModule],
  controllers: [PaymentsController],
  providers: [PaymentsService],
  exports: [PaymentsService],
})
export class PaymentsModule {}
