import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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

export const FACTURA_ESTADOS = ['pendiente', 'confirmada', 'rechazada', 'devuelta'] as const;
export type FacturaEstado = (typeof FACTURA_ESTADOS)[number];

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
      if (nuevo === 'confirmada') {
        const planId = String(factura.planIdSolicitado ?? '').trim();
        const conjunto = String(factura.conjunto ?? '').trim();
        if (planId && conjunto) {
          try {
            const r = await this.plans.assign(conjunto, planId);
            planMsg = r.success ? ' El plan fue asignado al conjunto.' : ` (No se pudo asignar el plan: ${r.message})`;
          } catch (e: any) {
            planMsg = ` (No se pudo asignar el plan: ${e?.message})`;
          }
        }
      }

      const base =
        nuevo === 'confirmada' ? 'Factura confirmada.'
        : nuevo === 'rechazada' ? 'Factura rechazada.'
        : 'Factura devuelta: el admin puede anexar el pago restante.';
      return { success: true, message: base + planMsg };
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
}
