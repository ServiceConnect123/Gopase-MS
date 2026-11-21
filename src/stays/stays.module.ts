import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { FirebaseModule } from '../firebase/firebase.module';
import { WhatsappModule } from '../whatsapp/whatsapp.module';
import { StaysController } from './stays.controller';
import { StaysService } from './stays.service';

/** Estadías cortas (alquiler por días) con enlace temporal para el huésped. */
@Module({
  imports: [ConfigModule, FirebaseModule, WhatsappModule],
  controllers: [StaysController],
  providers: [StaysService],
  exports: [StaysService],
})
export class StaysModule {}
