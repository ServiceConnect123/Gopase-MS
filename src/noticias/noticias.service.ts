import { Injectable, Logger } from '@nestjs/common';
import { FirebaseService } from '../firebase/firebase.service';

/**
 * Noticias del conjunto, en Firebase RTDB mirror/noticias.
 *
 * El administrador crea noticias (título, subtítulo, descripción, atributos/
 * etiquetas e imágenes) y puede decidir enviarlas por WhatsApp a los
 * propietarios. El propietario solo las visualiza.
 *
 * Campos:
 *   id, conjunto, autor, autorNombre, titulo, subtitulo, descripcion,
 *   atributos (string[] etiquetas), imagenes (string[] URLs de Drive),
 *   enviadaWsp (bool), fechaEnvioWsp, creadoEn, actualizadoEn
 */
const MIRROR_NOTICIAS = 'mirror/noticias';

@Injectable()
export class NoticiasService {
  private readonly logger = new Logger(NoticiasService.name);

  constructor(private readonly firebase: FirebaseService) {}

  private safeKey(raw: unknown): string {
    return String(raw ?? '').trim().replace(/[.#$/\[\]]/g, '_');
  }

  /** Normaliza una lista de strings (atributos/imágenes), sin vacíos ni duplicados. */
  private normList(raw: any): string[] {
    if (!Array.isArray(raw)) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const v of raw) {
      const s = String(v ?? '').trim();
      if (s && !seen.has(s)) {
        seen.add(s);
        out.push(s);
      }
    }
    return out;
  }

  private buildRecord(dto: any): Record<string, any> {
    const ahora = new Date().toISOString();
    return {
      id: String(dto.id),
      conjunto: String(dto.conjunto ?? ''),
      autor: String(dto.autor ?? ''),
      autorNombre: String(dto.autorNombre ?? ''),
      titulo: String(dto.titulo ?? ''),
      subtitulo: String(dto.subtitulo ?? ''),
      descripcion: String(dto.descripcion ?? ''),
      atributos: this.normList(dto.atributos),
      imagenes: this.normList(dto.imagenes),
      enviadaWsp: dto.enviadaWsp === true,
      fechaEnvioWsp: String(dto.fechaEnvioWsp ?? ''),
      creadoEn: String(dto.creadoEn ?? ahora),
      actualizadoEn: ahora,
      _fbWrite: true,
    };
  }

  /** Lista las noticias. Filtra por conjunto (nombre) si se pasa. */
  async list(conjunto?: string): Promise<any[]> {
    if (!this.firebase.isEnabled()) throw new Error('Servicio no disponible.');
    const snap = await this.firebase.db().ref(MIRROR_NOTICIAS).get();
    if (!snap.exists()) return [];
    let items = Object.values(snap.val() || {}) as any[];
    if (conjunto) {
      const norm = (s: unknown) => String(s ?? '').trim().toLowerCase();
      items = items.filter((n) => norm(n.conjunto) === norm(conjunto));
    }
    return items.map((n) => {
      const { _fbWrite, ...rest } = n;
      return {
        ...rest,
        atributos: this.normList(rest.atributos),
        imagenes: this.normList(rest.imagenes),
        enviadaWsp: rest.enviadaWsp === true,
      };
    });
  }

  async create(dto: any): Promise<{ success: boolean; message?: string; id?: string }> {
    if (!this.firebase.isEnabled()) return { success: false, message: 'Servicio no disponible.' };
    if (!String(dto?.titulo ?? '').trim()) return { success: false, message: 'El título es requerido.' };

    const id = String(dto.id || Date.now().toString());
    const record = this.buildRecord({ ...dto, id, enviadaWsp: false, fechaEnvioWsp: '' });
    try {
      await this.firebase.db().ref(`${MIRROR_NOTICIAS}/${this.safeKey(id)}`).set(record);
      return { success: true, id, message: 'Noticia creada.' };
    } catch (err: any) {
      this.logger.error(`[noticias] create falló: ${err?.message}`);
      return { success: false, message: err?.message || 'No se pudo crear la noticia.' };
    }
  }

  /** Edita la noticia (SET completo). Preserva el estado de envío por WhatsApp. */
  async update(id: string, dto: any): Promise<{ success: boolean; message?: string }> {
    if (!this.firebase.isEnabled()) return { success: false, message: 'Servicio no disponible.' };
    const key = this.safeKey(id);
    if (!key) return { success: false, message: 'ID requerido.' };
    const ref = this.firebase.db().ref(`${MIRROR_NOTICIAS}/${key}`);
    const snap = await ref.get();
    if (!snap.exists()) return { success: false, message: 'La noticia no existe.' };
    try {
      const prev = snap.val() || {};
      const merged = {
        ...prev,
        ...dto,
        id,
        conjunto: prev.conjunto,
        autor: prev.autor,
        autorNombre: prev.autorNombre,
        creadoEn: prev.creadoEn,
        // El estado de envío por WhatsApp lo maneja marcarEnviadaWsp, no update.
        enviadaWsp: prev.enviadaWsp === true,
        fechaEnvioWsp: prev.fechaEnvioWsp ?? '',
      };
      await ref.set(this.buildRecord(merged));
      return { success: true, message: 'Noticia actualizada.' };
    } catch (err: any) {
      this.logger.error(`[noticias] update ${key} falló: ${err?.message}`);
      return { success: false, message: err?.message || 'No se pudo actualizar la noticia.' };
    }
  }

  /** Marca la noticia como enviada por WhatsApp (registra la fecha de envío). */
  async marcarEnviadaWsp(id: string): Promise<{ success: boolean; message?: string }> {
    if (!this.firebase.isEnabled()) return { success: false, message: 'Servicio no disponible.' };
    const key = this.safeKey(id);
    if (!key) return { success: false, message: 'ID requerido.' };
    const ref = this.firebase.db().ref(`${MIRROR_NOTICIAS}/${key}`);
    const snap = await ref.get();
    if (!snap.exists()) return { success: false, message: 'La noticia no existe.' };
    try {
      const ahora = new Date().toISOString();
      await ref.child('enviadaWsp').set(true);
      await ref.child('fechaEnvioWsp').set(ahora);
      await ref.child('actualizadoEn').set(ahora);
      return { success: true, message: 'Noticia marcada como enviada por WhatsApp.' };
    } catch (err: any) {
      this.logger.error(`[noticias] marcarEnviadaWsp ${key} falló: ${err?.message}`);
      return { success: false, message: err?.message || 'No se pudo actualizar la noticia.' };
    }
  }

  async remove(id: string): Promise<{ success: boolean; message?: string }> {
    if (!this.firebase.isEnabled()) return { success: false, message: 'Servicio no disponible.' };
    const key = this.safeKey(id);
    if (!key) return { success: false, message: 'ID requerido.' };
    try {
      await this.firebase.db().ref(`${MIRROR_NOTICIAS}/${key}`).remove();
      return { success: true, message: 'Noticia eliminada.' };
    } catch (err: any) {
      this.logger.error(`[noticias] delete ${key} falló: ${err?.message}`);
      return { success: false, message: err?.message || 'No se pudo eliminar la noticia.' };
    }
  }
}
