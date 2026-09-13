import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { ReservationsService } from './reservations.service';

/** CRUD de reservas de zonas comunes contra Firebase (RTDB). Reemplaza Sheets. */
@ApiTags('reservations')
@Controller('reservations')
export class ReservationsController {
  constructor(private readonly reservations: ReservationsService) {}

  @ApiOperation({ summary: 'Lista de reservas (por conjunto y/o usuario)' })
  @ApiQuery({ name: 'conjunto', required: false })
  @ApiQuery({ name: 'usuario', required: false })
  @Get()
  async list(@Query('conjunto') conjunto?: string, @Query('usuario') usuario?: string) {
    const data = await this.reservations.list({ conjunto: conjunto || '', usuario: usuario || '' });
    return { success: true, data };
  }

  @ApiOperation({ summary: 'Crear reserva' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        conjunto: { type: 'string' },
        zonaId: { type: 'string' },
        zonaNombre: { type: 'string' },
        usuario: { type: 'string' },
        fecha: { type: 'string' },
        horas: { type: 'array', items: { type: 'number' } },
        costo: { type: 'number' },
        estado: { type: 'string' },
        pagoId: { type: 'string' },
        comprobanteUrl: { type: 'string' },
        fechaAprobacion: { type: 'string' },
      },
      required: ['zonaId', 'usuario', 'fecha'],
    },
  })
  @Post()
  async create(@Body() body: any) {
    return this.reservations.create(body);
  }

  @ApiOperation({ summary: 'Editar reserva (reescribe la reserva)' })
  @Put(':id')
  async update(@Param('id') id: string, @Body() body: any) {
    return this.reservations.update(id, body);
  }

  @ApiOperation({ summary: 'Eliminar reserva' })
  @Delete(':id')
  async remove(@Param('id') id: string) {
    return this.reservations.remove(id);
  }
}
