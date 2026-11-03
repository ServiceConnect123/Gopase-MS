import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  Post,
  Put,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBody, ApiOperation, ApiQuery, ApiSecurity, ApiTags } from '@nestjs/swagger';
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

  @ApiOperation({ summary: 'Días de gracia de la cuota de los propietarios de un conjunto (por nombre o id)' })
  @Get('owner-grace')
  async getOwnerGrace(@Query('conjunto') conjunto: string) {
    const dias = await this.properties.getDiasGraciaPropietario(conjunto || '', 10);
    return { success: true, conjunto: conjunto || '', diasGraciaPropietario: dias };
  }

  @ApiOperation({ summary: 'Configurar días de gracia de la cuota de los propietarios (admin del conjunto)' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        conjunto: { type: 'string', description: 'nombre o id del conjunto' },
        diasGraciaPropietario: { type: 'number', example: 10 },
      },
      required: ['conjunto', 'diasGraciaPropietario'],
    },
  })
  @Put('owner-grace')
  async setOwnerGrace(@Body() body: { conjunto: string; diasGraciaPropietario: number }) {
    return this.properties.setDiasGraciaPropietario(body?.conjunto || '', Number(body?.diasGraciaPropietario));
  }

  @ApiOperation({ summary: 'Config del conjunto para el admin (por nombre; sin claves sensibles)' })
  @ApiQuery({ name: 'conjunto', required: true })
  @Get('admin-config')
  async getAdminConfig(@Query('conjunto') conjunto: string) {
    const data = await this.properties.getAdminConfig(conjunto || '');
    return { success: !!data, data };
  }

  @ApiOperation({ summary: 'Guardar config del conjunto (admin; solo campos no sensibles)' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        conjunto: { type: 'string', description: 'nombre o id del conjunto' },
        descripcion: { type: 'string' },
        direccion: { type: 'string' },
        pais: { type: 'string' },
        departamento: { type: 'string' },
        ciudad: { type: 'string' },
        cuotaMonto: { type: 'string' },
        moneda: { type: 'string' },
        llaveBreB: { type: 'string' },
        adminUsuario: { type: 'string' },
        adminNombre: { type: 'string' },
        adminWhatsapp: { type: 'string' },
        notifActivo: { type: 'string' },
      },
      required: ['conjunto'],
    },
  })
  @Put('admin-config')
  async updateAdminConfig(@Body() body: any) {
    return this.properties.updateAdminConfig(body?.conjunto || '', body);
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
        diasGraciaPropietario: { type: 'number', description: 'días de gracia de la cuota de propietarios (0..28)' },
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
