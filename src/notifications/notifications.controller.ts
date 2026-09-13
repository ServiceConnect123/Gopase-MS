import { Body, Controller, Get, Post } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { WhatsappService } from '../whatsapp/whatsapp.service';

interface NotifyDebtorsDto {
  mensaje: string;
  destinatarios: Array<{ nombre: string; telefono: string; mes?: string; anio?: string }>;
}

interface SendReceiptDto {
  telefono: string;
  caption?: string;
  imageUrl?: string;
  imageBase64?: string;
  receipt?: {
    monto: number | string;
    estado?: string;
    fecha?: string;
    tipo?: string;
    concepto?: string;
    propietario?: string;
    conjunto?: string;
    referencia?: string;
    titulo?: string;
  };
}

@Controller('notifications')
export class NotificationsController {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly whatsapp: WhatsappService,
  ) {}

  /** Estado de salud: si WhatsApp está conectado. */
  @Get('status')
  status() {
    return {
      whatsappReady: this.whatsapp.isReady(),
      timestamp: new Date().toISOString(),
    };
  }

  /** Dispara el chequeo manualmente (útil para pruebas). */
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
  @Get('wake')
  wakeGet() {
    this.notifications.scheduleWake();
    return { ok: true, message: 'Servicio despierto, chequeo agendado' };
  }

  @Post('wake')
  wakePost() {
    this.notifications.scheduleWake();
    return { ok: true, message: 'Servicio despierto, chequeo agendado' };
  }

  /**
   * Envía recordatorios de cobro a los deudores enviados por el frontend.
   * Responde de inmediato (fire-and-forget) porque el envío con delay entre
   * mensajes puede tardar y el servicio puede estar despertando (Render).
   */
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
  @Post('send-receipt')
  async sendReceipt(@Body() body: SendReceiptDto) {
    return this.notifications.sendReceipt(body);
  }
}
