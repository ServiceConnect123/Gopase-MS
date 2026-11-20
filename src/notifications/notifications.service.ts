import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { WhatsappService } from '../whatsapp/whatsapp.service';
import {
  ConjuntoConfig,
  PendingPayment,
  PendingPaymentsRepository,
} from './pending-payments.repository';
import { generateReceiptPng, ReceiptData } from './receipt-image.generator';
import { WspQueueService } from './wsp-queue.service';

/** Zona horaria de los conjuntos (Colombia, sin horario de verano). */
const ZONA_HORARIA = 'America/Bogota';
/** Horario en que se avisa al admin de pagos por aprobar (hora local). */
const HORA_INICIO = 8;
const HORA_FIN = 20;

@Injectable()
export class NotificationsService implements OnModuleInit {
  private readonly logger = new Logger(NotificationsService.name);
  private running = false;

  constructor(
    private readonly repo: PendingPaymentsRepository,
    private readonly whatsapp: WhatsappService,
    private readonly config: ConfigService,
    private readonly queue: WspQueueService,
  ) {}

  async onModuleInit() {
    const runOnStartup =
      this.config.get<string>('RUN_ON_STARTUP', 'true').toLowerCase() === 'true';
    if (runOnStartup) {
      // Esperamos un poco a que la conexión de WhatsApp se establezca.
      setTimeout(() => {
        this.checkAndNotify('startup').catch((e) =>
          this.logger.error(`Error en ejecución de arranque: ${e?.message}`),
        );
      }, 8000);
    }
  }

  /**
   * Cron principal. La expresión se lee de CRON_EXPRESSION (por defecto cada 5 min).
   */
  @Cron(process.env.CRON_EXPRESSION || '*/5 * * * *', {
    name: 'pending-payments-notifier',
  })
  async handleCron() {
    await this.checkAndNotify('cron');
  }

  private wakeScheduled = false;

  /**
   * Disparado por /wake (p. ej. cuando un propietario registra un pago).
   * No espera a WhatsApp: agenda el chequeo y reintenta hasta que la conexión
   * esté lista, cubriendo el cold start de Render. Responde de inmediato.
   */
  scheduleWake(): void {
    if (this.wakeScheduled) {
      this.logger.debug('Wake ya agendado; se ignora la petición duplicada.');
      return;
    }
    this.wakeScheduled = true;
    this.logger.log('Wake recibido: se agenda el chequeo de pagos pendientes.');

    const maxAttempts = 12; // ~1 min esperando a que WhatsApp conecte (12 x 5s)
    let attempt = 0;

    const tick = () => {
      attempt++;
      if (this.whatsapp.isReady()) {
        this.checkAndNotify('wake')
          .catch((e) => this.logger.error(`Error en wake: ${e?.message}`))
          .finally(() => {
            this.wakeScheduled = false;
          });
        return;
      }
      if (attempt >= maxAttempts) {
        this.logger.warn(
          'Wake: WhatsApp no conectó a tiempo. El chequeo de arranque/cron lo cubrirá.',
        );
        this.wakeScheduled = false;
        return;
      }
      setTimeout(tick, 5000);
    };

    // Primer intento a los 3s (da margen a que empiece a reconectar).
    setTimeout(tick, 3000);
  }

  /**
   * Fecha YYYY-MM-DD en hora de Colombia para el control diario. Antes usaba la
   * hora del servidor (UTC en Render) y el "día" cambiaba a las 7 p. m.
   */
  private today(now = new Date()): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: ZONA_HORARIA,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);
  }

  /** ¿Estamos dentro del horario de envío (8:00–19:59 hora de Colombia)? */
  private enHorarioDeEnvio(now = new Date()): boolean {
    const hora = Number(
      new Intl.DateTimeFormat('en-US', { timeZone: ZONA_HORARIA, hour: '2-digit', hourCycle: 'h23' }).format(now),
    );
    return hora >= HORA_INICIO && hora < HORA_FIN;
  }

  private buildMessage(conjunto: ConjuntoConfig, pagos: PendingPayment[]): string {
    const cantidad = pagos.length;
    const plural = cantidad === 1 ? 'pago pendiente' : 'pagos pendientes';
    const saludo = conjunto.adminNombre ? `Hola ${conjunto.adminNombre}, ` : 'Hola, ';
    return (
      `${saludo}tienes ${cantidad} ${plural} por aprobar en el conjunto ` +
      `"${conjunto.nombre}".\n\n` +
      `Ingresa aquí para revisarlos y aprobarlos: ${conjunto.rutaAprobacion}`
    );
  }

  /**
   * Núcleo del flujo: lee conjuntos, cruza pagos pendientes, respeta el
   * límite de un envío por día y notifica por WhatsApp.
   */
  async checkAndNotify(
    trigger: 'cron' | 'startup' | 'manual' | 'wake',
  ): Promise<void> {
    if (this.running) {
      this.logger.warn('Ejecución omitida: ya hay un chequeo en curso.');
      return;
    }
    // Fuera de horario no se avisa (ni se registra): el primer ciclo después de
    // las 8 a. m. envía el aviso pendiente. El disparo manual lo ignora.
    if (trigger !== 'manual' && !this.enHorarioDeEnvio()) {
      this.logger.debug(`[${trigger}] Fuera del horario de envío; se omite el chequeo.`);
      return;
    }
    this.running = true;
    const fecha = this.today();
    this.logger.log(`[${trigger}] Iniciando chequeo de pagos pendientes (${fecha})`);

    try {
      // Con multi-sesión ya no exigimos una conexión global: cada conjunto usa
      // su propia sesión (y, si no está vinculada, el envío cae a la sesión por
      // defecto dentro de WhatsappService). Si NINGUNA sesión está lista, no
      // tiene sentido continuar este ciclo.
      if (!this.whatsapp.isReady()) {
        this.logger.debug(
          'La sesión por defecto no está conectada; se enviará solo por sesiones de conjunto vinculadas.',
        );
      }

      const [conjuntos, pendingByConjunto, enviadosHoy] = await Promise.all([
        this.repo.getConjuntos(),
        this.repo.getPendingByConjunto(),
        this.repo.getEnviosDelDia(fecha),
      ]);

      if (conjuntos.length === 0) {
        this.logger.log('No hay conjuntos activos configurados.');
        return;
      }

      let enviados = 0;
      for (const conjunto of conjuntos) {
        const key = conjunto.nombre.toLowerCase();

        if (enviadosHoy.has(key)) {
          this.logger.debug(`"${conjunto.nombre}" ya fue notificado hoy. Se omite.`);
          continue;
        }

        const pagos = pendingByConjunto.get(key) || [];
        if (pagos.length === 0) {
          this.logger.debug(`"${conjunto.nombre}" sin pagos pendientes.`);
          continue;
        }

        // Si ni la sesión del conjunto ni la por defecto están listas, se omite
        // y se reintentará en el próximo ciclo (no se registra el envío).
        if (!this.whatsapp.isReady(conjunto.nombre) && !this.whatsapp.isReady()) {
          this.logger.debug(
            `"${conjunto.nombre}" sin sesión de WhatsApp lista. Se reintentará.`,
          );
          continue;
        }

        const mensaje = this.buildMessage(conjunto, pagos);
        const ok = await this.whatsapp.sendMessage(
          conjunto.adminWhatsapp,
          mensaje,
          conjunto.nombre,
        );

        if (ok) {
          await this.repo.registrarEnvio(conjunto.nombre, fecha, pagos.length);
          enviados++;
          this.logger.log(
            `Notificados ${pagos.length} pagos de "${conjunto.nombre}" a ${conjunto.adminWhatsapp}`,
          );
        } else {
          this.logger.warn(
            `No se pudo notificar a "${conjunto.nombre}". No se registra el envío para reintentar luego.`,
          );
        }
      }

      this.logger.log(`Chequeo finalizado. Notificaciones enviadas: ${enviados}`);
    } catch (error: any) {
      this.logger.error(`Error en checkAndNotify: ${error?.message}`, error?.stack);
    } finally {
      this.running = false;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  /**
   * Espera hasta ~maxMs a que WhatsApp esté conectado (cold start de Render).
   * Considera lista la conexión si la sesión del conjunto O la sesión por
   * defecto están conectadas (el envío cae a la default si el conjunto no tiene
   * número propio vinculado).
   */
  private async waitForWhatsapp(
    conjunto?: string | null,
    maxMs = 60000,
  ): Promise<boolean> {
    const step = 3000;
    let waited = 0;
    const ready = () =>
      this.whatsapp.isReady(conjunto) || this.whatsapp.isReady();
    while (!ready() && waited < maxMs) {
      await this.sleep(step);
      waited += step;
    }
    return ready();
  }

  /**
   * Encola recordatorios de cobro (o invitaciones a eventos) para una lista de
   * destinatarios. El envío real lo hace WspQueueService: persistido, con pausa
   * entre mensajes, reanudable tras un reinicio y deduplicado.
   *
   * El mensaje soporta placeholders {nombre}, {mes}, {año}/{anio}.
   */
  async notifyDebtors(
    payload: {
      mensaje: string;
      destinatarios: Array<{ nombre: string; telefono: string; mes?: string; anio?: string }>;
      conjunto?: string;
    },
    creadoPor = '',
  ): Promise<{ ok: boolean; total: number; jobId?: string; duplicado?: boolean; message: string }> {
    const lista = (payload?.destinatarios || []).filter((d) => d && d.telefono);
    if (lista.length === 0) {
      return { ok: true, total: 0, message: 'No hay destinatarios con teléfono.' };
    }
    const plantilla = payload.mensaje || 'Hola {nombre}, tienes un pago pendiente.';
    const job = await this.queue.crear({
      tipo: 'recordatorio',
      conjunto: payload.conjunto || '',
      creadoPor,
      destinatarios: lista.map((d) => ({
        nombre: d.nombre || '',
        telefono: d.telefono,
        texto: plantilla
          .replace(/\{nombre\}/g, d.nombre || '')
          .replace(/\{mes\}/g, d.mes || '')
          .replace(/\{año\}/g, d.anio || '')
          .replace(/\{anio\}/g, d.anio || ''),
      })),
    });
    return {
      ok: true,
      total: job.total,
      jobId: job.id,
      duplicado: job.duplicado,
      message: job.duplicado
        ? 'Este envío ya estaba en proceso; no se duplicó.'
        : `Notificación en proceso: se enviarán ${job.total} mensajes con pausa entre cada uno.`,
    };
  }

  /**
   * Encola la difusión de una NOTICIA (imagen opcional + texto como caption).
   * El texto soporta el placeholder {nombre}.
   */
  async notifyNews(
    payload: {
      titulo?: string;
      texto: string;
      imageUrl?: string;
      destinatarios: Array<{ nombre: string; telefono: string }>;
      conjunto?: string;
    },
    creadoPor = '',
  ): Promise<{ ok: boolean; total: number; jobId?: string; duplicado?: boolean; message: string }> {
    const lista = (payload?.destinatarios || []).filter((d) => d && d.telefono);
    if (lista.length === 0) {
      return { ok: true, total: 0, message: 'No hay destinatarios con teléfono.' };
    }
    const base =
      String(payload?.texto ?? '').trim() || String(payload?.titulo ?? 'Nueva noticia del conjunto.');
    const imageUrl = String(payload?.imageUrl ?? '').trim();
    const job = await this.queue.crear({
      tipo: 'noticia',
      conjunto: payload.conjunto || '',
      creadoPor,
      imageUrl: imageUrl || undefined,
      destinatarios: lista.map((d) => ({
        nombre: d.nombre || '',
        telefono: d.telefono,
        texto: base.replace(/\{nombre\}/g, d.nombre || ''),
      })),
    });
    return {
      ok: true,
      total: job.total,
      jobId: job.id,
      duplicado: job.duplicado,
      message: job.duplicado
        ? 'Esta noticia ya se estaba enviando; no se duplicó.'
        : `Noticia en proceso: se enviarán ${job.total} mensajes con pausa entre cada uno.`,
    };
  }

  /** Avance de un envío masivo. */
  getJob(id: string) {
    return this.queue.obtener(id);
  }

  /**
   * Envía el recibo a un propietario por WhatsApp.
   * Espera a que la conexión esté lista (cold start de Render).
   *
   * Si se proveen datos en `receipt`, genera la TIRILLA de pago propia de
   * goPase (imagen PNG) y la envía. Como respaldo, acepta la imagen como URL
   * (imageUrl) o base64 (imageBase64).
   */
  async sendReceipt(payload: {
    telefono: string;
    caption?: string;
    imageUrl?: string;
    imageBase64?: string;
    receipt?: ReceiptData;
    conjunto?: string;
  }): Promise<{ ok: boolean; message: string }> {
    const telefono = (payload?.telefono || '').toString().trim();
    if (!telefono) {
      return { ok: false, message: 'El propietario no tiene teléfono registrado.' };
    }
    if (!payload.receipt && !payload.imageUrl && !payload.imageBase64 && !payload.caption) {
      return { ok: false, message: 'No hay recibo ni mensaje para enviar.' };
    }

    const conjunto = payload?.conjunto;

    const ready = await this.waitForWhatsapp(conjunto);
    if (!ready) {
      return { ok: false, message: 'WhatsApp no está conectado. Intenta de nuevo en un momento.' };
    }

    // Preferir la tirilla generada por goPase si vienen los datos.
    let generatedBase64: string | undefined;
    if (payload.receipt) {
      try {
        const png = await generateReceiptPng(payload.receipt);
        generatedBase64 = png.toString('base64');
      } catch (e: any) {
        this.logger.error(`No se pudo generar la tirilla: ${e?.message}`);
      }
    }

    const ok = await this.whatsapp.sendImage(
      telefono,
      {
        imageBase64: generatedBase64 || payload.imageBase64,
        imageUrl: generatedBase64 ? undefined : payload.imageUrl,
        caption: payload.caption,
      },
      conjunto,
    );

    return ok
      ? { ok: true, message: 'Recibo enviado por WhatsApp.' }
      : { ok: false, message: 'No se pudo enviar el recibo por WhatsApp.' };
  }
}
