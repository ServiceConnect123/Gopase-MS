import { Module } from '@nestjs/common';
import { FirebaseModule } from '../firebase/firebase.module';
import { BenefitsService } from './benefits.service';
import { BenefitsController } from './benefits.controller';

/**
 * Beneficios globales (descuentos/estímulos). Vive junto a los acuerdos de pago
 * porque ambos módulos componen la vista /app/agreements, pero su scope es
 * distinto: los beneficios aplican a toda la comunidad, los acuerdos son
 * compromisos individuales por propietario.
 */
@Module({
  imports: [FirebaseModule],
  controllers: [BenefitsController],
  providers: [BenefitsService],
  exports: [BenefitsService],
})
export class BenefitsModule {}
