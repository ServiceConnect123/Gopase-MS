import { Module } from '@nestjs/common';
import { FirebaseModule } from '../firebase/firebase.module';
import { FundsService } from './funds.service';
import { FundsController } from './funds.controller';

@Module({
  imports: [FirebaseModule],
  controllers: [FundsController],
  providers: [FundsService],
  exports: [FundsService],
})
export class FundsModule {}
