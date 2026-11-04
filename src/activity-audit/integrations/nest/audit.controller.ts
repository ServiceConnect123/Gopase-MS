// ==========================================
// activity-audit · integración NestJS · controller
// ==========================================
// Contrato de API para que el cliente registre actividad (con evidenciaUrl
// opcional, ya subida a Storage) y para consultar las métricas de sesión.

import { Body, Controller, Delete, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiPropertyOptional, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Inject, Optional } from '@nestjs/common';
import { ActivityLogger } from '../../core/activity-logger';
import { SessionTracker } from '../../core/session-tracker';
import type { ErrorIssueSource } from '../../core/ports';
import { ACTIVITY_LOGGER, ERROR_ISSUE_SOURCE, SESSION_TRACKER } from './activity-audit.tokens';
import { SuperAdminGuard } from './super-admin.guard';

class ActivityLogDto {
  @ApiProperty({ example: 'payments:register', description: 'Pantalla/sección/endpoint.' })
  vista: string;

  @ApiProperty({ example: 'adolfoiglesias', description: 'Identificador del usuario.' })
  usuario: string;

  @ApiPropertyOptional({ example: 'Villa Mayra', description: 'Conjunto al que pertenece la acción.' })
  conjunto?: string;

  @ApiPropertyOptional({
    type: Object,
    description: 'Payload contextual flexible de la acción.',
    example: { monto: 60000, meses: ['Enero'] },
  })
  detalle?: Record<string, unknown>;

  @ApiPropertyOptional({
    description: 'URL de la captura/evidencia ya subida (ej. Firebase Storage).',
    example: 'https://storage.googleapis.com/.../shot.jpg',
  })
  evidenciaUrl?: string;
}

@ApiTags('audit')
@Controller('audit')
export class AuditController {
  constructor(
    @Inject(ACTIVITY_LOGGER) private readonly activity: ActivityLogger,
    @Inject(SESSION_TRACKER) private readonly sessions: SessionTracker,
    @Optional() @Inject(ERROR_ISSUE_SOURCE) private readonly issues?: ErrorIssueSource | null,
  ) {}

  @Get('errors')
  @UseGuards(SuperAdminGuard)
  @ApiOperation({
    summary: 'Errores técnicos agrupados (Sentry). Solo superAdmin.',
    description:
      'Lee de la API de Sentry (requiere SENTRY_AUTH_TOKEN). Si no está configurada ' +
      'responde configured=false con lista vacía.',
  })
  @ApiQuery({ name: 'ambiente', required: false, description: "'qa' | 'prod'. Vacío = todos." })
  @ApiQuery({ name: 'periodo', required: false, description: '24h | 7d | 14d | 30d | 90d (default 14d).' })
  @ApiQuery({ name: 'estado', required: false, description: "'unresolved' (default) | 'resolved' | 'all'." })
  @ApiQuery({ name: 'limit', required: false, example: 25 })
  async listErrors(
    @Query('ambiente') ambiente?: string,
    @Query('periodo') periodo?: string,
    @Query('estado') estado?: string,
    @Query('limit') limit?: string,
  ) {
    if (!this.issues) return { success: true, configured: false, data: [], warnings: [] };
    try {
      const { issues, warnings } = await this.issues.list({
        ambiente: ambiente || undefined,
        periodo: periodo || undefined,
        estado: estado || undefined,
        limit: limit ? parseInt(limit, 10) : undefined,
      });
      return { success: true, configured: true, data: issues, warnings };
    } catch {
      return { success: false, configured: true, data: [], warnings: [], message: 'No se pudo consultar Sentry.' };
    }
  }

  @Get('errors/event/:eventId')
  @UseGuards(SuperAdminGuard)
  @ApiOperation({ summary: 'URL del issue de Sentry para un id de evento (meta.errorEventId). Solo superAdmin.' })
  async resolveErrorEvent(@Param('eventId') eventId: string) {
    if (!this.issues) return { success: true, configured: false };
    const url = await this.issues.resolveEventUrl(eventId);
    return { success: true, configured: true, url: url ?? null };
  }

  @Post('activity')
  @ApiOperation({ summary: 'Registra un evento de actividad (no bloqueante).' })
  logActivity(@Body() body: ActivityLogDto): { ok: true } {
    // Fire-and-forget: respondemos de inmediato sin esperar a Firebase.
    this.activity.log({
      vista: body.vista,
      usuario: body.usuario,
      conjunto: body.conjunto,
      detalle: body.detalle ?? {},
      evidenciaUrl: body.evidenciaUrl,
    });
    return { ok: true };
  }

  @Get('activity')
  @ApiOperation({ summary: 'Lista logs de actividad recientes (filtros opcionales).' })
  @ApiQuery({ name: 'conjunto', required: false })
  @ApiQuery({ name: 'usuario', required: false })
  @ApiQuery({ name: 'ambiente', required: false, description: "Entorno: 'qa' | 'prod'. Vacío = todos." })
  @ApiQuery({ name: 'limit', required: false, example: 100 })
  async listActivity(
    @Query('conjunto') conjunto?: string,
    @Query('usuario') usuario?: string,
    @Query('ambiente') ambiente?: string,
    @Query('limit') limit?: string,
  ) {
    const data = await this.activity.query({
      conjunto: conjunto || undefined,
      usuario: usuario || undefined,
      ambiente: ambiente || undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
    return { success: true, data };
  }

  @Get('summary')
  @UseGuards(SuperAdminGuard)
  @ApiOperation({
    summary: 'Resumen de actividad de un conjunto: módulos más usados, acciones por día y usuarios activos. Solo superAdmin.',
    description:
      'Agrega la actividad de los últimos `dias` (1-14, por defecto 14; es la ventana que conserva la consulta). ' +
      'El "módulo" se deriva del recurso/vista del log. Cacheado 60 s.',
  })
  @ApiQuery({ name: 'conjunto', required: true, description: 'Nombre del conjunto (igual que en los logs).' })
  @ApiQuery({ name: 'dias', required: false, example: 14 })
  @ApiQuery({ name: 'ambiente', required: false, description: "'qa' | 'prod'. Vacío = todos." })
  async activitySummary(
    @Query('conjunto') conjunto?: string,
    @Query('dias') dias?: string,
    @Query('ambiente') ambiente?: string,
  ) {
    if (!conjunto) return { success: false, data: null, message: 'conjunto es obligatorio.' };
    const data = await this.activity.summary({
      conjunto,
      ambiente: ambiente || undefined,
      dias: dias ? parseInt(dias, 10) || undefined : undefined,
    });
    if (!data) return { success: false, data: null, message: 'No se pudo calcular el resumen.' };
    return { success: true, data };
  }

  @Get('openings')
  @UseGuards(SuperAdminGuard)
  @ApiOperation({
    summary: 'Aperturas de la app por usuario y por día (Monitoreo > Sesiones). Solo superAdmin.',
    description: 'Cuenta los eventos "Abrió la app" de los últimos `dias` (1-14). Sin `conjunto` agrega todos. Cacheado 60 s.',
  })
  @ApiQuery({ name: 'conjunto', required: false })
  @ApiQuery({ name: 'dias', required: false, example: 14 })
  @ApiQuery({ name: 'ambiente', required: false, description: "'qa' | 'prod'. Vacío = todos." })
  async appOpenings(
    @Query('conjunto') conjunto?: string,
    @Query('dias') dias?: string,
    @Query('ambiente') ambiente?: string,
  ) {
    const data = await this.activity.openings({
      conjunto: conjunto || undefined,
      ambiente: ambiente || undefined,
      dias: dias ? parseInt(dias, 10) || undefined : undefined,
    });
    if (!data) return { success: false, data: null, message: 'No se pudo calcular las aperturas.' };
    return { success: true, data };
  }

  @Delete('activity')
  @ApiOperation({ summary: 'Elimina en masa logs de actividad por filtro (conjunto/usuario/ambiente).' })
  @ApiQuery({ name: 'conjunto', required: false })
  @ApiQuery({ name: 'usuario', required: false })
  @ApiQuery({ name: 'ambiente', required: false })
  async clearActivity(
    @Query('conjunto') conjunto?: string,
    @Query('usuario') usuario?: string,
    @Query('ambiente') ambiente?: string,
  ) {
    const deleted = await this.activity.removeByFilter({
      conjunto: conjunto || undefined,
      usuario: usuario || undefined,
      ambiente: ambiente || undefined,
    });
    return { success: true, deleted };
  }

  @Delete('activity/:day/:id')
  @ApiOperation({ summary: 'Elimina un log de actividad puntual (día + id).' })
  async deleteActivity(@Param('day') day: string, @Param('id') id: string) {
    const ok = await this.activity.remove(day, id);
    return { success: ok };
  }

  @Get('sessions')
  @ApiOperation({ summary: 'Lista resúmenes de sesión (filtro por conjunto).' })
  @ApiQuery({ name: 'conjunto', required: false })
  @ApiQuery({ name: 'limit', required: false, example: 200 })
  async listSessions(@Query('conjunto') conjunto?: string, @Query('limit') limit?: string) {
    const data = await this.sessions.listSummaries({
      conjunto: conjunto || undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
    return { success: true, data };
  }

  @Get('sessions/:usuario')
  @ApiOperation({ summary: 'Resumen de sesiones de un usuario (métricas).' })
  async getSessions(@Param('usuario') usuario: string) {
    const summary = await this.sessions.getSummary(usuario);
    return { success: true, data: summary };
  }
}
