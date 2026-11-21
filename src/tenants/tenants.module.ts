import { Module } from '@nestjs/common';
import { FirebaseModule } from '../firebase/firebase.module';
import { UsersModule } from '../users/users.module';
import { TenantsController } from './tenants.controller';
import { TenantsService } from './tenants.service';

/** Arrendatarios (rol "inquilino") que el propietario registra para su unidad. */
@Module({
  imports: [FirebaseModule, UsersModule],
  controllers: [TenantsController],
  providers: [TenantsService],
  exports: [TenantsService],
})
export class TenantsModule {}
