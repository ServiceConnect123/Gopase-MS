import { Module } from '@nestjs/common';
import { FirebaseModule } from '../firebase/firebase.module';
import { AgreementsService } from './agreements.service';
import { AgreementsController } from './agreements.controller';
import { BenefitsService } from './benefits.service';
import { BenefitsController } from './benefits.controller';

@Module({
  imports: [FirebaseModule],
  controllers: [AgreementsController, BenefitsController],
  providers: [AgreementsService, BenefitsService],
  exports: [AgreementsService, BenefitsService],
})
export class AgreementsModule {}
