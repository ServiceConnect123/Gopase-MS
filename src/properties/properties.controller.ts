import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  Post,
  Put,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBody, ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { PropertiesService } from './properties.service';

/**
 * CRUD de propiedades (conjuntos) contra Firebase (RTDB). El listado NO expone
 * claves sensibles (mercadoPagoKey/geminiKey); solo flags y la llaveBreB.
 * La configuración completa (con claves) se lee/escribe por los endpoints
 * /config, de uso administrativo (superAdmin).
 */
@ApiTags('properties')
@Controller('properties')
export class PropertiesController {
  constructor(
    private readonly properties: PropertiesService,
    private readonly config: ConfigService,
  ) {}

  private assertSyncToken(token?: string): void {
    const expected = this.config.get<string>('SYNC_TOKEN', '');
    if (expected && token !== expected) {
      throw new UnauthorizedException('Token de sincronización inválido.');
    }
  }

  @ApiOperation({ summary: 'Lista de propiedades (sin claves sensibles; con flags hasMercadoPago/hasBreB)' })
  @Get()
  async list() {
    const data = await this.properties.listPublic();
    return { success: true, data };
  }

  @ApiOperation({ summary: 'Configuración completa de un conjunto (superAdmin; incluye claves)' })
  @Get(':id/config')
  async getConfig(@Param('id') id: string) {
    const data = await this.properties.getConfig(id);
    return { success: !!data, data };
  }

  @ApiOperation({ summary: 'Crear propiedad (datos no sensibles)' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        nombre: { type: 'string' },
        direccion: { type: 'string' },
        tipo: { type: 'string' },
        descripcion: { type: 'string' },
        cuotaMonto: { type: 'string' },
        moneda: { type: 'string' },
        driveFolderId: { type: 'string' },
      },
      required: ['nombre'],
    },
  })
  @Post()
  async create(@Body() body: any) {
    return this.properties.create(body);
  }

  @ApiOperation({ summary: 'Migración one-time: secretos de Sheets -> RTDB (protegido)' })
  @ApiSecurity('sync-token')
  @Post('migrate-secrets')
  async migrateSecrets(@Headers('x-sync-token') token?: string) {
    this.assertSyncToken(token);
    return this.properties.migrateSecretsFromSheets();
  }

  @ApiOperation({ summary: 'Editar configuración completa del conjunto (superAdmin; datos + claves + notif)' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        nombre: { type: 'string' },
        direccion: { type: 'string' },
        tipo: { type: 'string' },
        descripcion: { type: 'string' },
        cuotaMonto: { type: 'string' },
        moneda: { type: 'string' },
        driveFolderId: { type: 'string' },
        llaveBreB: { type: 'string' },
        mercadoPagoKey: { type: 'string' },
        geminiKey: { type: 'string' },
        adminUsuario: { type: 'string' },
        adminNombre: { type: 'string' },
        adminWhatsapp: { type: 'string' },
        notifActivo: { type: 'string' },
      },
    },
  })
  @Put(':id/config')
  async updateConfig(@Param('id') id: string, @Body() body: any) {
    return this.properties.updateConfig(id, body);
  }

  @ApiOperation({ summary: 'Editar propiedad (datos no sensibles)' })
  @Put(':id')
  async update(@Param('id') id: string, @Body() body: any) {
    return this.properties.update(id, body);
  }

  @ApiOperation({ summary: 'Eliminar propiedad' })
  @Delete(':id')
  async remove(@Param('id') id: string) {
    return this.properties.remove(id);
  }
}
