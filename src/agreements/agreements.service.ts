import { Injectable, Logger } from '@nestjs/common';
import { FirebaseService } from '../firebase/firebase.service';
import { SheetsService } from '../sheets/sheets.service';

/**
 * CRUD de acuerdos de pago contra Firebase (RTDB mirror/acuerdos).
 *
 * Modelo extendido (refinanciamiento con cuotas + amortización + condonación
 * condicional + soporte de firma). Conserva los campos del modelo plano
 * original (id, usuario, tipo, descripcion, monto, fechaInicio, fechaFin,
 * estado, aplicaA, createdBy, createdAt) para no romper el sync heredado.
 *
 * Al crear un acuerdo, este servicio resuelve las SUSCRIPCIONES push de los
 * usuarios afectadas leyéndolas de la hoja 'citofonia' (dato_5==='subscription',
 * dato_3 = payload push). El sync NO espeja ese payload por seguridad, así que
 * se lee directamente de Sheets. El envío del push lo sigue haciendo el frontend
 * vía /api/send-push (Vercel), al que se le pasan estas suscripciones.
 */
const MIRROR_ACUERDOS = 'mirror/acuerdos';

@Injectable()
export class AgreementsService {
  private readonly logger = new Logger(AgreementsService.name);

  constructor(
    private readonly firebase: FirebaseService,
    private readonly sheets: SheetsService,
  ) {}

  private safeKey(raw: unknown): string {
    return String(raw ?? '').trim().replace(/[.#$/\[\]]/g, '_');
  }

  /**
   * Construye el registro a persistir. Mezcla el modelo plano original con los
   * campos extendidos (cuotas/amortización). Los numéricos se normalizan para
   * que el frontend siempre reciba el tipo esperado.
   */
  private buildRecord(dto: any): Record<string, any> {
    const montoTotal = dto.montoTotal ?? dto.monto ?? 0;
    const abonoInicialMonto = dto.abonoInicialMonto ?? 0;
    const saldoPendiente =
      dto.saldoPendiente ?? Math.max(0, Number(montoTotal) - Number(abonoInicialMonto));
    return {
      id: String(dto.id),
      conjunto: String(dto.conjunto ?? ''),
      usuario: String(dto.usuario ?? ''),
      unidad: String(dto.unidad ?? ''),
      tipo: dto.tipo ?? 'refinanciamiento',
      descripcion: dto.descripcion ?? '',
      // --- compatibilidad con el modelo plano anterior ---
      monto: String(montoTotal ?? '0'),
      fechaInicio: dto.fechaInicio ?? dto.fechaPrimerCuota ?? '',
      fechaFin: dto.fechaFin ?? '',
      estado: dto.estado ?? 'activo',
      aplicaA: String(dto.aplicaA ?? dto.usuario ?? 'todos'),
      // --- modelo extendido: cuotas + amortización + condonación ---
      montoTotal: Number(montoTotal ?? 0),
      abonoInicialPct: Number(dto.abonoInicialPct ?? 0),
      abonoInicialMonto: Number(abonoInicialMonto ?? 0),
      abonoInicialEstado: dto.abonoInicialEstado ?? 'pendiente',
      saldoPendiente: Number(saldoPendiente ?? 0),
      numCuotas: Number(dto.numCuotas ?? 0),
      frecuenciaCuotas: dto.frecuenciaCuotas ?? 'mensual',
      montoCuota: Number(dto.montoCuota ?? 0),
      fechaPrimerCuota: dto.fechaPrimerCuota ?? '',
      condonacionMora: !!dto.condonacionMora,
      condonacionMonto: Number(dto.condonacionMonto ?? 0),
      condonacionCondicionada: dto.condonacionCondicionada !== false,
      diasGracia: Number(dto.diasGracia ?? 5),
      cuotas: Array.isArray(dto.cuotas) ? dto.cuotas : [],
      firmaUrl: dto.firmaUrl ?? '',
      fechaAprobacion: dto.fechaAprobacion ?? '',
      createdBy: String(dto.createdBy ?? ''),
      createdAt: dto.createdAt ?? new Date().toISOString(),
      fechaModificacion: dto.fechaModificacion ?? new Date().toISOString(),
      ultimoUsuario: String(dto.ultimoUsuario ?? dto.createdBy ?? ''),
      _fbWrite: true,
    };
  }

  /** Lista de acuerdos. Filtra por conjunto y/o usuario. */
  async list(filters: { usuario?: string; conjunto?: string }): Promise<any[]> {
    if (!this.firebase.isEnabled()) throw new Error('Servicio no disponible.');
    const snap = await this.firebase.db().ref(MIRROR_ACUERDOS).get();
    if (!snap.exists()) return [];
    let acuerdos = Object.values(snap.val() || {}) as any[];
    const norm = (s: unknown) => String(s ?? '').trim().toLowerCase();
    if (filters.conjunto) {
      const c = norm(filters.conjunto);
      acuerdos = acuerdos.filter((a) => norm(a.conjunto) === c);
    }
    if (filters.usuario) {
      const u = norm(filters.usuario);
      acuerdos = acuerdos.filter(
        (a) => norm(a.aplicaA) === 'todos' || norm(a.aplicaA) === u || norm(a.usuario) === u,
      );
    }
    // Campos nombrados + alias posicionales dato_n (compat parsing por posición).
    return acuerdos.map((a) => {
      const { _fbWrite, ...rest } = a;
      return {
        ...rest,
        dato_1: rest.id ?? '',
        dato_2: rest.usuario ?? '',
        dato_3: rest.tipo ?? '',
        dato_4: rest.descripcion ?? '',
        dato_5: rest.monto ?? '',
        dato_6: rest.fechaInicio ?? '',
        dato_7: rest.fechaFin ?? '',
        dato_8: rest.estado ?? '',
        dato_9: rest.aplicaA ?? '',
        dato_10: rest.createdBy ?? '',
        dato_11: rest.createdAt ?? '',
      };
    });
  }

  /**
   * Lee las suscripciones push de la hoja 'citofonia' para los afectados.
   * @param aplicaA 'todos' o un username.
   * Devuelve los payloads de suscripción (objeto ya parseado) listos para push.
   */
  async getPushSubscriptions(aplicaA: string): Promise<any[]> {
    try {
      const rows = await this.sheets.read('citofonia');
      const norm = (s: unknown) => String(s ?? '').trim().toLowerCase();
      const target = norm(aplicaA);
      const subs: any[] = [];
      for (const r of rows) {
        if (norm((r as any).dato_5) !== 'subscription') continue;
        if (target !== 'todos' && norm((r as any).dato_2) !== target) continue;
        try {
          const payload = JSON.parse((r as any).dato_3 || '{}');
          if (payload && payload.endpoint) subs.push(payload);
        } catch {
          // payload inválido: se ignora
        }
      }
      return subs;
    } catch (e: any) {
      this.logger.warn(`getPushSubscriptions(${aplicaA}) falló: ${e?.message}`);
      return [];
    }
  }

  async create(dto: any): Promise<{ success: boolean; message?: string; id?: string; subscriptions?: any[] }> {
    if (!this.firebase.isEnabled()) return { success: false, message: 'Servicio no disponible.' };
    const id = String(dto.id || `agr_${Date.now()}`);
    try {
      await this.firebase.db().ref(`${MIRROR_ACUERDOS}/${this.safeKey(id)}`).set(this.buildRecord({ ...dto, id }));
      // Resolver suscripciones push de los afectados para que el frontend las envíe.
      const subscriptions = await this.getPushSubscriptions(String(dto.aplicaA || dto.usuario || 'todos'));
      return { success: true, id, message: 'Acuerdo creado.', subscriptions };
    } catch (err: any) {
      this.logger.error(`[agreements] create falló: ${err?.message}`);
      return { success: false, message: err?.message || 'No se pudo crear el acuerdo.' };
    }
  }

  async update(id: string, dto: any): Promise<{ success: boolean; message?: string }> {
    if (!this.firebase.isEnabled()) return { success: false, message: 'Servicio no disponible.' };
    const key = this.safeKey(id);
    if (!key) return { success: false, message: 'ID requerido.' };
    const ref = this.firebase.db().ref(`${MIRROR_ACUERDOS}/${key}`);
    const snap = await ref.get();
    if (!snap.exists()) return { success: false, message: 'El acuerdo no existe.' };
    try {
      const patch: Record<string, any> = { _fbWrite: true };
      [
        'usuario', 'unidad', 'tipo', 'descripcion', 'monto', 'montoTotal',
        'abonoInicialPct', 'abonoInicialMonto', 'abonoInicialEstado', 'saldoPendiente',
        'numCuotas', 'frecuenciaCuotas', 'montoCuota', 'fechaPrimerCuota', 'fechaInicio',
        'fechaFin', 'estado', 'aplicaA', 'condonacionMora', 'condonacionMonto',
        'condonacionCondicionada', 'diasGracia', 'cuotas', 'firmaUrl', 'fechaAprobacion',
        'conjunto',
      ].forEach((f) => {
        if (dto[f] !== undefined) patch[f] = dto[f];
      });
      patch.fechaModificacion = new Date().toISOString();
      patch.ultimoUsuario = String(dto.ultimoUsuario ?? dto.createdBy ?? '');
      await ref.update(patch);
      return { success: true, message: 'Acuerdo actualizado.' };
    } catch (err: any) {
      this.logger.error(`[agreements] update ${key} falló: ${err?.message}`);
      return { success: false, message: err?.message || 'No se pudo actualizar el acuerdo.' };
    }
  }

  async remove(id: string): Promise<{ success: boolean; message?: string }> {
    if (!this.firebase.isEnabled()) return { success: false, message: 'Servicio no disponible.' };
    const key = this.safeKey(id);
    if (!key) return { success: false, message: 'ID requerido.' };
    try {
      await this.firebase.db().ref(`${MIRROR_ACUERDOS}/${key}`).remove();
      return { success: true, message: 'Acuerdo eliminado.' };
    } catch (err: any) {
      this.logger.error(`[agreements] delete ${key} falló: ${err?.message}`);
      return { success: false, message: err?.message || 'No se pudo eliminar el acuerdo.' };
    }
  }
}
