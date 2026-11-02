import { Module } from '@nestjs/common';
import { FirebaseModule } from '../firebase/firebase.module';
import { PlansService } from './plans.service';
import { PlansController } from './plans.controller';

@Module({
  imports: [FirebaseModule],
  controllers: [PlansController],
  providers: [PlansService],
  exports: [PlansService],
})
export class PlansModule {}
