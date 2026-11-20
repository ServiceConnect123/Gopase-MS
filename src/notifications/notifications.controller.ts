import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiProperty, ApiPropertyOptional, ApiQuery, ApiTags } from '@nestjs/swagger';
import { NotificationsService } from './notifications.service';
import { WhatsappService } from '../whatsapp/whatsapp.service';
import { Public } from '../auth/public.decorator';
import { FirebaseService } from '../firebase/firebase.service';
import {
  assertConjuntoPermitido,
  esSuperAdmin,
  WspAccessGuard,
  WspRoles,
} from '../auth/wsp-access.guard';

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

class NotifyNewsDto {
  @ApiPropertyOptional({ description: 'Título de la noticia (para el log).' })
  titulo?: string;

  @ApiProperty({ description: 'Texto a enviar (caption si hay imagen). Soporta {nombre}.' })
  texto: string;

  @ApiPropertyOptional({ description: 'URL de la imagen a adjuntar (Drive).' })
  imageUrl?: string;

  @ApiProperty({ type: [DebtorDto], description: 'Destinatarios de la noticia.' })
  destinatarios: DebtorDto[];

  @ApiPropertyOptional({
    description: 'Conjunto del admin. Enruta el envío a su sesión de WhatsApp vinculada.',
    example: 'Villa Mayra',
  })
  conjunto?: string;
}

@ApiTags('notifications')
@Controller('notifications')
// Solo status/ping/wake son públicos (cold start de Render). Los envíos y el
// disparo manual exigen JWT de admin/superAdmin (WspAccessGuard): antes
// cualquiera con la URL podía enviar mensajes desde el número de un conjunto.
export class NotificationsController {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly whatsapp: WhatsappService,
    private readonly firebase: FirebaseService,
    private readonly config: ConfigService,
  ) {}

  /**
   * ¿`telefono` es de un superAdmin? Únicos destinos permitidos para un admin
   * que envía por la sesión GLOBAL (comprobante de pago de su suscripción).
   * Fuentes: env SUPERADMIN_PHONE y los usuarios con rol superAdmin.
   */
  private async esTelefonoSuperAdmin(telefono: string): Promise<boolean> {
    const ult10 = (t: unknown) => String(t ?? '').replace(/\D/g, '').slice(-10);
    const objetivo = ult10(telefono);
    if (objetivo.length < 10) return false;
    const env = String(this.config.get<string>('SUPERADMIN_PHONE', '') || '')
      .split(',')
      .map(ult10)
      .filter(Boolean);
    if (env.includes(objetivo)) return true;
    const usuarios = await this.firebase.liveValues<any>('mirror/usuarios');
    return usuarios.some(
      (u) => String(u?.rol || '').toLowerCase() === 'superadmin' && ult10(u?.phone) === objetivo,
    );
  }

  /**
   * Estado de salud: si WhatsApp está conectado. Si se pasa `conjunto`, reporta
   * la sesión de ESE conjunto (o la por defecto como fallback); si no, la por
   * defecto. Esto es clave: un conjunto puede tener su propia sesión vinculada
   * aunque la sesión global no lo esté.
   */
  @ApiOperation({ summary: 'Estado de salud (WhatsApp conectado, por conjunto)' })
  @ApiQuery({ name: 'conjunto', required: false })
  @Public()
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
  @UseGuards(WspAccessGuard)
  @WspRoles('superadmin')
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
  @Public()
  @Get('wake')
  wakeGet() {
    this.notifications.scheduleWake();
    return { ok: true, message: 'Servicio despierto, chequeo agendado' };
  }

  @ApiOperation({ summary: 'Despierta el servicio y agenda el chequeo (POST)' })
  @Public()
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
  @Public()
  @Get('ping')
  pingGet() {
    return { ok: true, whatsappReady: this.whatsapp.isReady(), message: 'Servicio despierto' };
  }

  @ApiOperation({ summary: 'Despierta el servicio SIN agendar el chequeo (POST)' })
  @Public()
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
  @UseGuards(WspAccessGuard)
  async notifyDebtors(@Req() req: any, @Body() body: NotifyDebtorsDto) {
    await assertConjuntoPermitido(req, this.firebase, body?.conjunto);
    // Encola (persistido) y responde de inmediato; el envío sigue en segundo plano.
    return this.notifications.notifyDebtors(body, String(req.user?.sub || ''));
  }

  /**
   * Envía el recibo (imagen del comprobante) a un propietario por WhatsApp.
   * Se espera el resultado para poder informar al administrador si el envío
   * falló o si el propietario no tiene teléfono.
   */
  @ApiOperation({ summary: 'Envía el recibo (imagen) a un propietario por WhatsApp' })
  @Post('send-receipt')
  @UseGuards(WspAccessGuard)
  async sendReceipt(@Req() req: any, @Body() body: SendReceiptDto) {
    // Sin conjunto = sesión GLOBAL de goPase. Un admin solo puede usarla para
    // enviar el comprobante de su suscripción a un superAdmin.
    const global = !String(body?.conjunto ?? '').trim();
    const permitirGlobal = global && (await this.esTelefonoSuperAdmin(body?.telefono));
    if (global && !permitirGlobal && !esSuperAdmin(req)) {
      throw new ForbiddenException('Por la sesión global solo se puede escribir al administrador general.');
    }
    await assertConjuntoPermitido(req, this.firebase, body?.conjunto, { permitirGlobal });
    return this.notifications.sendReceipt(body);
  }

  /**
   * Difunde una noticia del conjunto por WhatsApp (imagen opcional + texto como
   * caption) a una lista de destinatarios. Fire-and-forget: responde de
   * inmediato y envía con pausa entre mensajes.
   */
  @ApiOperation({ summary: 'Difunde una noticia del conjunto por WhatsApp' })
  @Post('notify-news')
  @UseGuards(WspAccessGuard)
  async notifyNews(@Req() req: any, @Body() body: NotifyNewsDto) {
    await assertConjuntoPermitido(req, this.firebase, body?.conjunto);
    return this.notifications.notifyNews(body, String(req.user?.sub || ''));
  }

  /** Avance de un envío masivo (estado por destinatario, sin los textos). */
  @ApiOperation({ summary: 'Estado de un envío masivo (lote de la cola)' })
  @Get('jobs/:id')
  @UseGuards(WspAccessGuard)
  async job(@Req() req: any, @Param('id') id: string) {
    const job = await this.notifications.getJob(id);
    if (!job) throw new NotFoundException('Envío no encontrado.');
    await assertConjuntoPermitido(req, this.firebase, job.conjunto, { permitirGlobal: false });
    const { firma, items, ...resumen } = job;
    return {
      ...resumen,
      items: items.map(({ texto, ...it }) => it),
    };
  }
}
