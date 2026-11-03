import { Module } from '@nestjs/common';
import { FirebaseModule } from '../firebase/firebase.module';
import { TagsService } from './tags.service';
import { TagsController } from './tags.controller';

@Module({
  imports: [FirebaseModule],
  controllers: [TagsController],
  providers: [TagsService],
  exports: [TagsService],
})
export class TagsModule {}
