import { Module } from '@nestjs/common';
import { FirebaseModule } from '../firebase/firebase.module';
import { EventsService } from './events.service';
import { EventsController } from './events.controller';

@Module({
  imports: [FirebaseModule],
  controllers: [EventsController],
  providers: [EventsService],
  exports: [EventsService],
})
export class EventsModule {}
