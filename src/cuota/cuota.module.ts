import { Module } from '@nestjs/common';
import { FirebaseModule } from '../firebase/firebase.module';
import { CuotaController } from './cuota.controller';
import { CuotaService } from './cuota.service';

/** Cuota de administración: tarifas por unidad y métodos de recaudo. */
@Module({
  imports: [FirebaseModule],
  controllers: [CuotaController],
  providers: [CuotaService],
  exports: [CuotaService],
})
export class CuotaModule {}
