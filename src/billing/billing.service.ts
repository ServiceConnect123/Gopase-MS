import { Injectable, Logger } from '@nestjs/common';
import { FirebaseService } from '../firebase/firebase.service';

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

export const FACTURA_ESTADOS = ['pendiente', 'confirmada', 'rechazada'] as const;
export type FacturaEstado = (typeof FACTURA_ESTADOS)[number];

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(private readonly firebase: FirebaseService) {}

  private safeKey(raw: unknown): string {
    return String(raw ?? '').trim().replace(/[.#$/\[\]]/g, '_');
  }

  private normEstado(raw: unknown): FacturaEstado {
    const s = String(raw ?? '').trim().toLowerCase();
    return (FACTURA_ESTADOS as readonly string[]).includes(s) ? (s as FacturaEstado) : 'pendiente';
  }

  private buildRecord(dto: any): Record<string, any> {
    const ahora = new Date().toISOString();
    return {
      id: String(dto.id),
      conjunto: String(dto.conjunto ?? ''),
      monto: Number(dto.monto) || 0,
      moneda: String(dto.moneda ?? 'COP'),
      periodo: String(dto.periodo ?? ''),
      concepto: String(dto.concepto ?? ''),
      estado: this.normEstado(dto.estado),
      comprobanteUrl: String(dto.comprobanteUrl ?? ''),
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
      return { ...rest, estado: this.normEstado(rest.estado), monto: Number(rest.monto) || 0 };
    });
  }

  async create(dto: any): Promise<{ success: boolean; message?: string; id?: string }> {
    if (!this.firebase.isEnabled()) return { success: false, message: 'Servicio no disponible.' };
    if (!String(dto?.conjunto ?? '').trim()) return { success: false, message: 'El conjunto es requerido.' };
    if (!(Number(dto?.monto) > 0)) return { success: false, message: 'El monto debe ser mayor a 0.' };

    const id = String(dto.id || Date.now().toString());
    // Una factura creada por el admin arranca SIEMPRE en 'pendiente'.
    const record = this.buildRecord({ ...dto, id, estado: 'pendiente', revisadoPor: '', revisadoEn: '' });
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
    dto: { estado: 'confirmada' | 'rechazada'; revisadoPor?: string; nota?: string },
  ): Promise<{ success: boolean; message?: string }> {
    if (!this.firebase.isEnabled()) return { success: false, message: 'Servicio no disponible.' };
    const key = this.safeKey(id);
    if (!key) return { success: false, message: 'ID requerido.' };
    const nuevo = this.normEstado(dto?.estado);
    if (nuevo !== 'confirmada' && nuevo !== 'rechazada') {
      return { success: false, message: 'Estado inválido (confirmada | rechazada).' };
    }
    const ref = this.firebase.db().ref(`${MIRROR_FACTURAS}/${key}`);
    const snap = await ref.get();
    if (!snap.exists()) return { success: false, message: 'La factura no existe.' };
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
      return { success: true, message: nuevo === 'confirmada' ? 'Factura confirmada.' : 'Factura rechazada.' };
    } catch (err: any) {
      this.logger.error(`[billing] review ${key} falló: ${err?.message}`);
      return { success: false, message: err?.message || 'No se pudo actualizar la factura.' };
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
