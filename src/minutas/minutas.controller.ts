import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { MinutasService } from './minutas.service';

@ApiTags('minutas')
@Controller('minutas')
export class MinutasController {
  constructor(private readonly minutas: MinutasService) {}

  // ===========================================================================
  // MINUTAS
  // ===========================================================================

  @ApiOperation({ summary: 'Minuta actualmente abierta del conjunto.' })
  @ApiQuery({ name: 'conjunto', required: true })
  @Get('activa')
  async getActiva(@Query('conjunto') conjunto: string) {
    const data = await this.minutas.getMinutaAbierta(conjunto || '');
    return { success: true, data: data ?? null };
  }

  @ApiOperation({ summary: 'Lista minutas del conjunto (cerradas + activa).' })
  @ApiQuery({ name: 'conjunto', required: true })
  @ApiQuery({ name: 'fecha', required: false, description: 'YYYY-MM-DD' })
  @ApiQuery({ name: 'estado', required: false, description: "'abierta' | 'cerrada'" })
  @ApiQuery({ name: 'limit', required: false })
  @Get()
  async list(
    @Query('conjunto') conjunto: string,
    @Query('fecha') fecha?: string,
    @Query('estado') estado?: string,
    @Query('limit') limit?: string,
  ) {
    return this.minutas.listMinutas({
      conjunto: conjunto || '',
      fecha: fecha || undefined,
      estado: estado || undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  @ApiOperation({ summary: 'Detalle de una minuta.' })
  @Get(':id')
  async getOne(@Param('id') id: string) {
    return this.minutas.getMinuta(id);
  }

  @ApiOperation({ summary: 'Abrir minuta (inicio de turno).' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        conjunto:            { type: 'string' },
        vigilante:           { type: 'string', description: 'Username' },
        vigilanteNombre:     { type: 'string' },
        turno:               { type: 'string', enum: ['Mañana', 'Noche', 'Personalizado'] },
        observacionInicial:  { type: 'string' },
      },
      required: ['conjunto', 'vigilante', 'vigilanteNombre', 'turno'],
    },
  })
  @Post()
  async abrir(@Body() body: any) {
    const { conjunto, vigilante, vigilanteNombre, turno, observacionInicial } = body || {};
    if (!conjunto || !vigilante || !turno) {
      return { success: false, message: 'conjunto, vigilante y turno son requeridos.' };
    }
    return this.minutas.abrirMinuta({ conjunto, vigilante, vigilanteNombre: vigilanteNombre || vigilante, turno, observacionInicial });
  }

  @ApiOperation({ summary: 'Cerrar minuta (fin de turno).' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        observacionCierre: { type: 'string' },
        cerradoPor:        { type: 'string' },
      },
      required: ['cerradoPor'],
    },
  })
  @Put(':id/cerrar')
  async cerrar(@Param('id') id: string, @Body() body: any) {
    return this.minutas.cerrarMinuta(id, {
      observacionCierre: body?.observacionCierre || '',
      cerradoPor: body?.cerradoPor || 'desconocido',
    });
  }

  @ApiOperation({ summary: 'Agregar novedad a la minuta activa.' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        tipo:          { type: 'string', enum: ['ingreso_persona','ingreso_vehiculo','paquete','ronda','incidente','otro'] },
        descripcion:   { type: 'string' },
        referencia:    { type: 'string' },
        unidad:        { type: 'string' },
        imagenUrl:     { type: 'string' },
        registradoPor: { type: 'string' },
      },
      required: ['tipo', 'descripcion', 'registradoPor'],
    },
  })
  @Post(':id/novedades')
  async novedad(@Param('id') id: string, @Body() body: any) {
    if (!body?.tipo || !body?.descripcion) {
      return { success: false, message: 'tipo y descripcion son requeridos.' };
    }
    return this.minutas.agregarNovedad(id, {
      tipo: body.tipo,
      descripcion: body.descripcion,
      referencia: body.referencia || '',
      unidad: body.unidad || '',
      imagenUrl: body.imagenUrl || '',
      registradoPor: body.registradoPor || '',
    });
  }

  // ===========================================================================
  // TURNOS ASIGNADOS
  // ===========================================================================

  @ApiOperation({ summary: 'Lista turnos asignados del conjunto (próximos N días).' })
  @ApiQuery({ name: 'conjunto', required: true })
  @ApiQuery({ name: 'dias', required: false })
  @Get('turnos/lista')
  async listTurnos(
    @Query('conjunto') conjunto: string,
    @Query('dias') dias?: string,
  ) {
    return this.minutas.listTurnos(conjunto || '', dias ? parseInt(dias, 10) : 14);
  }

  @ApiOperation({ summary: 'Asignar turno (admin).' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        conjunto:           { type: 'string' },
        fecha:              { type: 'string', description: 'YYYY-MM-DD' },
        turno:              { type: 'string', enum: ['Mañana', 'Noche'] },
        vigilantes:         { type: 'array', items: { type: 'string' } },
        vigilantesNombres:  { type: 'array', items: { type: 'string' } },
        creadoPor:          { type: 'string' },
      },
      required: ['conjunto', 'fecha', 'turno', 'vigilantes', 'creadoPor'],
    },
  })
  @Post('turnos')
  async asignar(@Body() body: any) {
    const { conjunto, fecha, turno, vigilantes, vigilantesNombres, creadoPor } = body || {};
    if (!conjunto || !fecha || !turno || !vigilantes?.length) {
      return { success: false, message: 'conjunto, fecha, turno y vigilantes son requeridos.' };
    }
    return this.minutas.asignarTurno({
      conjunto, fecha, turno, vigilantes, creadoPor: creadoPor || '',
      vigilantesNombres: vigilantesNombres || vigilantes,
    });
  }

  @ApiOperation({ summary: 'Eliminar un turno asignado.' })
  @Delete('turnos/:id')
  async eliminarTurno(@Param('id') id: string) {
    return this.minutas.eliminarTurno(id);
  }
}
