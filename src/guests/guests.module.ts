import { Module } from '@nestjs/common';
import { FirebaseModule } from '../firebase/firebase.module';
import { GuestsService } from './guests.service';
import { GuestsController } from './guests.controller';

@Module({
  imports: [FirebaseModule],
  controllers: [GuestsController],
  providers: [GuestsService],
  exports: [GuestsService],
})
export class GuestsModule {}
