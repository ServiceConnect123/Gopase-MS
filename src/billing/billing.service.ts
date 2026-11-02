import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { FirebaseService } from '../firebase/firebase.service';
import { PlansService } from '../plans/plans.service';

/**
 * Facturación SaaS: el superAdmin le cobra a cada conjunto según su plan. El
 * administrador del conjunto crea una factura (monto libre según su plan) y
 * adjunta el comprobante de pago; queda 'pendiente'. El superAdmin la valida y
 * la 'confirma' o 'rechaza'.
 *
 * Es independiente de mirror/pagos (pagos de propietarios al conjunto). Aquí se
 * registra el pago del conjunto HACIA el superAdmin.
 *
 * Campos:
 *   id, conjunto, monto, moneda, periodo (YYYY-MM libre), concepto,
 *   estado ('pendiente'|'confirmada'|'rechazada'), comprobanteUrl,
 *   creadoPor, creadoPorNombre, creadoEn, revisadoPor, revisadoEn, nota
 */
const MIRROR_FACTURAS = 'mirror/facturas';
const MIRROR_CONJUNTOS = 'mirror/conjuntos';

export const FACTURA_ESTADOS = ['pendiente', 'confirmada', 'rechazada', 'devuelta'] as const;
export type FacturaEstado = (typeof FACTURA_ESTADOS)[number];

/** Días de gracia dentro del mes para pagar antes de bloquear el conjunto. */
const DIAS_GRACIA = 10;

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    private readonly firebase: FirebaseService,
    private readonly config: ConfigService,
    private readonly plans: PlansService,
  ) {}

  private safeKey(raw: unknown): string {
    return String(raw ?? '').trim().replace(/[.#$/\[\]]/g, '_');
  }

  /**
   * Carpeta de Drive donde se guardan los comprobantes de FACTURACIÓN (pagos de
   * los conjuntos hacia el superAdmin). Se configura con la env
   * BILLING_DRIVE_FOLDER_ID. Acepta un id o una URL de carpeta; se extrae el id.
   * Si no está definida, se devuelve vacío (el comprobante cae en la raíz del
   * Apps Script, igual que antes).
   */
  getDriveFolderId(): string {
    const raw = String(this.config.get<string>('BILLING_DRIVE_FOLDER_ID', '') || '').trim();
    if (!raw) return '';
    const m = raw.match(/folders\/([a-zA-Z0-9_-]+)/);
    return m ? m[1] : raw;
  }

  /**
   * Nombre de carpeta por defecto para los comprobantes de facturación. Se usa
   * cuando NO hay BILLING_DRIVE_FOLDER_ID: el Apps Script busca (o crea) una
   * carpeta con este nombre y sube ahí. Configurable con BILLING_DRIVE_FOLDER_NAME.
   */
  getDriveFolderName(): string {
    const raw = String(this.config.get<string>('BILLING_DRIVE_FOLDER_NAME', '') || '').trim();
    return raw || 'goPase Facturacion';
  }

  private normEstado(raw: unknown): FacturaEstado {
    const s = String(raw ?? '').trim().toLowerCase();
    return (FACTURA_ESTADOS as readonly string[]).includes(s) ? (s as FacturaEstado) : 'pendiente';
  }

  private normCiclo(raw: unknown): 'mensual' | 'anual' {
    return String(raw ?? '').trim().toLowerCase() === 'anual' ? 'anual' : 'mensual';
  }

  private normComprobantes(raw: any, fallbackUrl?: string): string[] {
    let list: string[] = [];
    if (Array.isArray(raw)) list = raw.map((v) => String(v ?? '').trim()).filter(Boolean);
    else if (raw && typeof raw === 'object') list = Object.values(raw).map((v) => String(v ?? '').trim()).filter(Boolean);
    if (list.length === 0 && fallbackUrl) list = [String(fallbackUrl).trim()].filter(Boolean);
    return Array.from(new Set(list));
  }

  private buildRecord(dto: any): Record<string, any> {
    const ahora = new Date().toISOString();
    const comprobantes = this.normComprobantes(dto.comprobantes, dto.comprobanteUrl);
    return {
      id: String(dto.id),
      conjunto: String(dto.conjunto ?? ''),
      // monto = lo que debía pagar (objetivo). montoPagado = acumulado recibido.
      monto: Number(dto.monto) || 0,
      montoObjetivo: Number(dto.montoObjetivo ?? dto.monto) || 0,
      montoPagado: Number(dto.montoPagado ?? dto.monto) || 0,
      moneda: String(dto.moneda ?? 'COP'),
      periodo: String(dto.periodo ?? ''),
      concepto: String(dto.concepto ?? ''),
      // Ciclo de la suscripción que paga esta factura: 'mensual' (+1 mes) o
      // 'anual' (+12 meses, con 10% de descuento ya reflejado en el monto).
      ciclo: this.normCiclo(dto.ciclo),
      estado: this.normEstado(dto.estado),
      // Comprobante(s): se conserva comprobanteUrl (el primero) por compatibilidad
      // y la lista completa en comprobantes[] (incluye los anexados por restante).
      comprobanteUrl: comprobantes[0] || String(dto.comprobanteUrl ?? ''),
      comprobantes,
      // Si la factura es por un CAMBIO/ACTIVACIÓN de plan, el plan solicitado.
      planIdSolicitado: String(dto.planIdSolicitado ?? ''),
      creadoPor: String(dto.creadoPor ?? ''),
      creadoPorNombre: String(dto.creadoPorNombre ?? ''),
      creadoEn: String(dto.creadoEn ?? ahora),
      revisadoPor: String(dto.revisadoPor ?? ''),
      revisadoEn: String(dto.revisadoEn ?? ''),
      nota: String(dto.nota ?? ''),
      actualizadoEn: ahora,
      _fbWrite: true,
    };
  }

  /** Lista las facturas. Filtra por conjunto (nombre) si se pasa. */
  async list(conjunto?: string): Promise<any[]> {
    if (!this.firebase.isEnabled()) throw new Error('Servicio no disponible.');
    const snap = await this.firebase.db().ref(MIRROR_FACTURAS).get();
    if (!snap.exists()) return [];
    let items = Object.values(snap.val() || {}) as any[];
    if (conjunto) {
      const norm = (s: unknown) => String(s ?? '').trim().toLowerCase();
      items = items.filter((f) => norm(f.conjunto) === norm(conjunto));
    }
    return items.map((f) => {
      const { _fbWrite, ...rest } = f;
      return {
        ...rest,
        estado: this.normEstado(rest.estado),
        monto: Number(rest.monto) || 0,
        montoObjetivo: Number(rest.montoObjetivo ?? rest.monto) || 0,
        montoPagado: Number(rest.montoPagado ?? rest.monto) || 0,
        comprobantes: this.normComprobantes(rest.comprobantes, rest.comprobanteUrl),
        planIdSolicitado: String(rest.planIdSolicitado ?? ''),
        ciclo: this.normCiclo(rest.ciclo),
      };
    });
  }

  async create(dto: any): Promise<{ success: boolean; message?: string; id?: string }> {
    if (!this.firebase.isEnabled()) return { success: false, message: 'Servicio no disponible.' };
    if (!String(dto?.conjunto ?? '').trim()) return { success: false, message: 'El conjunto es requerido.' };
    if (!(Number(dto?.monto) > 0)) return { success: false, message: 'El monto debe ser mayor a 0.' };

    const id = String(dto.id || Date.now().toString());
    // Una factura creada por el admin arranca SIEMPRE en 'pendiente'.
    // montoObjetivo = lo que debe pagar; montoPagado = lo transferido ahora.
    const record = this.buildRecord({
      ...dto,
      id,
      estado: 'pendiente',
      montoObjetivo: Number(dto.montoObjetivo ?? dto.monto) || 0,
      montoPagado: Number(dto.monto) || 0,
      revisadoPor: '',
      revisadoEn: '',
    });
    try {
      await this.firebase.db().ref(`${MIRROR_FACTURAS}/${this.safeKey(id)}`).set(record);
      return { success: true, id, message: 'Factura creada.' };
    } catch (err: any) {
      this.logger.error(`[billing] create falló: ${err?.message}`);
      return { success: false, message: err?.message || 'No se pudo crear la factura.' };
    }
  }

  /**
   * Revisa una factura: la confirma o la rechaza (solo el superAdmin en la UI).
   * Registra quién y cuándo, y una nota opcional.
   */
  async review(
    id: string,
    dto: { estado: 'confirmada' | 'rechazada' | 'devuelta'; revisadoPor?: string; nota?: string },
  ): Promise<{ success: boolean; message?: string }> {
    if (!this.firebase.isEnabled()) return { success: false, message: 'Servicio no disponible.' };
    const key = this.safeKey(id);
    if (!key) return { success: false, message: 'ID requerido.' };
    const nuevo = this.normEstado(dto?.estado);
    if (nuevo !== 'confirmada' && nuevo !== 'rechazada' && nuevo !== 'devuelta') {
      return { success: false, message: 'Estado inválido (confirmada | rechazada | devuelta).' };
    }
    const ref = this.firebase.db().ref(`${MIRROR_FACTURAS}/${key}`);
    const snap = await ref.get();
    if (!snap.exists()) return { success: false, message: 'La factura no existe.' };
    const factura = snap.val() || {};
    try {
      const ahora = new Date().toISOString();
      await ref.update({
        estado: nuevo,
        revisadoPor: String(dto?.revisadoPor ?? ''),
        revisadoEn: ahora,
        nota: String(dto?.nota ?? ''),
        actualizadoEn: ahora,
        _fbWrite: true,
      });

      // Al CONFIRMAR una factura de cambio/activación de plan, se asigna el plan
      // solicitado al conjunto automáticamente.
      let planMsg = '';
      let subMsg = '';
      if (nuevo === 'confirmada') {
        const conjunto = String(factura.conjunto ?? '').trim();
        const planId = String(factura.planIdSolicitado ?? '').trim();
        if (planId && conjunto) {
          try {
            const r = await this.plans.assign(conjunto, planId);
            planMsg = r.success ? ' El plan fue asignado al conjunto.' : ` (No se pudo asignar el plan: ${r.message})`;
          } catch (e: any) {
            planMsg = ` (No se pudo asignar el plan: ${e?.message})`;
          }
        }
        // Cualquier factura confirmada extiende la suscripción del conjunto
        // según su ciclo (mensual +1 mes / anual +12 meses) y lo desbloquea.
        if (conjunto) {
          try {
            const ciclo = this.normCiclo(factura.ciclo);
            const r = await this.extenderSuscripcion(conjunto, ciclo);
            if (r.success) {
              const meses = ciclo === 'anual' ? 12 : 1;
              subMsg = ` Suscripción extendida ${meses} mes(es) (hasta ${String(r.pagadoHasta).slice(0, 10)}).`;
            } else {
              subMsg = ` (No se pudo extender la suscripción: ${r.message})`;
            }
          } catch (e: any) {
            subMsg = ` (No se pudo extender la suscripción: ${e?.message})`;
          }
        }
      }

      const base =
        nuevo === 'confirmada' ? 'Factura confirmada.'
        : nuevo === 'rechazada' ? 'Factura rechazada.'
        : 'Factura devuelta: el admin puede anexar el pago restante.';
      return { success: true, message: base + planMsg + subMsg };
    } catch (err: any) {
      this.logger.error(`[billing] review ${key} falló: ${err?.message}`);
      return { success: false, message: err?.message || 'No se pudo actualizar la factura.' };
    }
  }

  /**
   * El admin anexa un comprobante adicional (el pago RESTANTE) sobre una factura
   * que fue devuelta por pago incompleto. Suma al montoPagado, agrega el
   * comprobante a la lista y la devuelve a 'pendiente' para que el superAdmin la
   * revise de nuevo.
   */
  async addComprobante(
    id: string,
    dto: { comprobanteUrl: string; montoAdicional?: number },
  ): Promise<{ success: boolean; message?: string }> {
    if (!this.firebase.isEnabled()) return { success: false, message: 'Servicio no disponible.' };
    const key = this.safeKey(id);
    if (!key) return { success: false, message: 'ID requerido.' };
    const url = String(dto?.comprobanteUrl ?? '').trim();
    if (!url) return { success: false, message: 'Falta el comprobante.' };

    const ref = this.firebase.db().ref(`${MIRROR_FACTURAS}/${key}`);
    const snap = await ref.get();
    if (!snap.exists()) return { success: false, message: 'La factura no existe.' };
    const f = snap.val() || {};
    try {
      const comprobantes = this.normComprobantes(f.comprobantes, f.comprobanteUrl);
      comprobantes.push(url);
      const montoPagado = (Number(f.montoPagado) || 0) + (Number(dto?.montoAdicional) || 0);
      const ahora = new Date().toISOString();
      await ref.update({
        comprobantes: Array.from(new Set(comprobantes)),
        montoPagado,
        estado: 'pendiente', // vuelve a revisión
        nota: '', // limpia la nota del faltante anterior
        actualizadoEn: ahora,
        _fbWrite: true,
      });
      return { success: true, message: 'Comprobante anexado. La factura vuelve a revisión.' };
    } catch (err: any) {
      this.logger.error(`[billing] addComprobante ${key} falló: ${err?.message}`);
      return { success: false, message: err?.message || 'No se pudo anexar el comprobante.' };
    }
  }

  async remove(id: string): Promise<{ success: boolean; message?: string }> {
    if (!this.firebase.isEnabled()) return { success: false, message: 'Servicio no disponible.' };
    const key = this.safeKey(id);
    if (!key) return { success: false, message: 'ID requerido.' };
    try {
      await this.firebase.db().ref(`${MIRROR_FACTURAS}/${key}`).remove();
      return { success: true, message: 'Factura eliminada.' };
    } catch (err: any) {
      this.logger.error(`[billing] delete ${key} falló: ${err?.message}`);
      return { success: false, message: err?.message || 'No se pudo eliminar la factura.' };
    }
  }

  // ===========================================================================
  // SUSCRIPCIÓN DEL CONJUNTO (control de pago SaaS)
  //
  // Cada conjunto (mirror/conjuntos/{key}) guarda:
  //   pagadoHasta  (ISO date, YYYY-MM-DD): hasta cuándo está pago.
  //   bloqueado    (bool): true si venció el pago y pasaron los días de gracia.
  //
  // Regla de acceso: un conjunto está AL DÍA si hoy <= pagadoHasta, O si estamos
  // dentro de los primeros DIAS_GRACIA días del mes en curso (gracia para pagar).
  //
  // Arranque seguro: los conjuntos SIN pagadoHasta (los que ya existían antes de
  // montar este cobro) arrancan con pagadoHasta = fin del PRÓXIMO mes, para no
  // bloquear a nadie ahora. La validación real empieza el mes siguiente.
  // ===========================================================================

  /** Primer día del mes a las 00:00 (hora local del servidor). */
  private inicioMes(d: Date): Date {
    return new Date(d.getFullYear(), d.getMonth(), 1);
  }

  /** Último día del mes (a las 23:59:59) de la fecha dada. */
  private finMes(d: Date): Date {
    return new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999);
  }

  /** Suma `n` meses a una fecha conservando el día (ajusta fin de mes). */
  private sumarMeses(d: Date, n: number): Date {
    const r = new Date(d.getTime());
    const dia = r.getDate();
    r.setDate(1);
    r.setMonth(r.getMonth() + n);
    const ultimo = new Date(r.getFullYear(), r.getMonth() + 1, 0).getDate();
    r.setDate(Math.min(dia, ultimo));
    return r;
  }

  private toISODate(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  private parseDate(raw: unknown): Date | null {
    const s = String(raw ?? '').trim();
    if (!s) return null;
    const d = new Date(s.length <= 10 ? `${s}T23:59:59` : s);
    return isNaN(d.getTime()) ? null : d;
  }

  /** Busca el nodo del conjunto (por id o nombre). */
  private async findConjunto(conjunto: string): Promise<{ key: string; value: any } | null> {
    const snap = await this.firebase.db().ref(MIRROR_CONJUNTOS).get();
    if (!snap.exists()) return null;
    const norm = (s: unknown) => String(s ?? '').trim().toLowerCase();
    const target = norm(conjunto);
    const all = snap.val() || {};
    for (const k of Object.keys(all)) {
      const v = all[k];
      if (norm(v.id) === target || norm(v.nombre) === target) return { key: k, value: v };
    }
    return null;
  }

  /**
   * Decide si un conjunto está al día dado su pagadoHasta y la fecha actual.
   * Al día si: hoy <= pagadoHasta, o estamos en los primeros DIAS_GRACIA del mes.
   */
  private estaAlDia(pagadoHasta: Date | null, hoy: Date): boolean {
    if (hoy.getDate() <= DIAS_GRACIA) return true; // gracia de inicio de mes
    if (!pagadoHasta) return false;
    return hoy.getTime() <= pagadoHasta.getTime();
  }

  /**
   * Garantiza que el conjunto tenga pagadoHasta. Si no lo tiene (conjunto previo
   * al cobro), lo inicializa al fin del PRÓXIMO mes (arranque seguro) y lo
   * persiste. Devuelve el nodo del conjunto con su pagadoHasta efectivo.
   */
  private async ensureDefaultSuscripcion(
    found: { key: string; value: any },
  ): Promise<{ pagadoHasta: Date; seedeado: boolean }> {
    const actual = this.parseDate(found.value?.pagadoHasta);
    if (actual) return { pagadoHasta: actual, seedeado: false };
    // Arranque seguro: fin del próximo mes.
    const ahora = new Date();
    const finProximo = this.finMes(this.sumarMeses(this.inicioMes(ahora), 1));
    try {
      await this.firebase.db().ref(`${MIRROR_CONJUNTOS}/${found.key}`).update({
        pagadoHasta: this.toISODate(finProximo),
        bloqueado: false,
        _fbWrite: true,
      });
    } catch (e: any) {
      this.logger.warn(`[billing] ensureDefaultSuscripcion ${found.key}: ${e?.message}`);
    }
    return { pagadoHasta: finProximo, seedeado: true };
  }

  /**
   * Estado de suscripción de un conjunto (lo consume la app y el login).
   * Aplica arranque seguro si el conjunto no tenía pagadoHasta.
   */
  async getEstadoSuscripcion(conjunto: string): Promise<{
    success: boolean;
    conjunto: string;
    alDia: boolean;
    bloqueado: boolean;
    pagadoHasta: string;
    diasGracia: number;
    message?: string;
  }> {
    const base = {
      success: true,
      conjunto: String(conjunto ?? ''),
      alDia: true,
      bloqueado: false,
      pagadoHasta: '',
      diasGracia: DIAS_GRACIA,
    };
    if (!this.firebase.isEnabled()) return { ...base, success: false, message: 'Servicio no disponible.' };
    if (!String(conjunto ?? '').trim()) return { ...base, success: false, message: 'Conjunto requerido.' };
    const found = await this.findConjunto(conjunto);
    if (!found) {
      // Conjunto desconocido: no bloquear (fail-open), pero avisar.
      return { ...base, message: 'Conjunto no encontrado.' };
    }
    const { pagadoHasta } = await this.ensureDefaultSuscripcion(found);
    const hoy = new Date();
    const alDia = this.estaAlDia(pagadoHasta, hoy);
    return {
      ...base,
      alDia,
      bloqueado: !alDia,
      pagadoHasta: this.toISODate(pagadoHasta),
    };
  }

  /**
   * Extiende la suscripción del conjunto al confirmar una factura.
   * El nuevo pagadoHasta = max(hoy, pagadoHasta actual) + (1 o 12) meses.
   * También limpia bloqueado.
   */
  async extenderSuscripcion(
    conjunto: string,
    ciclo: 'mensual' | 'anual',
  ): Promise<{ success: boolean; message?: string; pagadoHasta?: string }> {
    if (!this.firebase.isEnabled()) return { success: false, message: 'Servicio no disponible.' };
    const found = await this.findConjunto(conjunto);
    if (!found) return { success: false, message: 'El conjunto no existe.' };
    const hoy = new Date();
    const actual = this.parseDate(found.value?.pagadoHasta);
    const desde = actual && actual.getTime() > hoy.getTime() ? actual : hoy;
    const meses = ciclo === 'anual' ? 12 : 1;
    const nuevo = this.finMes(this.sumarMeses(desde, meses));
    try {
      await this.firebase.db().ref(`${MIRROR_CONJUNTOS}/${found.key}`).update({
        pagadoHasta: this.toISODate(nuevo),
        bloqueado: false,
        _fbWrite: true,
      });
      return { success: true, pagadoHasta: this.toISODate(nuevo) };
    } catch (err: any) {
      this.logger.error(`[billing] extenderSuscripcion ${conjunto} falló: ${err?.message}`);
      return { success: false, message: err?.message || 'No se pudo extender la suscripción.' };
    }
  }

  /**
   * Recorre todos los conjuntos y actualiza su flag `bloqueado` según su
   * pagadoHasta (+ gracia). Idempotente. Lo ejecuta el cron diario y se puede
   * disparar manualmente para pruebas.
   */
  async recomputarBloqueos(): Promise<{ success: boolean; revisados: number; bloqueados: number; message?: string }> {
    if (!this.firebase.isEnabled()) return { success: false, revisados: 0, bloqueados: 0, message: 'Servicio no disponible.' };
    const ref = this.firebase.db().ref(MIRROR_CONJUNTOS);
    const snap = await ref.get();
    if (!snap.exists()) return { success: true, revisados: 0, bloqueados: 0 };
    const all = snap.val() || {};
    const hoy = new Date();
    let revisados = 0;
    let bloqueados = 0;
    for (const key of Object.keys(all)) {
      const v = all[key] || {};
      revisados++;
      let pagadoHasta = this.parseDate(v.pagadoHasta);
      const updates: Record<string, any> = {};
      // Arranque seguro para conjuntos sin pagadoHasta.
      if (!pagadoHasta) {
        pagadoHasta = this.finMes(this.sumarMeses(this.inicioMes(hoy), 1));
        updates.pagadoHasta = this.toISODate(pagadoHasta);
      }
      const alDia = this.estaAlDia(pagadoHasta, hoy);
      const deberiaBloquear = !alDia;
      if (deberiaBloquear) bloqueados++;
      if (v.bloqueado !== deberiaBloquear) updates.bloqueado = deberiaBloquear;
      if (Object.keys(updates).length > 0) {
        updates._fbWrite = true;
        try {
          await ref.child(key).update(updates);
        } catch (e: any) {
          this.logger.warn(`[billing] recomputarBloqueos ${key}: ${e?.message}`);
        }
      }
    }
    this.logger.log(`[billing] recomputarBloqueos: ${revisados} conjuntos, ${bloqueados} bloqueados.`);
    return { success: true, revisados, bloqueados };
  }

  /**
   * Cron diario (03:00). Marca/desmarca conjuntos bloqueados según su pago.
   * La expresión se puede sobreescribir con BILLING_CRON (default 3am diario).
   */
  @Cron(process.env.BILLING_CRON || '0 3 * * *')
  async cronRecomputarBloqueos(): Promise<void> {
    if (!this.firebase.isEnabled()) return;
    try {
      await this.recomputarBloqueos();
    } catch (e: any) {
      this.logger.error(`[billing] cron recomputarBloqueos falló: ${e?.message}`);
    }
  }
}
