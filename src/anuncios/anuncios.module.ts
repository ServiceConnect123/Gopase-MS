import { Module } from '@nestjs/common';
import { FirebaseModule } from '../firebase/firebase.module';
import { AnunciosService } from './anuncios.service';
import { AnunciosController } from './anuncios.controller';

@Module({
  imports: [FirebaseModule],
  controllers: [AnunciosController],
  providers: [AnunciosService],
  exports: [AnunciosService],
})
export class AnunciosModule {}
