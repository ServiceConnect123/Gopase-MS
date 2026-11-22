import { Module } from '@nestjs/common';
import { FirebaseModule } from '../firebase/firebase.module';
import { DriveModule } from '../drive/drive.module';
import { NoticiasModule } from '../noticias/noticias.module';
import { AvisosService } from './avisos.service';
import { AvisosController } from './avisos.controller';

@Module({
  imports: [FirebaseModule, DriveModule, NoticiasModule],
  controllers: [AvisosController],
  providers: [AvisosService],
})
export class AvisosModule {}
