import { Injectable, Logger } from '@nestjs/common';
import { FirebaseService } from '../firebase/firebase.service';

/**
 * CRUD de invitados (hoja 'vigilantes') contra Firebase (RTDB mirror/invitados).
 * Reemplaza getData('vigilantes')/createData('vigilantes')/update/delete del
 * frontend (Sheets). Usado por guests.tsx (registro de invitados, marcar ingreso
 * en portería, eliminar).
 *
 * Campos (alineados con mapInvitado del SyncService):
 *   id, nombre, placa, fecha, propietario (username), parcela, estado,
 *   horaIngreso, nota
 */
const MIRROR_INVITADOS = 'mirror/invitados';

@Injectable()
export class GuestsService {
  private readonly logger = new Logger(GuestsService.name);

  constructor(private readonly firebase: FirebaseService) {}

  private safeKey(raw: unknown): string {
    return String(raw ?? '').trim().replace(/[.#$/\[\]]/g, '_');
  }

  private buildRecord(dto: any): Record<string, any> {
    return {
      id: String(dto.id),
      nombre: dto.nombre ?? '',
      placa: dto.placa ?? '',
      fecha: dto.fecha ?? '',
      propietario: String(dto.propietario ?? ''),
      parcela: dto.parcela ?? '',
      estado: dto.estado ?? 'Pendiente',
      horaIngreso: dto.horaIngreso ?? '',
      nota: dto.nota ?? '',
      _fbWrite: true,
    };
  }

  /** Lista de invitados. Filtra por propietario (username) si se pasa. */
  async list(filters: { propietario?: string }): Promise<any[]> {
    if (!this.firebase.isEnabled()) throw new Error('Servicio no disponible.');
    const snap = await this.firebase.db().ref(MIRROR_INVITADOS).get();
    if (!snap.exists()) return [];
    let invitados = Object.values(snap.val() || {}) as any[];
    if (filters.propietario) {
      const norm = (s: unknown) => String(s ?? '').trim().toLowerCase();
      invitados = invitados.filter((g) => norm(g.propietario) === norm(filters.propietario));
    }
    // Campos nombrados + alias posicionales dato_n (compat parsing por posición).
    return invitados.map((g) => {
      const { _fbWrite, ...rest } = g;
      return {
        ...rest,
        dato_1: rest.id ?? '',
        dato_2: rest.nombre ?? '',
        dato_3: rest.placa ?? '',
        dato_4: rest.fecha ?? '',
        dato_5: rest.propietario ?? '',
        dato_6: rest.parcela ?? '',
        dato_7: rest.estado ?? '',
        dato_8: rest.horaIngreso ?? '',
        dato_9: rest.nota ?? '',
      };
    });
  }

  async create(dto: any): Promise<{ success: boolean; message?: string; id?: string }> {
    if (!this.firebase.isEnabled()) return { success: false, message: 'Servicio no disponible.' };
    const id = String(dto.id || Date.now().toString());
    try {
      await this.firebase.db().ref(`${MIRROR_INVITADOS}/${this.safeKey(id)}`).set(this.buildRecord({ ...dto, id }));
      return { success: true, id, message: 'Invitado registrado.' };
    } catch (err: any) {
      this.logger.error(`[guests] create falló: ${err?.message}`);
      return { success: false, message: err?.message || 'No se pudo registrar el invitado.' };
    }
  }

  /** Actualiza un invitado (reescribe; usado para marcar ingreso: estado + hora). */
  async update(id: string, dto: any): Promise<{ success: boolean; message?: string }> {
    if (!this.firebase.isEnabled()) return { success: false, message: 'Servicio no disponible.' };
    const key = this.safeKey(id);
    if (!key) return { success: false, message: 'ID requerido.' };
    const ref = this.firebase.db().ref(`${MIRROR_INVITADOS}/${key}`);
    const snap = await ref.get();
    if (!snap.exists()) return { success: false, message: 'El invitado no existe.' };
    try {
      // Merge por campo presente (marcar ingreso solo toca estado/horaIngreso).
      const patch: Record<string, any> = { _fbWrite: true };
      ['nombre', 'placa', 'fecha', 'propietario', 'parcela', 'estado', 'horaIngreso', 'nota'].forEach((f) => {
        if (dto[f] !== undefined) patch[f] = dto[f];
      });
      await ref.update(patch);
      return { success: true, message: 'Invitado actualizado.' };
    } catch (err: any) {
      this.logger.error(`[guests] update ${key} falló: ${err?.message}`);
      return { success: false, message: err?.message || 'No se pudo actualizar el invitado.' };
    }
  }

  async remove(id: string): Promise<{ success: boolean; message?: string }> {
    if (!this.firebase.isEnabled()) return { success: false, message: 'Servicio no disponible.' };
    const key = this.safeKey(id);
    if (!key) return { success: false, message: 'ID requerido.' };
    try {
      await this.firebase.db().ref(`${MIRROR_INVITADOS}/${key}`).remove();
      return { success: true, message: 'Invitado eliminado.' };
    } catch (err: any) {
      this.logger.error(`[guests] delete ${key} falló: ${err?.message}`);
      return { success: false, message: err?.message || 'No se pudo eliminar el invitado.' };
    }
  }
}
