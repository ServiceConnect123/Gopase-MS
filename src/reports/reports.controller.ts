import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { ReportsService } from './reports.service';

/** CRUD de reportes contra Firebase (RTDB). Reemplaza Sheets. */
@ApiTags('reports')
@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @ApiOperation({ summary: 'Lista de reportes (por conjunto y/o usuario)' })
  @ApiQuery({ name: 'conjunto', required: false })
  @ApiQuery({ name: 'usuario', required: false })
  @Get()
  async list(@Query('conjunto') conjunto?: string, @Query('usuario') usuario?: string) {
    const data = await this.reports.list({ conjunto: conjunto || '', usuario: usuario || '' });
    return { success: true, data };
  }

  @ApiOperation({ summary: 'Crear reporte' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        titulo: { type: 'string' },
        fecha: { type: 'string' },
        usuario: { type: 'string', description: 'autor (username)' },
        descripcion: { type: 'string' },
        conjunto: { type: 'string' },
        tipo: { type: 'string' },
        ubicacion: { type: 'string' },
        estado: { type: 'string' },
      },
      required: ['titulo'],
    },
  })
  @Post()
  async create(@Body() body: any) {
    return this.reports.create(body);
  }

  @ApiOperation({ summary: 'Editar reporte (merge de campos presentes)' })
  @Put(':id')
  async update(@Param('id') id: string, @Body() body: any) {
    return this.reports.update(id, body);
  }

  @ApiOperation({ summary: 'Eliminar reporte' })
  @Delete(':id')
  async remove(@Param('id') id: string) {
    return this.reports.remove(id);
  }
}
