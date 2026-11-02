import { Module } from '@nestjs/common';
import { FirebaseModule } from '../firebase/firebase.module';
import { CommunityReportsService } from './community-reports.service';
import { CommunityReportsController } from './community-reports.controller';

@Module({
  imports: [FirebaseModule],
  controllers: [CommunityReportsController],
  providers: [CommunityReportsService],
  exports: [CommunityReportsService],
})
export class CommunityReportsModule {}
