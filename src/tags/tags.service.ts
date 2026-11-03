import { Injectable, Logger } from '@nestjs/common';
import { FirebaseService } from '../firebase/firebase.service';

/**
 * Etiquetas (tags) de usuarios por conjunto, en Firebase RTDB mirror/etiquetas.
 *
 * El administrador crea etiquetas (p. ej. "Consejo", "Comité") con un color y
 * las asigna a los usuarios (el id de cada etiqueta se guarda en el array
 * `etiquetas` del usuario, en mirror/usuarios). Un usuario puede tener varias.
 *
 * Campos: id, conjunto, nombre, color (hex).
 */
const MIRROR_TAGS = 'mirror/etiquetas';

@Injectable()
export class TagsService {
  private readonly logger = new Logger(TagsService.name);

  constructor(private readonly firebase: FirebaseService) {}

  private safeKey(raw: unknown): string {
    return String(raw ?? '').trim().replace(/[.#$/\[\]]/g, '_');
  }

  private norm(s: unknown): string {
    return String(s ?? '').trim().toLowerCase();
  }

  private buildRecord(dto: any): Record<string, any> {
    return {
      id: String(dto.id),
      conjunto: String(dto.conjunto ?? ''),
      nombre: String(dto.nombre ?? '').trim(),
      // color en hex (#RRGGBB). Default azul de la marca.
      color: String(dto.color ?? '#3882F6').trim() || '#3882F6',
      _fbWrite: true,
    };
  }

  /** Lista las etiquetas de un conjunto (o todas si no se pasa). */
  async list(conjunto?: string): Promise<any[]> {
    if (!this.firebase.isEnabled()) throw new Error('Servicio no disponible.');
    const snap = await this.firebase.db().ref(MIRROR_TAGS).get();
    let tags = snap.exists() ? (Object.values(snap.val() || {}) as any[]) : [];
    if (conjunto) tags = tags.filter((t) => this.norm(t.conjunto) === this.norm(conjunto));
    return tags
      .map((t) => {
        const { _fbWrite, ...rest } = t;
        return { ...rest, color: String(rest.color ?? '#3882F6') };
      })
      .sort((a, b) => String(a.nombre).localeCompare(String(b.nombre)));
  }

  async create(dto: any): Promise<{ success: boolean; message?: string; id?: string }> {
    if (!this.firebase.isEnabled()) return { success: false, message: 'Servicio no disponible.' };
    if (!String(dto?.nombre ?? '').trim()) return { success: false, message: 'El nombre es requerido.' };
    if (!String(dto?.conjunto ?? '').trim()) return { success: false, message: 'El conjunto es requerido.' };

    // Evita duplicados por nombre dentro del mismo conjunto.
    const existentes = await this.list(dto.conjunto);
    if (existentes.some((t) => this.norm(t.nombre) === this.norm(dto.nombre))) {
      return { success: false, message: 'Ya existe una etiqueta con ese nombre.' };
    }

    const id = String(dto.id || `tag_${Date.now()}`);
    const record = this.buildRecord({ ...dto, id });
    try {
      await this.firebase.db().ref(`${MIRROR_TAGS}/${this.safeKey(id)}`).set(record);
      return { success: true, id, message: 'Etiqueta creada.' };
    } catch (err: any) {
      this.logger.error(`[tags] create falló: ${err?.message}`);
      return { success: false, message: err?.message || 'No se pudo crear la etiqueta.' };
    }
  }

  async update(id: string, dto: any): Promise<{ success: boolean; message?: string }> {
    if (!this.firebase.isEnabled()) return { success: false, message: 'Servicio no disponible.' };
    const key = this.safeKey(id);
    if (!key) return { success: false, message: 'ID requerido.' };
    const ref = this.firebase.db().ref(`${MIRROR_TAGS}/${key}`);
    const snap = await ref.get();
    if (!snap.exists()) return { success: false, message: 'La etiqueta no existe.' };
    try {
      const patch: Record<string, any> = { _fbWrite: true };
      if (dto.nombre !== undefined) patch.nombre = String(dto.nombre).trim();
      if (dto.color !== undefined) patch.color = String(dto.color).trim() || '#3882F6';
      await ref.update(patch);
      return { success: true, message: 'Etiqueta actualizada.' };
    } catch (err: any) {
      this.logger.error(`[tags] update ${key} falló: ${err?.message}`);
      return { success: false, message: err?.message || 'No se pudo actualizar.' };
    }
  }

  /**
   * Elimina una etiqueta del catálogo y la quita de todos los usuarios que la
   * tenían asignada (limpia el array `etiquetas`).
   */
  async remove(id: string): Promise<{ success: boolean; message?: string }> {
    if (!this.firebase.isEnabled()) return { success: false, message: 'Servicio no disponible.' };
    const key = this.safeKey(id);
    if (!key) return { success: false, message: 'ID requerido.' };
    try {
      await this.firebase.db().ref(`${MIRROR_TAGS}/${key}`).remove();
      // Limpieza: quitar esta etiqueta de los usuarios que la tuvieran.
      await this.removeTagFromAllUsers(id);
      return { success: true, message: 'Etiqueta eliminada.' };
    } catch (err: any) {
      this.logger.error(`[tags] delete ${key} falló: ${err?.message}`);
      return { success: false, message: err?.message || 'No se pudo eliminar.' };
    }
  }

  /** Quita el id de etiqueta del array `etiquetas` de todos los usuarios. */
  private async removeTagFromAllUsers(tagId: string): Promise<void> {
    try {
      const ref = this.firebase.db().ref('mirror/usuarios');
      const snap = await ref.get();
      if (!snap.exists()) return;
      const all = snap.val() || {};
      for (const key of Object.keys(all)) {
        const u = all[key] || {};
        const etiquetas: string[] = Array.isArray(u.etiquetas) ? u.etiquetas : [];
        if (etiquetas.includes(tagId)) {
          const nuevas = etiquetas.filter((e) => e !== tagId);
          await ref.child(key).update({ etiquetas: nuevas, _fbWrite: true });
        }
      }
    } catch (e: any) {
      this.logger.warn(`[tags] removeTagFromAllUsers(${tagId}): ${e?.message}`);
    }
  }
}
