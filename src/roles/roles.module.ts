import { Module } from '@nestjs/common';
import { FirebaseModule } from '../firebase/firebase.module';
import { PlansModule } from '../plans/plans.module';
import { RolesService } from './roles.service';
import { RolesController } from './roles.controller';

@Module({
  imports: [FirebaseModule, PlansModule],
  controllers: [RolesController],
  providers: [RolesService],
  exports: [RolesService],
})
export class RolesModule {}
