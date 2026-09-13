import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { AgreementsService } from './agreements.service';

/**
 * CRUD de acuerdos contra Firebase (RTDB). Reemplaza Sheets.
 * Al crear, devuelve las suscripciones push de los afectados (leídas de la hoja
 * citofonia) para que el frontend envíe las notificaciones vía /api/send-push.
 */
@ApiTags('agreements')
@Controller('agreements')
export class AgreementsController {
  constructor(private readonly agreements: AgreementsService) {}

  @ApiOperation({ summary: 'Lista de acuerdos (opcionalmente filtrada por usuario)' })
  @ApiQuery({ name: 'usuario', required: false })
  @Get()
  async list(@Query('usuario') usuario?: string) {
    const data = await this.agreements.list({ usuario: usuario || '' });
    return { success: true, data };
  }

  @ApiOperation({ summary: 'Crear acuerdo (devuelve suscripciones push de afectados)' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        usuario: { type: 'string' },
        tipo: { type: 'string' },
        descripcion: { type: 'string' },
        monto: { type: 'string' },
        fechaInicio: { type: 'string' },
        fechaFin: { type: 'string' },
        estado: { type: 'string' },
        aplicaA: { type: 'string', description: "'todos' o username" },
        createdBy: { type: 'string' },
        createdAt: { type: 'string' },
      },
      required: ['descripcion', 'fechaFin'],
    },
  })
  @Post()
  async create(@Body() body: any) {
    return this.agreements.create(body);
  }

  @ApiOperation({ summary: 'Editar acuerdo' })
  @Put(':id')
  async update(@Param('id') id: string, @Body() body: any) {
    return this.agreements.update(id, body);
  }

  @ApiOperation({ summary: 'Eliminar acuerdo' })
  @Delete(':id')
  async remove(@Param('id') id: string) {
    return this.agreements.remove(id);
  }
}
