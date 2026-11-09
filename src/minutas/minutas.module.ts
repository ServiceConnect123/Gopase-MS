import { Module } from '@nestjs/common';
import { FirebaseModule } from '../firebase/firebase.module';
import { MinutasService } from './minutas.service';
import { MinutasController } from './minutas.controller';

@Module({
  imports: [FirebaseModule],
  controllers: [MinutasController],
  providers: [MinutasService],
  exports: [MinutasService],
})
export class MinutasModule {}
