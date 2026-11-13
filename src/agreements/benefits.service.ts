import { Injectable, Logger } from '@nestjs/common';
import { FirebaseService } from '../firebase/firebase.service';

/**
 * CRUD de beneficios globales (descuentos/estímulos para la comunidad) contra
 * Firebase (RTDB mirror/beneficios). Cada beneficio es una regla configurable
 * (porcentaje, monto fijo, mes gratis o exención de mora) con vigencia y un
 * interruptor de activado/desactivado, aplicable a todos los propietarios o a
 * un usuario concreto.
 */
const MIRROR_BENEFICIOS = 'mirror/beneficios';

@Injectable()
export class BenefitsService {
  private readonly logger = new Logger(BenefitsService.name);

  constructor(private readonly firebase: FirebaseService) {}

  private safeKey(raw: unknown): string {
    return String(raw ?? '').trim().replace(/[.#$/\[\]]/g, '_');
  }

  private buildRecord(dto: any): Record<string, any> {
    return {
      id: String(dto.id),
      conjunto: String(dto.conjunto ?? ''),
      nombre: String(dto.nombre ?? ''),
      descripcion: dto.descripcion ?? '',
      tipo: dto.tipo ?? 'porcentaje', // porcentaje | monto_fijo | mes_gratis | exencion_mora
      valor: Number(dto.valor ?? 0),
      modalidad: dto.modalidad ?? 'automatico', // automatico | manual
      regla: dto.regla && typeof dto.regla === 'object' ? dto.regla : { tipo: 'manual', params: {} },
      aplicaA: String(dto.aplicaA ?? 'todos'),
      fechaInicio: dto.fechaInicio ?? '',
      fechaFin: dto.fechaFin ?? '',
      activo: dto.activo !== false,
      aplicacionesMes: Number(dto.aplicacionesMes ?? 0),
      solicitantes: Array.isArray(dto.solicitantes) ? dto.solicitantes : [],
      createdBy: String(dto.createdBy ?? ''),
      createdAt: dto.createdAt ?? new Date().toISOString(),
      fechaModificacion: dto.fechaModificacion ?? new Date().toISOString(),
      ultimoUsuario: String(dto.ultimoUsuario ?? dto.createdBy ?? ''),
      _fbWrite: true,
    };
  }

  /** Lista de beneficios. Filtra por conjunto. */
  async list(filters: { conjunto?: string }): Promise<any[]> {
    if (!this.firebase.isEnabled()) throw new Error('Servicio no disponible.');
    const snap = await this.firebase.db().ref(MIRROR_BENEFICIOS).get();
    if (!snap.exists()) return [];
    let beneficios = Object.values(snap.val() || {}) as any[];
    if (filters.conjunto) {
      const norm = (s: unknown) => String(s ?? '').trim().toLowerCase();
      const c = norm(filters.conjunto);
      beneficios = beneficios.filter((b) => norm(b.conjunto) === c);
    }
    return beneficios.map((b) => {
      const { _fbWrite, ...rest } = b;
      return rest;
    });
  }

  async create(dto: any): Promise<{ success: boolean; message?: string; id?: string }> {
    if (!this.firebase.isEnabled()) return { success: false, message: 'Servicio no disponible.' };
    const id = String(dto.id || `ben_${Date.now()}`);
    try {
      await this.firebase.db().ref(`${MIRROR_BENEFICIOS}/${this.safeKey(id)}`).set(this.buildRecord({ ...dto, id }));
      return { success: true, id, message: 'Beneficio creado.' };
    } catch (err: any) {
      this.logger.error(`[benefits] create falló: ${err?.message}`);
      return { success: false, message: err?.message || 'No se pudo crear el beneficio.' };
    }
  }

  async update(id: string, dto: any): Promise<{ success: boolean; message?: string }> {
    if (!this.firebase.isEnabled()) return { success: false, message: 'Servicio no disponible.' };
    const key = this.safeKey(id);
    if (!key) return { success: false, message: 'ID requerido.' };
    const ref = this.firebase.db().ref(`${MIRROR_BENEFICIOS}/${key}`);
    const snap = await ref.get();
    if (!snap.exists()) return { success: false, message: 'El beneficio no existe.' };
    try {
      const patch: Record<string, any> = { _fbWrite: true };
      [
        'nombre', 'descripcion', 'tipo', 'valor', 'modalidad', 'regla',
        'aplicaA', 'fechaInicio', 'fechaFin', 'activo', 'aplicacionesMes',
        'conjunto', 'solicitantes', 'aprobados',
      ].forEach((f) => {
        if (dto[f] !== undefined) patch[f] = dto[f];
      });
      patch.fechaModificacion = new Date().toISOString();
      patch.ultimoUsuario = String(dto.ultimoUsuario ?? dto.createdBy ?? '');
      await ref.update(patch);
      return { success: true, message: 'Beneficio actualizado.' };
    } catch (err: any) {
      this.logger.error(`[benefits] update ${key} falló: ${err?.message}`);
      return { success: false, message: err?.message || 'No se pudo actualizar el beneficio.' };
    }
  }

  async remove(id: string): Promise<{ success: boolean; message?: string }> {
    if (!this.firebase.isEnabled()) return { success: false, message: 'Servicio no disponible.' };
    const key = this.safeKey(id);
    if (!key) return { success: false, message: 'ID requerido.' };
    try {
      await this.firebase.db().ref(`${MIRROR_BENEFICIOS}/${key}`).remove();
      return { success: true, message: 'Beneficio eliminado.' };
    } catch (err: any) {
      this.logger.error(`[benefits] delete ${key} falló: ${err?.message}`);
      return { success: false, message: err?.message || 'No se pudo eliminar el beneficio.' };
    }
  }
}
