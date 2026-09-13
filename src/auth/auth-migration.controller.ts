import {
  Controller,
  Get,
  Headers,
  Post,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { AuthMigrationService } from './auth-migration.service';

/**
 * Endpoints para migrar usuarios de Sheets a Firebase Auth (estrategia A1).
 * Protección opcional por header `x-sync-token` (reusa SYNC_TOKEN).
 */
@ApiTags('auth')
@Controller('auth')
export class AuthMigrationController {
  constructor(
    private readonly migration: AuthMigrationService,
    private readonly config: ConfigService,
  ) {}

  private assertAuthorized(token?: string): void {
    const expected = this.config.get<string>('SYNC_TOKEN', '');
    if (expected && token !== expected) {
      throw new UnauthorizedException('Token inválido.');
    }
  }

  @ApiOperation({ summary: 'Estado del subsistema de migración de Auth' })
  @Get('status')
  status() {
    return { ok: true };
  }

  @ApiOperation({
    summary: 'Migra usuarios de Sheets a Firebase Auth (A1)',
    description:
      'Crea/actualiza en Firebase Auth cada usuario con uid=username, email ' +
      'sintético y su contraseña actual descifrada, más custom claims rol/conjuntoId. ' +
      'Usa ?dryRun=true para simular sin escribir.',
  })
  @ApiQuery({ name: 'dryRun', required: false, type: Boolean })
  @ApiSecurity('sync-token')
  @Post('migrate')
  async migrate(
    @Headers('x-sync-token') token?: string,
    @Query('dryRun') dryRun?: string,
  ) {
    this.assertAuthorized(token);
    return this.migration.migrateAll(dryRun === 'true');
  }
}
