import { Module } from '@nestjs/common';
import { FirebaseModule } from '../firebase/firebase.module';
import { UsersService } from './users.service';
import { UsersImportService } from './users-import.service';
import { UsersController } from './users.controller';

@Module({
  imports: [FirebaseModule],
  controllers: [UsersController],
  providers: [UsersService, UsersImportService],
  exports: [UsersService],
})
export class UsersModule {}
