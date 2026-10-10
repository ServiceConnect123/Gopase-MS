// ==========================================
// activity-audit · integración NestJS · controller
// ==========================================
// Contrato de API para que el cliente registre actividad (con evidenciaUrl
// opcional, ya subida a Storage) y para consultar las métricas de sesión.

import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiPropertyOptional, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Inject } from '@nestjs/common';
import { ActivityLogger } from '../../core/activity-logger';
import { SessionTracker } from '../../core/session-tracker';
import { ACTIVITY_LOGGER, SESSION_TRACKER } from './activity-audit.tokens';

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
  ) {}

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
