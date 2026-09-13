import {
  BadRequestException,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SyncService, SyncCollection } from './sync.service';

const VALID_COLLECTIONS: SyncCollection[] = ['conjuntos', 'pagos', 'usuarios'];

/**
 * Endpoints para disparar la sincronización Sheets -> RTDB.
 *
 * Protección opcional: si SYNC_TOKEN está configurada, se exige el header
 * `x-sync-token` con ese valor. Si no está configurada, los endpoints quedan
 * abiertos (útil solo en pruebas; configúrala en QA/PRD).
 */
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
  @Get('status')
  status() {
    return { ok: true, collections: VALID_COLLECTIONS };
  }

  /** Sincroniza las tres colecciones. */
  @Post('run')
  async run(@Headers('x-sync-token') token?: string) {
    this.assertAuthorized(token);
    return this.sync.syncAll();
  }

  /** Sincroniza una sola colección: conjuntos | pagos | usuarios. */
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
    switch (collection as SyncCollection) {
      case 'conjuntos':
        return this.sync.syncConjuntos();
      case 'pagos':
        return this.sync.syncPagos();
      case 'usuarios':
        return this.sync.syncUsuarios();
    }
  }
}
