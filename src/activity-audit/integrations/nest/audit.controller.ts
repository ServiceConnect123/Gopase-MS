// ==========================================
// activity-audit · integración NestJS · controller
// ==========================================
// Contrato de API para que el cliente registre actividad (con evidenciaUrl
// opcional, ya subida a Storage) y para consultar las métricas de sesión.

import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Inject } from '@nestjs/common';
import { ActivityLogger } from '../../core/activity-logger';
import { SessionTracker } from '../../core/session-tracker';
import { ACTIVITY_LOGGER, SESSION_TRACKER } from './activity-audit.tokens';

class ActivityLogDto {
  @ApiProperty({ example: 'payments:register', description: 'Pantalla/sección/endpoint.' })
  vista: string;

  @ApiProperty({ example: 'adolfoiglesias', description: 'Identificador del usuario.' })
  usuario: string;

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
      detalle: body.detalle ?? {},
      evidenciaUrl: body.evidenciaUrl,
    });
    return { ok: true };
  }

  @Get('sessions/:usuario')
  @ApiOperation({ summary: 'Resumen de sesiones de un usuario (métricas).' })
  async getSessions(@Param('usuario') usuario: string) {
    const summary = await this.sessions.getSummary(usuario);
    return { success: true, data: summary };
  }
}
