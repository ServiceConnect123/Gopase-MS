import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { EventsService } from './events.service';

/** CRUD de eventos contra Firebase (RTDB). Reemplaza Sheets. */
@ApiTags('events')
@Controller('events')
export class EventsController {
  constructor(private readonly events: EventsService) {}

  @ApiOperation({ summary: 'Lista de eventos (opcionalmente por conjunto/nombre)' })
  @ApiQuery({ name: 'conjunto', required: false })
  @Get()
  async list(@Query('conjunto') conjunto?: string) {
    const data = await this.events.list(conjunto || '');
    return { success: true, data };
  }

  @ApiOperation({ summary: 'Crear evento' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        titulo: { type: 'string' },
        descripcion: { type: 'string' },
        fecha: { type: 'string' },
        hora: { type: 'string' },
        lugar: { type: 'string' },
        conjunto: { type: 'string', description: 'nombre del conjunto' },
        creador: { type: 'string' },
      },
      required: ['titulo', 'fecha'],
    },
  })
  @Post()
  async create(@Body() body: any) {
    return this.events.create(body);
  }

  @ApiOperation({ summary: 'Editar evento' })
  @Put(':id')
  async update(@Param('id') id: string, @Body() body: any) {
    return this.events.update(id, body);
  }

  @ApiOperation({ summary: 'Eliminar evento' })
  @Delete(':id')
  async remove(@Param('id') id: string) {
    return this.events.remove(id);
  }
}
