import {
  BadRequestException,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { SyncService, SyncCollection } from './sync.service';

const VALID_COLLECTIONS: SyncCollection[] = [
  'conjuntos',
  'usuarios',
  'pagos',
  'roles',
  'invitados',
  'eventos',
  'citofonia',
  'acuerdos',
  'zonas_comunes',
  'reservas',
  'reportes',
];

/**
 * Endpoints para disparar la sincronización Sheets -> RTDB.
 *
 * Protección opcional: si SYNC_TOKEN está configurada, se exige el header
 * `x-sync-token` con ese valor. Si no está configurada, los endpoints quedan
 * abiertos (útil solo en pruebas; configúrala en QA/PRD).
 */
@ApiTags('sync')
@Controller('sync')
export class SyncController {
  constructor(
    private readonly sync: SyncService,
    private readonly config: ConfigService,
  ) {}

  private assertAuthorized(token?: string): void {
    const expected = this.config.get<string>('SYNC_TOKEN', '');
    if (expected && token !== expected) {
      throw new UnauthorizedException('Token de sincronización inválido.');
    }
  }

  /** Estado del subsistema de sincronización. */
  @ApiOperation({
    summary: 'Estado del subsistema de sincronización',
    description: 'Devuelve las colecciones disponibles para sincronizar.',
  })
  @Get('status')
  status() {
    return { ok: true, collections: VALID_COLLECTIONS };
  }

  /** Sincroniza las tres colecciones. */
  @ApiOperation({
    summary: 'Sincroniza todas las colecciones',
    description:
      'Lee de Google Sheets y espeja conjuntos, pagos y usuarios al Realtime ' +
      'Database (nodo mirror/). Requiere el header x-sync-token si SYNC_TOKEN está configurado.',
  })
  @ApiSecurity('sync-token')
  @Post('run')
  async run(@Headers('x-sync-token') token?: string) {
    this.assertAuthorized(token);
    return this.sync.syncAll();
  }

  /** Sincroniza una sola colección: conjuntos | pagos | usuarios. */
  @ApiOperation({
    summary: 'Sincroniza una sola colección',
    description: 'Espeja al Realtime Database solo la colección indicada.',
  })
  @ApiParam({
    name: 'collection',
    enum: VALID_COLLECTIONS,
    description: 'Colección a sincronizar',
  })
  @ApiSecurity('sync-token')
  @Post('run/:collection')
  async runOne(
    @Param('collection') collection: string,
    @Headers('x-sync-token') token?: string,
  ) {
    this.assertAuthorized(token);
    if (!VALID_COLLECTIONS.includes(collection as SyncCollection)) {
      throw new BadRequestException(
        `Colección inválida '${collection}'. Válidas: ${VALID_COLLECTIONS.join(', ')}`,
      );
    }
    return this.sync.syncOne(collection as SyncCollection);
  }
}
