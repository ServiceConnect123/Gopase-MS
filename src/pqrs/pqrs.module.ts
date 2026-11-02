import { Module } from '@nestjs/common';
import { FirebaseModule } from '../firebase/firebase.module';
import { PqrsService } from './pqrs.service';
import { PqrsController } from './pqrs.controller';

@Module({
  imports: [FirebaseModule],
  controllers: [PqrsController],
  providers: [PqrsService],
  exports: [PqrsService],
})
export class PqrsModule {}
