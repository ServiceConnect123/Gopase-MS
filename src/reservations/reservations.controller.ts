import { Body, Controller, Delete, ForbiddenException, Get, Optional, Param, Post, Put, Query, Req } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { ReservationsService } from './reservations.service';
import { FirebaseService } from '../firebase/firebase.service';
import { esInquilino, estadoInquilino } from '../tenants/tenant-rules';

/** CRUD de reservas de zonas comunes contra Firebase (RTDB). Reemplaza Sheets. */
@ApiTags('reservations')
@Controller('reservations')
export class ReservationsController {
  constructor(
    private readonly reservations: ReservationsService,
    @Optional() private readonly firebase?: FirebaseService,
  ) {}

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
  async create(@Body() body: any, @Req() req: any) {
    // Arrendatario: solo reserva si el propietario se lo permitió y su arriendo está vigente.
    if (esInquilino(req?.user?.rol) && this.firebase?.isEnabled()) {
      const usuarios = (await this.firebase.liveVal<Record<string, any>>('mirror/usuarios')) || {};
      const yo = usuarios[String(req.user.sub || '').replace(/[.#$/\[\]]/g, '_')];
      const d = yo?.inquilino || {};
      if (estadoInquilino(d) !== 'activo' || d.puedeReservar !== true) {
        throw new ForbiddenException('El propietario no te ha habilitado para reservar zonas comunes.');
      }
    }
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
