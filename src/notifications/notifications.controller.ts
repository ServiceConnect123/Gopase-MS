import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiPropertyOptional, ApiQuery, ApiTags } from '@nestjs/swagger';
import { NotificationsService } from './notifications.service';
import { WhatsappService } from '../whatsapp/whatsapp.service';

class DebtorDto {
  @ApiProperty({ example: 'Juan Pérez' })
  nombre: string;

  @ApiProperty({ example: '573001112233' })
  telefono: string;

  @ApiPropertyOptional({ example: 'Marzo' })
  mes?: string;

  @ApiPropertyOptional({ example: '2026' })
  anio?: string;
}

class NotifyDebtorsDto {
  @ApiProperty({ description: 'Plantilla del mensaje (soporta {nombre}, {mes}, {año}).' })
  mensaje: string;

  @ApiProperty({ type: [DebtorDto], description: 'Destinatarios del recordatorio.' })
  destinatarios: DebtorDto[];

  @ApiPropertyOptional({
    description:
      'Conjunto del admin que notifica. Enruta el envío a su sesión de WhatsApp vinculada.',
    example: 'Villa Mayra',
  })
  conjunto?: string;
}

class ReceiptDataDto {
  @ApiProperty({ example: 60000 })
  monto: number | string;

  @ApiPropertyOptional({ example: 'Confirmado' })
  estado?: string;

  @ApiPropertyOptional({ example: '2026-03-15' })
  fecha?: string;

  @ApiPropertyOptional()
  tipo?: string;

  @ApiPropertyOptional({ example: 'Administración Marzo 2026' })
  concepto?: string;

  @ApiPropertyOptional({ example: 'Juan Pérez' })
  propietario?: string;

  @ApiPropertyOptional({ example: 'Villa Mayra' })
  conjunto?: string;

  @ApiPropertyOptional()
  referencia?: string;

  @ApiPropertyOptional()
  titulo?: string;
}

class SendReceiptDto {
  @ApiProperty({ example: '573001112233' })
  telefono: string;

  @ApiPropertyOptional()
  caption?: string;

  @ApiPropertyOptional({ description: 'URL de la imagen del comprobante.' })
  imageUrl?: string;

  @ApiPropertyOptional({ description: 'Imagen del comprobante en base64.' })
  imageBase64?: string;

  @ApiPropertyOptional({ type: ReceiptDataDto })
  receipt?: ReceiptDataDto;

  @ApiPropertyOptional({
    description:
      'Conjunto del admin. Enruta el envío a su sesión de WhatsApp vinculada.',
    example: 'Villa Mayra',
  })
  conjunto?: string;
}

@ApiTags('notifications')
@Controller('notifications')
export class NotificationsController {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly whatsapp: WhatsappService,
  ) {}

  /**
   * Estado de salud: si WhatsApp está conectado. Si se pasa `conjunto`, reporta
   * la sesión de ESE conjunto (o la por defecto como fallback); si no, la por
   * defecto. Esto es clave: un conjunto puede tener su propia sesión vinculada
   * aunque la sesión global no lo esté.
   */
  @ApiOperation({ summary: 'Estado de salud (WhatsApp conectado, por conjunto)' })
  @ApiQuery({ name: 'conjunto', required: false })
  @Get('status')
  status(@Query('conjunto') conjunto?: string) {
    const ready = conjunto
      ? this.whatsapp.isReady(conjunto) || this.whatsapp.isReady()
      : this.whatsapp.isReady();
    return {
      whatsappReady: ready,
      conjunto: conjunto || null,
      timestamp: new Date().toISOString(),
    };
  }

  /** Dispara el chequeo manualmente (útil para pruebas). */
  @ApiOperation({ summary: 'Dispara el chequeo de pagos pendientes (manual)' })
  @Post('run')
  async run() {
    await this.notifications.checkAndNotify('manual');
    return { ok: true, message: 'Chequeo ejecutado' };
  }

  /**
   * "Despierta" el servicio (Render Free) y agenda el chequeo de pagos
   * pendientes. Responde de inmediato sin esperar a WhatsApp: el chequeo se
   * ejecuta en cuanto la conexión esté lista. Pensado para llamarse
   * fire-and-forget cuando un propietario registra un pago.
   * Se expone en GET y POST para facilitar el llamado desde cualquier cliente.
   */
  @ApiOperation({ summary: 'Despierta el servicio y agenda el chequeo (GET)' })
  @Get('wake')
  wakeGet() {
    this.notifications.scheduleWake();
    return { ok: true, message: 'Servicio despierto, chequeo agendado' };
  }

  @ApiOperation({ summary: 'Despierta el servicio y agenda el chequeo (POST)' })
  @Post('wake')
  wakePost() {
    this.notifications.scheduleWake();
    return { ok: true, message: 'Servicio despierto, chequeo agendado' };
  }

  /**
   * SOLO despierta el servicio (Render Free), SIN agendar el chequeo de pagos
   * pendientes. Pensado para el flujo de confirmar un pago: el admin solo
   * necesita que el servicio esté vivo para enviar el recibo, no recibir la
   * notificación de "pagos pendientes por aprobar".
   */
  @ApiOperation({ summary: 'Despierta el servicio SIN agendar el chequeo (GET)' })
  @Get('ping')
  pingGet() {
    return { ok: true, whatsappReady: this.whatsapp.isReady(), message: 'Servicio despierto' };
  }

  @ApiOperation({ summary: 'Despierta el servicio SIN agendar el chequeo (POST)' })
  @Post('ping')
  pingPost() {
    return { ok: true, whatsappReady: this.whatsapp.isReady(), message: 'Servicio despierto' };
  }

  /**
   * Envía recordatorios de cobro a los deudores enviados por el frontend.
   * Responde de inmediato (fire-and-forget) porque el envío con delay entre
   * mensajes puede tardar y el servicio puede estar despertando (Render).
   */
  @ApiOperation({
    summary: 'Envía recordatorios de cobro a deudores',
    description: 'Fire-and-forget: responde de inmediato y envía con pausa entre mensajes.',
  })
  @Post('notify-debtors')
  notifyDebtors(@Body() body: NotifyDebtorsDto) {
    const total = (body?.destinatarios || []).filter((d) => d && d.telefono).length;
    // No await: se procesa en background con delay entre mensajes.
    this.notifications
      .notifyDebtors(body)
      .catch((e) => console.error('Error en notifyDebtors:', e?.message));
    return {
      ok: true,
      total,
      message: `Notificación en proceso: se enviarán ${total} mensajes con pausa entre cada uno.`,
    };
  }

  /**
   * Envía el recibo (imagen del comprobante) a un propietario por WhatsApp.
   * Se espera el resultado para poder informar al administrador si el envío
   * falló o si el propietario no tiene teléfono.
   */
  @ApiOperation({ summary: 'Envía el recibo (imagen) a un propietario por WhatsApp' })
  @Post('send-receipt')
  async sendReceipt(@Body() body: SendReceiptDto) {
    return this.notifications.sendReceipt(body);
  }
}
