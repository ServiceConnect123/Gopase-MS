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

@Injectable()
export class NotificationsService implements OnModuleInit {
  private readonly logger = new Logger(NotificationsService.name);
  private running = false;

  constructor(
    private readonly repo: PendingPaymentsRepository,
    private readonly whatsapp: WhatsappService,
    private readonly config: ConfigService,
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

  /** Fecha local YYYY-MM-DD para el control diario. */
  private today(): string {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
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
    this.running = true;
    const fecha = this.today();
    this.logger.log(`[${trigger}] Iniciando chequeo de pagos pendientes (${fecha})`);

    try {
      if (!this.whatsapp.isReady()) {
        this.logger.warn(
          'WhatsApp aún no está conectado. Se omite este ciclo (se reintentará).',
        );
        return;
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

        const pagos = pendingByConjunto.get(conjunto.nombre) || [];
        if (pagos.length === 0) {
          this.logger.debug(`"${conjunto.nombre}" sin pagos pendientes.`);
          continue;
        }

        const mensaje = this.buildMessage(conjunto, pagos);
        const ok = await this.whatsapp.sendMessage(conjunto.adminWhatsapp, mensaje);

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

  /** Espera hasta ~maxMs a que WhatsApp esté conectado (cold start de Render). */
  private async waitForWhatsapp(maxMs = 60000): Promise<boolean> {
    const step = 3000;
    let waited = 0;
    while (!this.whatsapp.isReady() && waited < maxMs) {
      await this.sleep(step);
      waited += step;
    }
    return this.whatsapp.isReady();
  }

  /**
   * Envía recordatorios de cobro a una lista de deudores, con un delay entre
   * cada mensaje para no ser bloqueado por WhatsApp. Como el servicio puede
   * estar dormido (Render), primero espera a que la conexión esté lista.
   *
   * El mensaje soporta placeholders {nombre}, {mes}, {año}.
   */
  async notifyDebtors(payload: {
    mensaje: string;
    destinatarios: Array<{ nombre: string; telefono: string; mes?: string; anio?: string }>;
  }): Promise<{ ok: boolean; enviados: number; fallidos: number; total: number; message: string }> {
    const lista = (payload?.destinatarios || []).filter((d) => d && d.telefono);
    const total = lista.length;
    if (total === 0) {
      return { ok: true, enviados: 0, fallidos: 0, total: 0, message: 'No hay destinatarios con teléfono.' };
    }

    // Delay entre mensajes (ms). Configurable; por defecto 4s.
    const delayMs = Number(this.config.get<string>('WHATSAPP_MESSAGE_DELAY_MS', '4000'));

    const ready = await this.waitForWhatsapp();
    if (!ready) {
      return {
        ok: false, enviados: 0, fallidos: total, total,
        message: 'WhatsApp no está conectado. Intenta de nuevo en un momento.',
      };
    }

    let enviados = 0;
    let fallidos = 0;
    for (let i = 0; i < lista.length; i++) {
      const d = lista[i];
      const texto = (payload.mensaje || 'Hola {nombre}, tienes un pago pendiente.')
        .replace(/\{nombre\}/g, d.nombre || '')
        .replace(/\{mes\}/g, d.mes || '')
        .replace(/\{año\}/g, d.anio || '')
        .replace(/\{anio\}/g, d.anio || '');

      const ok = await this.whatsapp.sendMessage(d.telefono, texto);
      if (ok) enviados++;
      else fallidos++;

      // Delay entre mensajes (no tras el último).
      if (i < lista.length - 1) await this.sleep(delayMs);
    }

    this.logger.log(`Notificación de cobro: ${enviados}/${total} enviados, ${fallidos} fallidos.`);
    return {
      ok: true, enviados, fallidos, total,
      message: `Se enviaron ${enviados} de ${total} mensajes.`,
    };
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
  }): Promise<{ ok: boolean; message: string }> {
    const telefono = (payload?.telefono || '').toString().trim();
    if (!telefono) {
      return { ok: false, message: 'El propietario no tiene teléfono registrado.' };
    }
    if (!payload.receipt && !payload.imageUrl && !payload.imageBase64 && !payload.caption) {
      return { ok: false, message: 'No hay recibo ni mensaje para enviar.' };
    }

    const ready = await this.waitForWhatsapp();
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

    const ok = await this.whatsapp.sendImage(telefono, {
      imageBase64: generatedBase64 || payload.imageBase64,
      imageUrl: generatedBase64 ? undefined : payload.imageUrl,
      caption: payload.caption,
    });

    return ok
      ? { ok: true, message: 'Recibo enviado por WhatsApp.' }
      : { ok: false, message: 'No se pudo enviar el recibo por WhatsApp.' };
  }
}
