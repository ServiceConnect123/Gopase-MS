import { Injectable, Logger } from '@nestjs/common';
import { FirebaseService } from '../firebase/firebase.service';

/**
 * Tipos de recaudo (fondos) por conjunto, en Firebase RTDB mirror/tipos_recaudo.
 *
 * Cada conjunto tiene un fondo por defecto "Administración" (esDefault=true),
 * que no se puede eliminar. El admin puede crear otros (p. ej. Donación, Fondo
 * de reserva), marcarlos visibles para el propietario y fijarles una meta.
 *
 * Campos:
 *   id, conjunto, nombre, esDefault(bool), visibleParaPropietario(bool),
 *   metaMensual(number)
 */
const MIRROR_FUNDS = 'mirror/tipos_recaudo';

/** Nombre canónico del fondo por defecto. */
export const DEFAULT_FUND_NAME = 'Administración';

@Injectable()
export class FundsService {
  private readonly logger = new Logger(FundsService.name);

  constructor(private readonly firebase: FirebaseService) {}

  private safeKey(raw: unknown): string {
    return String(raw ?? '').trim().replace(/[.#$/\[\]]/g, '_');
  }

  private norm(s: unknown): string {
    return String(s ?? '').trim().toLowerCase();
  }

  private buildRecord(dto: any): Record<string, any> {
    // El fondo por defecto (Administración) ES la caja general: nunca puede ser
    // una caja separada.
    const esDefault = dto.esDefault === true;
    return {
      id: String(dto.id),
      conjunto: String(dto.conjunto ?? ''),
      nombre: String(dto.nombre ?? ''),
      esDefault,
      visibleParaPropietario:
        dto.visibleParaPropietario === undefined ? true : dto.visibleParaPropietario === true,
      metaMensual: Number(dto.metaMensual) || 0,
      // cajaPropia: si true, el dinero de este fondo es una CAJA SEPARADA (saldo
      // propio con arrastre, fuera de la caja general). El default nunca lo es.
      cajaPropia: !esDefault && dto.cajaPropia === true,
      _fbWrite: true,
    };
  }

  /**
   * Lista los fondos de un conjunto. Garantiza que exista el fondo por defecto
   * "Administración" (lo crea si falta). Si no se pasa conjunto, lista todos.
   */
  async list(conjunto?: string): Promise<any[]> {
    if (!this.firebase.isEnabled()) throw new Error('Servicio no disponible.');
    const ref = this.firebase.db().ref(MIRROR_FUNDS);
    const snap = await ref.get();
    let fondos = snap.exists() ? (Object.values(snap.val() || {}) as any[]) : [];

    if (conjunto) {
      fondos = fondos.filter((f) => this.norm(f.conjunto) === this.norm(conjunto));

      // Asegura el fondo por defecto del conjunto (idempotente).
      const hasDefault = fondos.some(
        (f) => f.esDefault === true || this.norm(f.nombre) === this.norm(DEFAULT_FUND_NAME),
      );
      if (!hasDefault) {
        const def = this.buildRecord({
          id: `default_${this.safeKey(conjunto)}`,
          conjunto,
          nombre: DEFAULT_FUND_NAME,
          esDefault: true,
          visibleParaPropietario: true,
          metaMensual: 0,
        });
        try {
          await ref.child(this.safeKey(def.id)).set(def);
          fondos.unshift(def);
        } catch (e: any) {
          this.logger.warn(`[funds] no se pudo sembrar el fondo por defecto: ${e?.message}`);
        }
      }
    }

    return fondos
      .map((f) => {
        const { _fbWrite, ...rest } = f;
        return {
          ...rest,
          // Normaliza para fondos antiguos sin el campo. El default nunca es caja propia.
          cajaPropia: rest.esDefault === true ? false : rest.cajaPropia === true,
        };
      })
      // Default primero, luego por nombre.
      .sort((a, b) => {
        if (a.esDefault && !b.esDefault) return -1;
        if (!a.esDefault && b.esDefault) return 1;
        return String(a.nombre).localeCompare(String(b.nombre));
      });
  }

  async create(dto: any): Promise<{ success: boolean; message?: string; id?: string }> {
    if (!this.firebase.isEnabled()) return { success: false, message: 'Servicio no disponible.' };
    if (!String(dto?.nombre ?? '').trim()) return { success: false, message: 'El nombre es requerido.' };
    if (!String(dto?.conjunto ?? '').trim()) return { success: false, message: 'El conjunto es requerido.' };

    // Un fondo creado por el admin NUNCA es default (el default solo lo siembra list()).
    const id = String(dto.id || Date.now().toString());
    const record = this.buildRecord({ ...dto, id, esDefault: false });
    try {
      await this.firebase.db().ref(`${MIRROR_FUNDS}/${this.safeKey(id)}`).set(record);
      const { _fbWrite, ...rest } = record;
      return { success: true, id, message: 'Tipo de recaudo creado.' };
    } catch (err: any) {
      this.logger.error(`[funds] create falló: ${err?.message}`);
      return { success: false, message: err?.message || 'No se pudo crear el tipo de recaudo.' };
    }
  }

  async update(id: string, dto: any): Promise<{ success: boolean; message?: string }> {
    if (!this.firebase.isEnabled()) return { success: false, message: 'Servicio no disponible.' };
    const key = this.safeKey(id);
    if (!key) return { success: false, message: 'ID requerido.' };
    const ref = this.firebase.db().ref(`${MIRROR_FUNDS}/${key}`);
    const snap = await ref.get();
    if (!snap.exists()) return { success: false, message: 'El tipo de recaudo no existe.' };
    const prev = snap.val() || {};
    try {
      const patch: Record<string, any> = { _fbWrite: true };
      // El default no se puede renombrar; los demás sí.
      if (dto.nombre !== undefined && prev.esDefault !== true) patch.nombre = String(dto.nombre);
      if (dto.visibleParaPropietario !== undefined) patch.visibleParaPropietario = dto.visibleParaPropietario === true;
      if (dto.metaMensual !== undefined) patch.metaMensual = Number(dto.metaMensual) || 0;
      // cajaPropia solo aplica a fondos NO default (Administración = caja general).
      if (dto.cajaPropia !== undefined && prev.esDefault !== true) patch.cajaPropia = dto.cajaPropia === true;
      await ref.update(patch);
      return { success: true, message: 'Tipo de recaudo actualizado.' };
    } catch (err: any) {
      this.logger.error(`[funds] update ${key} falló: ${err?.message}`);
      return { success: false, message: err?.message || 'No se pudo actualizar.' };
    }
  }

  async remove(id: string): Promise<{ success: boolean; message?: string }> {
    if (!this.firebase.isEnabled()) return { success: false, message: 'Servicio no disponible.' };
    const key = this.safeKey(id);
    if (!key) return { success: false, message: 'ID requerido.' };
    const ref = this.firebase.db().ref(`${MIRROR_FUNDS}/${key}`);
    const snap = await ref.get();
    if (!snap.exists()) return { success: false, message: 'El tipo de recaudo no existe.' };
    if ((snap.val() || {}).esDefault === true) {
      return { success: false, message: 'El fondo por defecto (Administración) no se puede eliminar.' };
    }
    try {
      await ref.remove();
      return { success: true, message: 'Tipo de recaudo eliminado.' };
    } catch (err: any) {
      this.logger.error(`[funds] delete ${key} falló: ${err?.message}`);
      return { success: false, message: err?.message || 'No se pudo eliminar.' };
    }
  }
}
