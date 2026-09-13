import { Body, Controller, Delete, Get, Param, Post, Put } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PropertiesService } from './properties.service';

/**
 * CRUD de propiedades (conjuntos) contra Firebase. El listado NO expone claves
 * sensibles (mercadoPagoKey/geminiKey); solo flags booleanos y la llaveBreB.
 */
@ApiTags('properties')
@Controller('properties')
export class PropertiesController {
  constructor(private readonly properties: PropertiesService) {}

  @ApiOperation({ summary: 'Lista de propiedades (sin claves sensibles; con flags hasMercadoPago/hasBreB)' })
  @Get()
  async list() {
    const data = await this.properties.listPublic();
    return { success: true, data };
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
