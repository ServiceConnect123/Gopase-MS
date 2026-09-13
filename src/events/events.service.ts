import { Injectable, Logger } from '@nestjs/common';
import { FirebaseService } from '../firebase/firebase.service';

/**
 * CRUD de eventos contra Firebase (RTDB mirror/eventos).
 * Reemplaza getData('eventos')/createData('eventos')/delete del frontend (Sheets).
 *
 * Campos (alineados con mapEvento del SyncService):
 *   id, titulo, descripcion, fecha, hora, lugar, conjunto (NOMBRE), creador
 */
const MIRROR_EVENTOS = 'mirror/eventos';

@Injectable()
export class EventsService {
  private readonly logger = new Logger(EventsService.name);

  constructor(private readonly firebase: FirebaseService) {}

  private safeKey(raw: unknown): string {
    return String(raw ?? '').trim().replace(/[.#$/\[\]]/g, '_');
  }

  private buildRecord(dto: any): Record<string, any> {
    return {
      id: String(dto.id),
      titulo: dto.titulo ?? '',
      descripcion: dto.descripcion ?? '',
      fecha: dto.fecha ?? '',
      hora: dto.hora ?? '',
      lugar: dto.lugar ?? '',
      conjunto: String(dto.conjunto ?? ''),
      creador: String(dto.creador ?? ''),
      _fbWrite: true,
    };
  }

  /** Lista de eventos. Filtra por conjunto (nombre) si se pasa. */
  async list(conjunto?: string): Promise<any[]> {
    if (!this.firebase.isEnabled()) throw new Error('Servicio no disponible.');
    const snap = await this.firebase.db().ref(MIRROR_EVENTOS).get();
    if (!snap.exists()) return [];
    let eventos = Object.values(snap.val() || {}) as any[];
    if (conjunto) {
      const norm = (s: unknown) => String(s ?? '').trim().toLowerCase();
      eventos = eventos.filter((e) => norm(e.conjunto) === norm(conjunto));
    }
    // Campos nombrados + alias posicionales dato_n (compat con parsing por posición).
    return eventos.map((e) => {
      const { _fbWrite, ...rest } = e;
      return {
        ...rest,
        dato_1: rest.id ?? '',
        dato_2: rest.titulo ?? '',
        dato_3: rest.descripcion ?? '',
        dato_4: rest.fecha ?? '',
        dato_5: rest.hora ?? '',
        dato_6: rest.lugar ?? '',
        dato_7: rest.conjunto ?? '',
        dato_8: rest.creador ?? '',
      };
    });
  }

  async create(dto: any): Promise<{ success: boolean; message?: string; id?: string }> {
    if (!this.firebase.isEnabled()) return { success: false, message: 'Servicio no disponible.' };
    const id = String(dto.id || Date.now().toString());
    try {
      await this.firebase.db().ref(`${MIRROR_EVENTOS}/${this.safeKey(id)}`).set(this.buildRecord({ ...dto, id }));
      return { success: true, id, message: 'Evento creado.' };
    } catch (err: any) {
      this.logger.error(`[events] create falló: ${err?.message}`);
      return { success: false, message: err?.message || 'No se pudo crear el evento.' };
    }
  }

  async update(id: string, dto: any): Promise<{ success: boolean; message?: string }> {
    if (!this.firebase.isEnabled()) return { success: false, message: 'Servicio no disponible.' };
    const key = this.safeKey(id);
    if (!key) return { success: false, message: 'ID requerido.' };
    const ref = this.firebase.db().ref(`${MIRROR_EVENTOS}/${key}`);
    const snap = await ref.get();
    if (!snap.exists()) return { success: false, message: 'El evento no existe.' };
    try {
      await ref.set(this.buildRecord({ ...dto, id }));
      return { success: true, message: 'Evento actualizado.' };
    } catch (err: any) {
      this.logger.error(`[events] update ${key} falló: ${err?.message}`);
      return { success: false, message: err?.message || 'No se pudo actualizar el evento.' };
    }
  }

  async remove(id: string): Promise<{ success: boolean; message?: string }> {
    if (!this.firebase.isEnabled()) return { success: false, message: 'Servicio no disponible.' };
    const key = this.safeKey(id);
    if (!key) return { success: false, message: 'ID requerido.' };
    try {
      await this.firebase.db().ref(`${MIRROR_EVENTOS}/${key}`).remove();
      return { success: true, message: 'Evento eliminado.' };
    } catch (err: any) {
      this.logger.error(`[events] delete ${key} falló: ${err?.message}`);
      return { success: false, message: err?.message || 'No se pudo eliminar el evento.' };
    }
  }
}
