import { Module } from '@nestjs/common';
import { FirebaseModule } from '../firebase/firebase.module';
import { ZonesService } from './zones.service';
import { ZonesController } from './zones.controller';

@Module({
  imports: [FirebaseModule],
  controllers: [ZonesController],
  providers: [ZonesService],
  exports: [ZonesService],
})
export class ZonesModule {}
