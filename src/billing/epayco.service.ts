// ==========================================
// billing · ePayco Smart Checkout (pasarela)
// ==========================================
// Integra ePayco para que los administradores de conjunto paguen su suscripción
// a GoPase mediante PSE o tarjeta (débito/crédito).
//
// Flujo:
//   1. Frontend llama POST /billing/epayco/session con {conjunto, ciclo, planId}.
//   2. Este servicio hace login en Apify (PUBLIC_KEY + PRIVATE_KEY en Basic) y
//      crea la sesión de Smart Checkout v2. Devuelve { sessionId, token }.
//   3. El frontend carga checkout-v2.js y llama checkout.open() con el sessionId.
//      ePayco muestra el modal con PSE, tarjetas, etc.
//   4. Al completar el pago, ePayco llama POST /billing/epayco/webhook (URL de
//      confirmación que se pasa al crear la sesión).
//   5. El webhook verifica la transacción, crea la factura en RTDB y la confirma
//      automáticamente (extiende la suscripción del conjunto).
//
// Variables de entorno requeridas:
//   EPAYCO_PUBLIC_KEY   — llave pública del comercio (del dashboard de ePayco).
//   EPAYCO_PRIVATE_KEY  — llave privada del comercio.
//   EPAYCO_TEST         — 'true' en QA/pruebas, 'false' en producción.
//   EPAYCO_WEBHOOK_BASE — URL base del backend (p. ej. https://api.gopase.com).
//                         Se usa para construir la URL de confirmación del webhook.
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BillingService } from './billing.service';
import { PlansService } from '../plans/plans.service';

const APIFY_BASE = 'https://apify.epayco.co';

@Injectable()
export class EpaycoService {
  private readonly logger = new Logger(EpaycoService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly billing: BillingService,
    private readonly plans: PlansService,
  ) {}

  // ---------------------------------------------------------------------------
  // Config
  // ---------------------------------------------------------------------------

  get isTest(): boolean {
    return this.config.get<string>('EPAYCO_TEST', 'true') !== 'false';
  }

  private get publicKey(): string {
    return this.config.get<string>('EPAYCO_PUBLIC_KEY', '');
  }

  private get privateKey(): string {
    return this.config.get<string>('EPAYCO_PRIVATE_KEY', '');
  }

  /** URL del backend expuesta a internet (para el webhook de confirmación). */
  private get webhookBase(): string {
    const raw = this.config.get<string>('EPAYCO_WEBHOOK_BASE', '').trim();
    return raw.endsWith('/') ? raw.slice(0, -1) : raw;
  }

  isConfigured(): boolean {
    return !!(this.publicKey && this.privateKey);
  }

  // ---------------------------------------------------------------------------
  // Apify: login → token
  // ---------------------------------------------------------------------------

  private async getApifyToken(): Promise<string> {
    const credentials = Buffer.from(`${this.publicKey}:${this.privateKey}`).toString('base64');
    const res = await fetch(`${APIFY_BASE}/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${credentials}`,
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`ePayco login falló (${res.status}): ${body.slice(0, 200)}`);
    }
    const data = await res.json();
    const token = data?.token || data?.data?.token;
    if (!token) throw new Error('ePayco login: no se recibió token.');
    return String(token);
  }

  // ---------------------------------------------------------------------------
  // Crear sesión de Smart Checkout v2
  // ---------------------------------------------------------------------------

  /**
   * Crea una sesión de pago en ePayco y devuelve el sessionId para el frontend.
   * `ciclo` define si paga mensual (1 mes) o anual (12 meses con 10% desc).
   */
  async createSession(opts: {
    conjunto: string;
    planId: string;
    ciclo: 'mensual' | 'anual';
    adminEmail?: string;
    adminNombre?: string;
    adminTelefono?: string;
  }): Promise<{ success: boolean; sessionId?: string; token?: string; monto?: number; message?: string }> {
    if (!this.isConfigured()) {
      return { success: false, message: 'ePayco no está configurado (faltan EPAYCO_PUBLIC_KEY / EPAYCO_PRIVATE_KEY).' };
    }

    // Obtener el precio del plan en RTDB.
    const planes = await this.plans.list().catch(() => [] as any[]);
    const plan = Array.isArray(planes) ? planes.find((p: any) => p.id === opts.planId) : null;
    if (!plan) {
      return { success: false, message: `Plan '${opts.planId}' no encontrado.` };
    }
    const precioMensual = Number(plan.precioMensual) || 0;
    if (!precioMensual) {
      return { success: false, message: 'El plan no tiene precio configurado.' };
    }
    const descuentoAnual = Number(plan.descuentoAnual ?? 0.1);
    const monto = opts.ciclo === 'anual'
      ? Math.round(precioMensual * 12 * (1 - descuentoAnual))
      : precioMensual;

    // Concepto legible para la pantalla de pago del usuario.
    const descripcion = `GoPase ${plan.nombre} — ${opts.ciclo === 'anual' ? 'pago anual' : 'pago mensual'} — ${opts.conjunto}`;
    const ahora = new Date();
    const periodo = `${ahora.getFullYear()}-${String(ahora.getMonth() + 1).padStart(2, '0')}`;
    // factura_id único que cruza el webhook con la factura en RTDB.
    const facturaId = `epayco_${opts.conjunto.replace(/\s+/g, '_').toLowerCase()}_${Date.now()}`;

    try {
      const apifyToken = await this.getApifyToken();

      const sessionPayload: Record<string, any> = {
        checkout_version: '2',
        name: `GoPase - ${plan.nombre}`,
        currency: plan.moneda || 'COP',
        amount: monto,
        description: descripcion,
        lang: 'ES',
        country: 'CO',
        invoice: facturaId,
        test: this.isTest,
        // URL de confirmación (webhook): el backend recibe la notificación cuando
        // ePayco procesa el pago. Si no hay EPAYCO_WEBHOOK_BASE, ePayco lo omite
        // (el webhook no llegará y habrá que confirmar manualmente).
        ...(this.webhookBase
          ? { confirmation: `${this.webhookBase}/billing/epayco/webhook` }
          : {}),
        // Extras para cruzar con la factura al recibir el webhook.
        extras: {
          extra1: opts.conjunto,
          extra2: opts.planId,
          extra3: opts.ciclo,
          extra4: facturaId,
          extra5: periodo,
        },
      };

      // Datos de facturación opcionales (mejoran la experiencia y el fraud scoring).
      if (opts.adminEmail || opts.adminNombre || opts.adminTelefono) {
        sessionPayload.billing = {
          ...(opts.adminEmail ? { email: opts.adminEmail } : {}),
          ...(opts.adminNombre ? { name: opts.adminNombre } : {}),
          ...(opts.adminTelefono ? { mobilePhone: opts.adminTelefono, callingCode: '+57' } : {}),
        };
      }

      const sessionRes = await fetch(`${APIFY_BASE}/payment/session/create`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apifyToken}`,
        },
        body: JSON.stringify(sessionPayload),
      });

      if (!sessionRes.ok) {
        const body = await sessionRes.text().catch(() => '');
        throw new Error(`ePayco session/create falló (${sessionRes.status}): ${body.slice(0, 200)}`);
      }

      const sessionData = await sessionRes.json();
      const sessionId = sessionData?.data?.sessionId;
      const sessionToken = sessionData?.data?.token;
      if (!sessionId) {
        throw new Error(`ePayco session/create no devolvió sessionId: ${JSON.stringify(sessionData).slice(0, 300)}`);
      }

      this.logger.log(`[epayco] sesión creada ${sessionId} para ${opts.conjunto} (${opts.planId}/${opts.ciclo}), monto=${monto}`);
      return { success: true, sessionId, token: sessionToken, monto };
    } catch (err: any) {
      this.logger.error(`[epayco] createSession: ${err?.message}`);
      return { success: false, message: err?.message || 'No se pudo crear la sesión de pago.' };
    }
  }

  // ---------------------------------------------------------------------------
  // Webhook de confirmación (ePayco → backend)
  // ---------------------------------------------------------------------------

  /**
   * Recibe la notificación de ePayco cuando se completa un pago. Verifica la
   * transacción en la API de ePayco, crea la factura en RTDB y la confirma
   * (extiende la suscripción del conjunto automáticamente).
   *
   * ePayco envía un POST con el cuerpo URL-encoded o JSON según el método
   * configurado en la sesión (aquí usamos POST). Los campos clave son:
   *   x_ref_payco       — referencia de la transacción en ePayco
   *   x_response        — Aceptada | Rechazada | Pendiente | Fallida
   *   x_transaction_state — igual que x_response en algunos casos
   *   x_amount          — monto cobrado
   *   x_extra1..5       — los extras que pasamos al crear la sesión
   */
  async handleWebhook(body: Record<string, any>): Promise<{ success: boolean; message?: string }> {
    const ref = String(body.x_ref_payco || body.ref_payco || '').trim();
    const response = String(body.x_response || body.x_transaction_state || '').trim().toLowerCase();
    const conjunto = String(body.x_extra1 || '').trim();
    const planId = String(body.x_extra2 || '').trim();
    const ciclo = String(body.x_extra3 || '').trim() as 'mensual' | 'anual';
    const facturaId = String(body.x_extra4 || '').trim();
    const periodo = String(body.x_extra5 || '').trim();
    const monto = Number(body.x_amount || 0);

    if (!ref) {
      this.logger.warn('[epayco] webhook sin ref_payco.');
      return { success: false, message: 'Sin referencia de transacción.' };
    }

    // Solo procesar pagos aceptados.
    if (!['aceptada', 'accepted'].includes(response)) {
      this.logger.log(`[epayco] webhook ignorado: estado '${response}' para ref=${ref}`);
      return { success: true, message: `Transacción ${response}, ignorada.` };
    }

    if (!conjunto || !planId) {
      this.logger.warn(`[epayco] webhook sin conjunto/planId en extras (ref=${ref}).`);
      return { success: false, message: 'Faltan datos del conjunto en el webhook.' };
    }

    try {
      // Verificar con la API de ePayco para no aceptar webhooks falsos.
      const verified = await this.verifyTransaction(ref);
      if (!verified.accepted) {
        this.logger.warn(`[epayco] webhook: transacción ${ref} no verificada (${verified.message}).`);
        return { success: false, message: `Transacción no verificada: ${verified.message}` };
      }

      const id = facturaId || `epayco_${Date.now()}`;
      const ahora = new Date();
      const periodoStr = periodo || `${ahora.getFullYear()}-${String(ahora.getMonth() + 1).padStart(2, '0')}`;
      const cicloNorm: 'mensual' | 'anual' = ciclo === 'anual' ? 'anual' : 'mensual';

      // Crear la factura (queda confirmada automáticamente porque el pago es
      // electrónico y ya fue verificado con la API de ePayco).
      const created = await this.billing.create({
        id,
        conjunto,
        monto: monto || verified.monto,
        montoObjetivo: monto || verified.monto,
        montoPagado: monto || verified.monto,
        planIdSolicitado: planId,
        ciclo: cicloNorm,
        moneda: 'COP',
        periodo: periodoStr,
        concepto: `Pago electrónico ePayco (${ref})`,
        comprobanteUrl: '',
        creadoPor: conjunto,
        creadoPorNombre: conjunto,
        estado: 'pendiente',
      });

      if (!created.success) {
        this.logger.error(`[epayco] webhook: no se pudo crear factura para ${conjunto}: ${created.message}`);
        return { success: false, message: created.message };
      }

      // Confirmar la factura: extiende la suscripción automáticamente.
      const reviewed = await this.billing.review(id, {
        estado: 'confirmada',
        revisadoPor: 'epayco_webhook',
        nota: `Referencia ePayco: ${ref}`,
      });

      this.logger.log(`[epayco] webhook procesado OK: ${conjunto} / ${planId} / ${cicloNorm} / ref=${ref}`);
      return { success: true, message: reviewed.message };
    } catch (err: any) {
      this.logger.error(`[epayco] handleWebhook (ref=${ref}): ${err?.message}`);
      return { success: false, message: err?.message || 'Error interno al procesar el webhook.' };
    }
  }

  // ---------------------------------------------------------------------------
  // Verificar transacción (evita webhooks falsos)
  // ---------------------------------------------------------------------------

  /**
   * Consulta la API de ePayco para confirmar que la transacción `ref` realmente
   * fue aceptada. Usa GET https://secure.epayco.co/validation/v1/reference/{ref}.
   * No requiere autenticación: es un endpoint público de consulta.
   */
  async verifyTransaction(ref: string): Promise<{ accepted: boolean; monto: number; message: string }> {
    try {
      const res = await fetch(`https://secure.epayco.co/validation/v1/reference/${encodeURIComponent(ref)}`);
      if (!res.ok) {
        return { accepted: false, monto: 0, message: `HTTP ${res.status}` };
      }
      const data = await res.json();
      const status = String(data?.data?.x_response || data?.x_response || '').trim().toLowerCase();
      const monto = Number(data?.data?.x_amount || data?.x_amount || 0);
      const accepted = ['aceptada', 'accepted'].includes(status);
      return { accepted, monto, message: status || 'desconocido' };
    } catch (err: any) {
      return { accepted: false, monto: 0, message: err?.message || 'Error al verificar.' };
    }
  }
}
