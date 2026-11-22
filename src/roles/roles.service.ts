import { Injectable, Logger } from '@nestjs/common';
import { FirebaseService } from '../firebase/firebase.service';
import { VERSION_PERMISOS, esRolSistema, limpiarPermisos, rolEsDelSistema } from './roles-rules';

/**
 * Roles (RTDB mirror/roles). El espejo guarda { id, nombre, permisos } y aquí se
 * expone { id, name, permissions } más:
 *   - sistema: rol del sistema (admin, vigilante, propietario, inquilino, superAdmin).
 *   - conjunto: '' = global; si no, el rol personalizado es de ese conjunto.
 *   - v: 2 cuando el rol se guardó con el editor nuevo (sus permisos mandan en el menú).
 */
const MIRROR_ROLES = 'mirror/roles';

export interface RolDto {
  id: string;
  name: string;
  permissions: any;
  sistema: boolean;
  conjunto: string;
  v: number;
}

const norm = (s: unknown) => String(s ?? '').trim().toLowerCase();

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
  toDto(r: any): RolDto {
    const name = r.name ?? r.nombre ?? '';
    return {
      id: String(r.id ?? ''),
      name,
      permissions: this.normalizePermissions(r.permisos ?? r.permissions),
      sistema: rolEsDelSistema({ id: r.id, name }),
      conjunto: String(r.conjunto ?? ''),
      v: Number(r.v) || 1,
    };
  }

  private buildRecord(dto: any): Record<string, any> {
    return {
      id: String(dto.id),
      nombre: String(dto.name ?? dto.nombre ?? '').trim().slice(0, 40),
      permisos: limpiarPermisos(this.normalizePermissions(dto.permissions ?? dto.permisos)),
      conjunto: String(dto.conjunto ?? ''),
      v: VERSION_PERMISOS,
      _fbWrite: true,
    };
  }

  async list(): Promise<RolDto[]> {
    if (!this.firebase.isEnabled()) throw new Error('Servicio no disponible.');
    const snap = await this.firebase.db().ref(MIRROR_ROLES).get();
    if (!snap.exists()) return [];
    return (Object.values(snap.val() || {}) as any[]).map((r) => this.toDto(r));
  }

  async getById(id: string): Promise<RolDto | null> {
    const key = this.safeKey(id);
    if (!key) return null;
    const snap = await this.firebase.db().ref(`${MIRROR_ROLES}/${key}`).get();
    return snap.exists() ? this.toDto(snap.val()) : null;
  }

  /** Ya existe un rol con ese nombre visible para el conjunto (sistema, global o del mismo conjunto). */
  async nombreOcupado(nombre: string, conjunto: string, exceptoId = ''): Promise<boolean> {
    const n = norm(nombre);
    if (esRolSistema(n)) return true;
    const todos = await this.list();
    return todos.some((r) => r.id !== exceptoId && norm(r.name) === n && (!r.conjunto || !conjunto || norm(r.conjunto) === norm(conjunto)));
  }

  /**
   * Crea un rol. `permitirSistema` (solo superAdmin): crea el registro de un rol del
   * sistema que aún no existe en la base (p. ej. inquilino), con su nombre como id.
   */
  async create(dto: any, opts: { permitirSistema?: boolean } = {}): Promise<{ success: boolean; message?: string; id?: string }> {
    if (!this.firebase.isEnabled()) return { success: false, message: 'Servicio no disponible.' };
    const nombre = String(dto?.name ?? '').trim();
    if (!nombre) return { success: false, message: 'El nombre del rol es requerido.' };
    let id = String(dto.id || Date.now().toString());
    if (esRolSistema(nombre)) {
      if (!opts.permitirSistema) return { success: false, message: `«${nombre}» es un rol del sistema.` };
      if ((await this.list()).some((r) => r.sistema && norm(r.name) === norm(nombre))) {
        return { success: false, message: `El rol «${nombre}» ya existe.` };
      }
      id = nombre;
      dto = { ...dto, conjunto: '' };
    } else if (await this.nombreOcupado(nombre, String(dto?.conjunto ?? ''))) {
      return { success: false, message: `Ya existe un rol llamado «${nombre}».` };
    }
    try {
      await this.firebase.db().ref(`${MIRROR_ROLES}/${this.safeKey(id)}`).set(this.buildRecord({ ...dto, id }));
      return { success: true, id, message: 'Rol creado.' };
    } catch (err: any) {
      this.logger.error(`[roles] create falló: ${err?.message}`);
      return { success: false, message: err?.message || 'No se pudo crear el rol.' };
    }
  }

  /** Reescribe nombre y permisos. Un rol del sistema conserva su nombre; el conjunto no cambia. */
  async update(id: string, dto: any): Promise<{ success: boolean; message?: string }> {
    if (!this.firebase.isEnabled()) return { success: false, message: 'Servicio no disponible.' };
    const prev = await this.getById(id);
    if (!prev) return { success: false, message: 'El rol no existe.' };
    const nombre = prev.sistema ? prev.name : String(dto?.name ?? prev.name).trim();
    if (!nombre) return { success: false, message: 'El nombre del rol es requerido.' };
    if (!prev.sistema && (await this.nombreOcupado(nombre, prev.conjunto, prev.id))) {
      return { success: false, message: `Ya existe un rol llamado «${nombre}».` };
    }
    try {
      await this.firebase.db().ref(`${MIRROR_ROLES}/${this.safeKey(id)}`).set(
        this.buildRecord({ id: prev.id, name: nombre, permissions: dto?.permissions, conjunto: prev.conjunto }),
      );
      return { success: true, message: 'Rol actualizado.' };
    } catch (err: any) {
      this.logger.error(`[roles] update ${id} falló: ${err?.message}`);
      return { success: false, message: err?.message || 'No se pudo actualizar el rol.' };
    }
  }

  async remove(id: string): Promise<{ success: boolean; message?: string }> {
    if (!this.firebase.isEnabled()) return { success: false, message: 'Servicio no disponible.' };
    const prev = await this.getById(id);
    if (!prev) return { success: false, message: 'El rol no existe.' };
    if (prev.sistema) return { success: false, message: 'Los roles del sistema no se pueden eliminar.' };
    try {
      await this.firebase.db().ref(`${MIRROR_ROLES}/${this.safeKey(id)}`).remove();
      return { success: true, message: 'Rol eliminado.' };
    } catch (err: any) {
      this.logger.error(`[roles] delete ${id} falló: ${err?.message}`);
      return { success: false, message: err?.message || 'No se pudo eliminar el rol.' };
    }
  }
}
