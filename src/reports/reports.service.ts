import { Injectable, Logger } from '@nestjs/common';
import { FirebaseService } from '../firebase/firebase.service';

/**
 * CRUD de reportes contra Firebase (RTDB mirror/reportes).
 * Reemplaza getReportes/createData('reportes')/updateReport/deleteReport del
 * frontend (Sheets). Usado por reports.tsx, expenses.tsx y surveillance.tsx
 * (reportes generales, gastos/ingresos, turnos y rondas de vigilancia).
 *
 * Campos (alineados con mapReporte del SyncService):
 *   id, titulo, fecha, usuario (autor/username), descripcion, conjunto,
 *   tipo, ubicacion, estado
 */
const MIRROR_REPORTES = 'mirror/reportes';

@Injectable()
export class ReportsService {
  private readonly logger = new Logger(ReportsService.name);

  constructor(private readonly firebase: FirebaseService) {}

  private safeKey(raw: unknown): string {
    return String(raw ?? '').trim().replace(/[.#$/\[\]]/g, '_');
  }

  private buildRecord(dto: any): Record<string, any> {
    return {
      id: String(dto.id),
      titulo: dto.titulo ?? '',
      fecha: dto.fecha ?? '',
      usuario: String(dto.usuario ?? dto.autor ?? ''),
      descripcion: dto.descripcion ?? '',
      conjunto: dto.conjunto ?? '',
      tipo: dto.tipo ?? '',
      ubicacion: dto.ubicacion ?? '',
      estado: dto.estado ?? '',
      _fbWrite: true,
    };
  }

  /** Lista de reportes. Filtra por conjunto y/o usuario si se pasan. */
  async list(filters: { conjunto?: string; usuario?: string }): Promise<any[]> {
    if (!this.firebase.isEnabled()) throw new Error('Servicio no disponible.');
    const snap = await this.firebase.db().ref(MIRROR_REPORTES).get();
    if (!snap.exists()) return [];
    let reportes = Object.values(snap.val() || {}) as any[];
    const norm = (s: unknown) => String(s ?? '').trim().toLowerCase();
    if (filters.conjunto) reportes = reportes.filter((r) => norm(r.conjunto) === norm(filters.conjunto));
    if (filters.usuario) reportes = reportes.filter((r) => norm(r.usuario) === norm(filters.usuario));
    return reportes.map((r) => {
      const { _fbWrite, ...rest } = r;
      return rest;
    });
  }

  async create(dto: any): Promise<{ success: boolean; message?: string; id?: string }> {
    if (!this.firebase.isEnabled()) return { success: false, message: 'Servicio no disponible.' };
    const id = String(dto.id || Date.now().toString());
    try {
      await this.firebase.db().ref(`${MIRROR_REPORTES}/${this.safeKey(id)}`).set(this.buildRecord({ ...dto, id }));
      return { success: true, id, message: 'Reporte creado.' };
    } catch (err: any) {
      this.logger.error(`[reports] create falló: ${err?.message}`);
      return { success: false, message: err?.message || 'No se pudo crear el reporte.' };
    }
  }

  async update(id: string, dto: any): Promise<{ success: boolean; message?: string }> {
    if (!this.firebase.isEnabled()) return { success: false, message: 'Servicio no disponible.' };
    const key = this.safeKey(id);
    if (!key) return { success: false, message: 'ID requerido.' };
    const ref = this.firebase.db().ref(`${MIRROR_REPORTES}/${key}`);
    const snap = await ref.get();
    if (!snap.exists()) return { success: false, message: 'El reporte no existe.' };
    try {
      // Merge por campo presente (updateReport suele tocar solo el estado).
      const patch: Record<string, any> = { _fbWrite: true };
      ['titulo', 'fecha', 'usuario', 'descripcion', 'conjunto', 'tipo', 'ubicacion', 'estado'].forEach((f) => {
        const v = dto[f] ?? (f === 'usuario' ? dto.autor : undefined);
        if (v !== undefined) patch[f] = v;
      });
      await ref.update(patch);
      return { success: true, message: 'Reporte actualizado.' };
    } catch (err: any) {
      this.logger.error(`[reports] update ${key} falló: ${err?.message}`);
      return { success: false, message: err?.message || 'No se pudo actualizar el reporte.' };
    }
  }

  async remove(id: string): Promise<{ success: boolean; message?: string }> {
    if (!this.firebase.isEnabled()) return { success: false, message: 'Servicio no disponible.' };
    const key = this.safeKey(id);
    if (!key) return { success: false, message: 'ID requerido.' };
    try {
      await this.firebase.db().ref(`${MIRROR_REPORTES}/${key}`).remove();
      return { success: true, message: 'Reporte eliminado.' };
    } catch (err: any) {
      this.logger.error(`[reports] delete ${key} falló: ${err?.message}`);
      return { success: false, message: err?.message || 'No se pudo eliminar el reporte.' };
    }
  }
}
