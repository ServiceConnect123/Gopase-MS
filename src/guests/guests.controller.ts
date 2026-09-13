import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { GuestsService } from './guests.service';

/** CRUD de invitados (hoja 'vigilantes') contra Firebase (RTDB). Reemplaza Sheets. */
@ApiTags('guests')
@Controller('guests')
export class GuestsController {
  constructor(private readonly guests: GuestsService) {}

  @ApiOperation({ summary: 'Lista de invitados (opcionalmente por propietario/username)' })
  @ApiQuery({ name: 'propietario', required: false })
  @Get()
  async list(@Query('propietario') propietario?: string) {
    const data = await this.guests.list({ propietario: propietario || '' });
    return { success: true, data };
  }

  @ApiOperation({ summary: 'Registrar invitado' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        nombre: { type: 'string' },
        placa: { type: 'string' },
        fecha: { type: 'string' },
        propietario: { type: 'string', description: 'username del anfitrión' },
        parcela: { type: 'string' },
        estado: { type: 'string' },
        horaIngreso: { type: 'string' },
        nota: { type: 'string' },
      },
      required: ['nombre', 'fecha'],
    },
  })
  @Post()
  async create(@Body() body: any) {
    return this.guests.create(body);
  }

  @ApiOperation({ summary: 'Actualizar invitado (p. ej. marcar ingreso: estado + hora)' })
  @Put(':id')
  async update(@Param('id') id: string, @Body() body: any) {
    return this.guests.update(id, body);
  }

  @ApiOperation({ summary: 'Eliminar invitado' })
  @Delete(':id')
  async remove(@Param('id') id: string) {
    return this.guests.remove(id);
  }
}
