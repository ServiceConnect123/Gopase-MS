import { Injectable, Logger } from '@nestjs/common';
import { FirebaseService } from '../firebase/firebase.service';

/**
 * CRUD de roles (colección GLOBAL) contra Firebase (RTDB mirror/roles).
 * Reemplaza getRoles/addRole/updateRole/deleteRole del frontend (Sheets).
 *
 * El espejo (mapRol del SyncService) guarda { id, nombre, permisos } donde
 * `permisos` es el objeto/array ya parseado. Aquí exponemos el shape que el
 * frontend consume: { id, name, permissions }.
 */
const MIRROR_ROLES = 'mirror/roles';

@Injectable()
export class RolesService {
  private readonly logger = new Logger(RolesService.name);

  constructor(private readonly firebase: FirebaseService) {}

  private safeKey(raw: unknown): string {
    return String(raw ?? '').trim().replace(/[.#$/\[\]]/g, '_');
  }

  /** Normaliza permisos a objeto/array (acepta string JSON o valor ya parseado). */
  private normalizePermissions(raw: any): any {
    if (raw == null) return [];
    if (typeof raw === 'string') {
      const s = raw.trim();
      if (!s) return [];
      try {
        return JSON.parse(s);
      } catch {
        return raw;
      }
    }
    return raw;
  }

  /** Convierte un registro del espejo al shape del frontend. */
  private toDto(r: any): { id: string; name: string; permissions: any } {
    return {
      id: String(r.id ?? ''),
      name: r.name ?? r.nombre ?? '',
      permissions: this.normalizePermissions(r.permisos ?? r.permissions),
    };
  }

  /** Registro que se persiste en RTDB (conserva `permisos` como el espejo). */
  private buildRecord(dto: any): Record<string, any> {
    return {
      id: String(dto.id),
      nombre: dto.name ?? dto.nombre ?? '',
      permisos: this.normalizePermissions(dto.permissions ?? dto.permisos),
      _fbWrite: true,
    };
  }

  /** Lista global de roles. */
  async list(): Promise<Array<{ id: string; name: string; permissions: any }>> {
    if (!this.firebase.isEnabled()) throw new Error('Servicio no disponible.');
    const snap = await this.firebase.db().ref(MIRROR_ROLES).get();
    if (!snap.exists()) return [];
    return (Object.values(snap.val() || {}) as any[]).map((r) => this.toDto(r));
  }

  async create(dto: any): Promise<{ success: boolean; message?: string; id?: string }> {
    if (!this.firebase.isEnabled()) return { success: false, message: 'Servicio no disponible.' };
    const id = String(dto.id || Date.now().toString());
    try {
      await this.firebase.db().ref(`${MIRROR_ROLES}/${this.safeKey(id)}`).set(this.buildRecord({ ...dto, id }));
      return { success: true, id, message: 'Rol creado.' };
    } catch (err: any) {
      this.logger.error(`[roles] create falló: ${err?.message}`);
      return { success: false, message: err?.message || 'No se pudo crear el rol.' };
    }
  }

  async update(id: string, dto: any): Promise<{ success: boolean; message?: string }> {
    if (!this.firebase.isEnabled()) return { success: false, message: 'Servicio no disponible.' };
    const key = this.safeKey(id);
    if (!key) return { success: false, message: 'ID requerido.' };
    const ref = this.firebase.db().ref(`${MIRROR_ROLES}/${key}`);
    const snap = await ref.get();
    if (!snap.exists()) return { success: false, message: 'El rol no existe.' };
    try {
      // Reescribe el rol completo (nombre + permisos).
      await ref.set(this.buildRecord({ ...dto, id }));
      return { success: true, message: 'Rol actualizado.' };
    } catch (err: any) {
      this.logger.error(`[roles] update ${key} falló: ${err?.message}`);
      return { success: false, message: err?.message || 'No se pudo actualizar el rol.' };
    }
  }

  async remove(id: string): Promise<{ success: boolean; message?: string }> {
    if (!this.firebase.isEnabled()) return { success: false, message: 'Servicio no disponible.' };
    const key = this.safeKey(id);
    if (!key) return { success: false, message: 'ID requerido.' };
    try {
      await this.firebase.db().ref(`${MIRROR_ROLES}/${key}`).remove();
      return { success: true, message: 'Rol eliminado.' };
    } catch (err: any) {
      this.logger.error(`[roles] delete ${key} falló: ${err?.message}`);
      return { success: false, message: err?.message || 'No se pudo eliminar el rol.' };
    }
  }
}
