import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { PqrsService } from './pqrs.service';

/** CRUD + hilo de mensajes de PQRS contra Firebase (RTDB mirror/pqrs). */
@ApiTags('pqrs')
@Controller('pqrs')
export class PqrsController {
  constructor(private readonly pqrs: PqrsService) {}

  @ApiOperation({ summary: 'Lista de PQRS (opcionalmente por conjunto/nombre)' })
  @ApiQuery({ name: 'conjunto', required: false })
  @Get()
  async list(@Query('conjunto') conjunto?: string) {
    const data = await this.pqrs.list(conjunto || '');
    return { success: true, data };
  }

  @ApiOperation({ summary: 'Crear PQRS' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        conjunto: { type: 'string', description: 'nombre del conjunto' },
        creador: { type: 'string', description: 'username del creador' },
        creadorNombre: { type: 'string' },
        asunto: { type: 'string' },
        categoria: { type: 'string', enum: ['peticion', 'queja', 'reclamo', 'sugerencia'] },
        descripcion: { type: 'string' },
      },
      required: ['asunto', 'creador'],
    },
  })
  @Post()
  async create(@Body() body: any) {
    return this.pqrs.create(body);
  }

  @ApiOperation({ summary: 'Editar PQRS (asunto/categoría/descripción)' })
  @Put(':id')
  async update(@Param('id') id: string, @Body() body: any) {
    return this.pqrs.update(id, body);
  }

  @ApiOperation({ summary: 'Agregar un mensaje al hilo de la PQRS' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        autor: { type: 'string', description: 'username de quien escribe' },
        autorNombre: { type: 'string' },
        esAdmin: { type: 'boolean' },
        texto: { type: 'string' },
      },
      required: ['autor', 'texto'],
    },
  })
  @Post(':id/mensaje')
  async addMensaje(@Param('id') id: string, @Body() body: any) {
    return this.pqrs.addMensaje(id, body);
  }

  @ApiOperation({ summary: 'Cambiar el estado de la PQRS' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        estado: { type: 'string', enum: ['abierta', 'visto', 'en_curso', 'finalizada'] },
      },
      required: ['estado'],
    },
  })
  @Post(':id/estado')
  async setEstado(@Param('id') id: string, @Body() body: any) {
    return this.pqrs.setEstado(id, String(body?.estado ?? ''));
  }

  @ApiOperation({ summary: 'Marcar la PQRS como vista (solo si está abierta)' })
  @Post(':id/visto')
  async marcarVisto(@Param('id') id: string) {
    return this.pqrs.marcarVisto(id);
  }

  @ApiOperation({ summary: 'Eliminar PQRS' })
  @Delete(':id')
  async remove(@Param('id') id: string) {
    return this.pqrs.remove(id);
  }
}
