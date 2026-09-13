import { Module } from '@nestjs/common';
import { FirebaseModule } from '../firebase/firebase.module';
import { DriveService } from './drive.service';
import { DriveController } from './drive.controller';

@Module({
  imports: [FirebaseModule],
  controllers: [DriveController],
  providers: [DriveService],
  exports: [DriveService],
})
export class DriveModule {}
