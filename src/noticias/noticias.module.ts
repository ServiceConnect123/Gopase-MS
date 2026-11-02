import { Module } from '@nestjs/common';
import { FirebaseModule } from '../firebase/firebase.module';
import { NoticiasService } from './noticias.service';
import { NoticiasController } from './noticias.controller';

@Module({
  imports: [FirebaseModule],
  controllers: [NoticiasController],
  providers: [NoticiasService],
  exports: [NoticiasService],
})
export class NoticiasModule {}
