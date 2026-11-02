import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { CommunityReportsService } from './community-reports.service';

/**
 * Foro de reportes comunitarios (RTDB mirror/foro_reportes). Independiente de
 * /reports (que maneja finanzas/vigilancia sobre mirror/reportes).
 */
@ApiTags('community-reports')
@Controller('community-reports')
export class CommunityReportsController {
  constructor(private readonly foro: CommunityReportsService) {}

  @ApiOperation({ summary: 'Lista de reportes del foro (opcionalmente por conjunto)' })
  @ApiQuery({ name: 'conjunto', required: false })
  @Get()
  async list(@Query('conjunto') conjunto?: string) {
    const data = await this.foro.list(conjunto || '');
    return { success: true, data };
  }

  @ApiOperation({ summary: 'Crear reporte del foro' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        conjunto: { type: 'string', description: 'nombre del conjunto' },
        autor: { type: 'string', description: 'username del autor' },
        autorNombre: { type: 'string' },
        titulo: { type: 'string' },
        categoria: { type: 'string', description: 'categoría libre (ej: Camino enmontado)' },
        descripcion: { type: 'string' },
      },
      required: ['titulo', 'autor'],
    },
  })
  @Post()
  async create(@Body() body: any) {
    return this.foro.create(body);
  }

  @ApiOperation({ summary: 'Editar reporte del foro (título/categoría/descripción)' })
  @Put(':id')
  async update(@Param('id') id: string, @Body() body: any) {
    return this.foro.update(id, body);
  }

  @ApiOperation({ summary: 'Agregar una respuesta al hilo del reporte' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        autor: { type: 'string' },
        autorNombre: { type: 'string' },
        esAdmin: { type: 'boolean' },
        texto: { type: 'string' },
      },
      required: ['autor', 'texto'],
    },
  })
  @Post(':id/respuesta')
  async addRespuesta(@Param('id') id: string, @Body() body: any) {
    return this.foro.addRespuesta(id, body);
  }

  @ApiOperation({ summary: 'Cambiar el estado del reporte' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        estado: { type: 'string', enum: ['abierto', 'visto', 'en_curso', 'resuelto'] },
      },
      required: ['estado'],
    },
  })
  @Post(':id/estado')
  async setEstado(@Param('id') id: string, @Body() body: any) {
    return this.foro.setEstado(id, String(body?.estado ?? ''));
  }

  @ApiOperation({ summary: 'Marcar el reporte como visto (solo si está abierto)' })
  @Post(':id/visto')
  async marcarVisto(@Param('id') id: string) {
    return this.foro.marcarVisto(id);
  }

  @ApiOperation({ summary: 'Eliminar reporte del foro' })
  @Delete(':id')
  async remove(@Param('id') id: string) {
    return this.foro.remove(id);
  }
}
