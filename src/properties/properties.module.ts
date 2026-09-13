import { Module } from '@nestjs/common';
import { FirebaseModule } from '../firebase/firebase.module';
import { SheetsModule } from '../sheets/sheets.module';
import { PropertiesService } from './properties.service';
import { PropertiesController } from './properties.controller';

@Module({
  imports: [FirebaseModule, SheetsModule],
  controllers: [PropertiesController],
  providers: [PropertiesService],
  exports: [PropertiesService],
})
export class PropertiesModule {}
