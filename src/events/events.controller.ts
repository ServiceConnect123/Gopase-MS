import { Body, Controller, Delete, Get, Param, Post, Put, Query, Req } from '@nestjs/common';
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
        tipo: { type: 'string', enum: ['evento', 'votacion'], description: "Tipo (por defecto 'evento')" },
        titulo: { type: 'string' },
        descripcion: { type: 'string' },
        fecha: { type: 'string' },
        hora: { type: 'string' },
        lugar: { type: 'string' },
        conjunto: { type: 'string', description: 'nombre del conjunto' },
        creador: { type: 'string' },
        pregunta: { type: 'string', description: 'solo votación' },
        opciones: { type: 'array', description: 'solo votación: [{id,texto}]' },
        audiencia: { type: 'string', enum: ['todos', 'seleccion'], description: "Por defecto 'todos'" },
        invitados: { type: 'array', description: "Usernames invitados (si audiencia='seleccion')" },
        meetHabilitado: { type: 'boolean', description: 'Habilita la videollamada LiveKit' },
        meetModo: { type: 'string', enum: ['reunion', 'streaming'] },
        ponentes: { type: 'array', description: 'Usernames que pueden hablar/transmitir' },
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

  @ApiOperation({
    summary: 'Token de acceso a la videollamada (LiveKit) del evento',
    description:
      'Devuelve { url, token, room, canPublish }. El rol de publicación depende de si es admin/ponente o del modo. Solo se emite a usuarios de la audiencia.',
  })
  @ApiQuery({ name: 'usuario', required: true })
  @ApiQuery({ name: 'nombre', required: false })
  @ApiQuery({ name: 'esAdmin', required: false, description: 'Fallback cuando el guard de auth está desactivado' })
  @Get(':id/meet-token')
  async meetToken(
    @Param('id') id: string,
    @Query('usuario') usuario: string,
    @Req() req: any,
    @Query('nombre') nombre?: string,
    @Query('esAdmin') esAdminQuery?: string,
  ) {
    // Si el guard de auth está activo, la identidad/rol vienen del token verificado
    // (fuente de confianza). Cuando el guard está desactivado no hay req.user, así
    // que se usa el query (best-effort) hasta que el guard quede siempre activo.
    const authUser = req?.user?.sub ? String(req.user.sub) : '';
    const rol = String(req?.user?.rol || '');
    const esAdmin = req?.user
      ? rol === 'admin' || rol === 'superAdmin'
      : esAdminQuery === 'true';
    return this.events.createMeetToken(id, {
      usuario: authUser || usuario,
      nombre,
      esAdmin,
    });
  }

  // --- Moderación de la videollamada (solo admin) ---
  @ApiOperation({ summary: 'Promover a ponente / degradar a espectador (admin)' })
  @ApiBody({ schema: { type: 'object', properties: { usuario: { type: 'string' }, canPublish: { type: 'boolean' } }, required: ['usuario', 'canPublish'] } })
  @Post(':id/meet/publish')
  async meetSetPublish(@Param('id') id: string, @Body() body: any) {
    return this.events.setParticipantPublish(id, String(body?.usuario || ''), body?.canPublish === true);
  }

  @ApiOperation({ summary: 'Silenciar a un participante (admin)' })
  @ApiBody({ schema: { type: 'object', properties: { usuario: { type: 'string' } }, required: ['usuario'] } })
  @Post(':id/meet/mute')
  async meetMute(@Param('id') id: string, @Body() body: any) {
    return this.events.muteParticipant(id, String(body?.usuario || ''));
  }

  @ApiOperation({ summary: 'Expulsar a un participante (admin)' })
  @ApiBody({ schema: { type: 'object', properties: { usuario: { type: 'string' } }, required: ['usuario'] } })
  @Post(':id/meet/remove')
  async meetRemove(@Param('id') id: string, @Body() body: any) {
    return this.events.removeParticipant(id, String(body?.usuario || ''));
  }

  @ApiOperation({ summary: 'Silenciar a todos los participantes (admin)' })
  @ApiBody({ schema: { type: 'object', properties: { excepto: { type: 'string', description: 'identity a NO silenciar (ej. el admin)' } } } })
  @Post(':id/meet/mute-all')
  async meetMuteAll(@Param('id') id: string, @Body() body: any) {
    return this.events.muteAll(id, body?.excepto ? String(body.excepto) : undefined);
  }

  @ApiOperation({ summary: 'Guardar una votación hecha en vivo en el registro del evento (admin)' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        pregunta: { type: 'string' },
        opciones: { type: 'array' },
        resultados: { type: 'object', description: 'mapa opcionId -> conteo' },
        totalVotos: { type: 'number' },
      },
      required: ['opciones', 'resultados'],
    },
  })
  @Post(':id/meet/live-poll')
  async meetLivePoll(@Param('id') id: string, @Body() body: any) {
    return this.events.saveLivePoll(id, body);
  }

  // --- Grabación (acta en video) ---
  @ApiOperation({ summary: 'Iniciar grabación de la videollamada (admin)' })
  @Post(':id/meet/recording/start')
  async meetRecStart(@Param('id') id: string) {
    return this.events.startRecording(id);
  }

  @ApiOperation({ summary: 'Detener grabación de la videollamada (admin)' })
  @Post(':id/meet/recording/stop')
  async meetRecStop(@Param('id') id: string) {
    return this.events.stopRecording(id);
  }

  // --- HLS (transmisión para espectadores masivos) ---
  @ApiOperation({ summary: 'Iniciar transmisión HLS de la videollamada (admin)' })
  @Post(':id/meet/hls/start')
  async meetHlsStart(@Param('id') id: string) {
    return this.events.startHls(id);
  }

  @ApiOperation({ summary: 'Detener transmisión HLS (admin)' })
  @Post(':id/meet/hls/stop')
  async meetHlsStop(@Param('id') id: string) {
    return this.events.stopHls(id);
  }

  @ApiOperation({ summary: 'Registrar voto en una votación' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        usuario: { type: 'string' },
        nombre: { type: 'string' },
        opcionId: { type: 'string' },
      },
      required: ['usuario', 'opcionId'],
    },
  })
  @Post(':id/vote')
  async vote(@Param('id') id: string, @Body() body: any) {
    return this.events.markVote(id, body);
  }

  @ApiOperation({ summary: 'Marcar asistencia a un evento' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        usuario: { type: 'string' },
        nombre: { type: 'string' },
        estado: { type: 'string', enum: ['asistio', 'no_asistio'] },
      },
      required: ['usuario', 'estado'],
    },
  })
  @Post(':id/attendance')
  async attendance(@Param('id') id: string, @Body() body: any) {
    return this.events.markAttendance(id, body);
  }

  @ApiOperation({ summary: 'Finalizar o reabrir un evento (admin)' })
  @ApiBody({ schema: { type: 'object', properties: { finalizado: { type: 'boolean' } } } })
  @Post(':id/finalize')
  async finalize(@Param('id') id: string, @Body() body: any) {
    // Por defecto finaliza; enviar { finalizado: false } para reabrir.
    return this.events.setFinalized(id, body?.finalizado !== false);
  }

  @ApiOperation({ summary: 'Eliminar evento' })
  @Delete(':id')
  async remove(@Param('id') id: string) {
    return this.events.remove(id);
  }
}
