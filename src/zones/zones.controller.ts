import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { ZonesService } from './zones.service';

/** CRUD de zonas comunes contra Firebase (RTDB). Reemplaza Sheets. */
@ApiTags('zones')
@Controller('zones')
export class ZonesController {
  constructor(private readonly zones: ZonesService) {}

  @ApiOperation({ summary: 'Lista de zonas comunes (opcionalmente por conjunto)' })
  @ApiQuery({ name: 'conjunto', required: false })
  @Get()
  async list(@Query('conjunto') conjunto?: string) {
    const data = await this.zones.list(conjunto || '');
    return { success: true, data };
  }

  @ApiOperation({ summary: 'Crear zona común' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        conjunto: { type: 'string' },
        nombre: { type: 'string' },
        esPago: { type: 'boolean' },
        precioHora: { type: 'number' },
        horaApertura: { type: 'number' },
        horaCierre: { type: 'number' },
        activo: { type: 'boolean' },
      },
      required: ['nombre'],
    },
  })
  @Post()
  async create(@Body() body: any) {
    return this.zones.create(body);
  }

  @ApiOperation({ summary: 'Editar zona común (reescribe la zona)' })
  @Put(':id')
  async update(@Param('id') id: string, @Body() body: any) {
    return this.zones.update(id, body);
  }

  @ApiOperation({ summary: 'Eliminar zona común' })
  @Delete(':id')
  async remove(@Param('id') id: string) {
    return this.zones.remove(id);
  }
}
