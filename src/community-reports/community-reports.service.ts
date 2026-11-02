import { Injectable, Logger } from '@nestjs/common';
import { FirebaseService } from '../firebase/firebase.service';

/**
 * Foro de reportes comunitarios por conjunto, en Firebase RTDB
 * mirror/foro_reportes.
 *
 * A diferencia de PQRS (privado: solo creador + admins), este es un FORO:
 * cualquier miembro del conjunto ve todos los reportes y puede responder
 * (ej: "camino enmontado"). Mantiene estados y un hilo de respuestas.
 *
 * NOTA: es una colección NUEVA e independiente de `mirror/reportes` (que usan
 * finanzas, gastos/ingresos y vigilancia). No se tocan esos datos.
 *
 * Estados del ciclo de vida:
 *   abierto    -> recién creado, el admin aún no lo ha visto
 *   visto      -> un admin lo abrió/leyó
 *   en_curso   -> el admin está gestionándolo
 *   resuelto   -> atendido (informativo; el foro sigue admitiendo respuestas)
 *
 * Campos:
 *   id, conjunto, autor, autorNombre, titulo, categoria, descripcion, estado,
 *   respuestas {pushId -> {id, autor, autorNombre, esAdmin, texto, fecha}},
 *   creadoEn, actualizadoEn
 */
const MIRROR_FORO = 'mirror/foro_reportes';

/** Estados válidos de un reporte del foro. */
export const FORO_ESTADOS = ['abierto', 'visto', 'en_curso', 'resuelto'] as const;
export type ForoEstado = (typeof FORO_ESTADOS)[number];

@Injectable()
export class CommunityReportsService {
  private readonly logger = new Logger(CommunityReportsService.name);

  constructor(private readonly firebase: FirebaseService) {}

  private safeKey(raw: unknown): string {
    return String(raw ?? '').trim().replace(/[.#$/\[\]]/g, '_');
  }

  private normEstado(raw: unknown): ForoEstado {
    const s = String(raw ?? '').trim().toLowerCase();
    return (FORO_ESTADOS as readonly string[]).includes(s) ? (s as ForoEstado) : 'abierto';
  }

  /** Normaliza el mapa de respuestas (push-id) a un array ordenado por fecha asc. */
  private normalizeRespuestas(raw: any): Array<{
    id: string;
    autor: string;
    autorNombre: string;
    esAdmin: boolean;
    texto: string;
    fecha: string;
  }> {
    if (!raw || typeof raw !== 'object') return [];
    const out = Object.keys(raw).map((k) => {
      const m = raw[k] || {};
      return {
        id: String(m.id ?? k),
        autor: String(m.autor ?? ''),
        autorNombre: String(m.autorNombre ?? ''),
        esAdmin: m.esAdmin === true,
        texto: String(m.texto ?? ''),
        fecha: String(m.fecha ?? ''),
      };
    });
    out.sort((a, b) => a.fecha.localeCompare(b.fecha));
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
      // Categoría libre (ej: "Camino enmontado", "Daño", "Seguridad").
      categoria: String(dto.categoria ?? 'General'),
      descripcion: String(dto.descripcion ?? ''),
      estado: this.normEstado(dto.estado),
      respuestas: dto.respuestas && typeof dto.respuestas === 'object' ? dto.respuestas : {},
      creadoEn: String(dto.creadoEn ?? ahora),
      actualizadoEn: ahora,
      _fbWrite: true,
    };
  }

  /** Lista los reportes del foro. Filtra por conjunto (nombre) si se pasa. */
  async list(conjunto?: string): Promise<any[]> {
    if (!this.firebase.isEnabled()) throw new Error('Servicio no disponible.');
    const snap = await this.firebase.db().ref(MIRROR_FORO).get();
    if (!snap.exists()) return [];
    let items = Object.values(snap.val() || {}) as any[];
    if (conjunto) {
      const norm = (s: unknown) => String(s ?? '').trim().toLowerCase();
      items = items.filter((p) => norm(p.conjunto) === norm(conjunto));
    }
    return items.map((p) => {
      const { _fbWrite, ...rest } = p;
      return {
        ...rest,
        estado: this.normEstado(rest.estado),
        categoria: String(rest.categoria ?? 'General'),
        respuestas: this.normalizeRespuestas(rest.respuestas),
      };
    });
  }

  async create(dto: any): Promise<{ success: boolean; message?: string; id?: string }> {
    if (!this.firebase.isEnabled()) return { success: false, message: 'Servicio no disponible.' };
    if (!String(dto?.titulo ?? '').trim()) return { success: false, message: 'El título es requerido.' };
    if (!String(dto?.autor ?? '').trim()) return { success: false, message: 'El autor es requerido.' };

    const id = String(dto.id || Date.now().toString());
    const record = this.buildRecord({ ...dto, id, estado: 'abierto', respuestas: {} });
    try {
      await this.firebase.db().ref(`${MIRROR_FORO}/${this.safeKey(id)}`).set(record);
      return { success: true, id, message: 'Reporte creado.' };
    } catch (err: any) {
      this.logger.error(`[foro] create falló: ${err?.message}`);
      return { success: false, message: err?.message || 'No se pudo crear el reporte.' };
    }
  }

  /**
   * Edita los campos base (título/categoría/descripción). Hace SET completo, así
   * que preserva el hilo de respuestas, el estado y la fecha de creación.
   */
  async update(id: string, dto: any): Promise<{ success: boolean; message?: string }> {
    if (!this.firebase.isEnabled()) return { success: false, message: 'Servicio no disponible.' };
    const key = this.safeKey(id);
    if (!key) return { success: false, message: 'ID requerido.' };
    const ref = this.firebase.db().ref(`${MIRROR_FORO}/${key}`);
    const snap = await ref.get();
    if (!snap.exists()) return { success: false, message: 'El reporte no existe.' };
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
        // Estado y respuestas tienen endpoints propios: no se tocan desde aquí.
        estado: prev.estado,
        respuestas: prev.respuestas || {},
      };
      await ref.set(this.buildRecord(merged));
      return { success: true, message: 'Reporte actualizado.' };
    } catch (err: any) {
      this.logger.error(`[foro] update ${key} falló: ${err?.message}`);
      return { success: false, message: err?.message || 'No se pudo actualizar el reporte.' };
    }
  }

  /**
   * Agrega una respuesta al hilo (merge por push-id). El foro SIEMPRE admite
   * respuestas, incluso si el reporte está 'resuelto'. Si un admin responde un
   * reporte 'abierto' o 'visto', pasa a 'en_curso'.
   */
  async addRespuesta(
    id: string,
    dto: { autor: string; autorNombre?: string; esAdmin?: boolean; texto: string },
  ): Promise<{ success: boolean; message?: string }> {
    if (!this.firebase.isEnabled()) return { success: false, message: 'Servicio no disponible.' };
    const key = this.safeKey(id);
    if (!key) return { success: false, message: 'ID requerido.' };
    const autor = String(dto?.autor ?? '').trim();
    const texto = String(dto?.texto ?? '').trim();
    if (!autor) return { success: false, message: 'Autor requerido.' };
    if (!texto) return { success: false, message: 'La respuesta no puede estar vacía.' };

    const ref = this.firebase.db().ref(`${MIRROR_FORO}/${key}`);
    const snap = await ref.get();
    if (!snap.exists()) return { success: false, message: 'El reporte no existe.' };
    const reporte = snap.val() || {};

    const esAdmin = dto?.esAdmin === true;
    const ahora = new Date().toISOString();
    try {
      const nodo = ref.child('respuestas').push();
      await nodo.set({
        id: nodo.key,
        autor,
        autorNombre: String(dto.autorNombre ?? ''),
        esAdmin,
        texto,
        fecha: ahora,
      });
      const estadoActual = this.normEstado(reporte.estado);
      if (esAdmin && (estadoActual === 'abierto' || estadoActual === 'visto')) {
        await ref.child('estado').set('en_curso');
      }
      await ref.child('actualizadoEn').set(ahora);
      return { success: true, message: 'Respuesta enviada.' };
    } catch (err: any) {
      this.logger.error(`[foro] addRespuesta ${key} falló: ${err?.message}`);
      return { success: false, message: err?.message || 'No se pudo enviar la respuesta.' };
    }
  }

  /** Cambia el estado del reporte (visto/en_curso/resuelto/abierto). */
  async setEstado(id: string, estado: string): Promise<{ success: boolean; message?: string }> {
    if (!this.firebase.isEnabled()) return { success: false, message: 'Servicio no disponible.' };
    const key = this.safeKey(id);
    if (!key) return { success: false, message: 'ID requerido.' };
    const nuevo = this.normEstado(estado);
    const ref = this.firebase.db().ref(`${MIRROR_FORO}/${key}`);
    const snap = await ref.get();
    if (!snap.exists()) return { success: false, message: 'El reporte no existe.' };
    try {
      await ref.child('estado').set(nuevo);
      await ref.child('actualizadoEn').set(new Date().toISOString());
      return { success: true, message: 'Estado actualizado.' };
    } catch (err: any) {
      this.logger.error(`[foro] setEstado ${key} falló: ${err?.message}`);
      return { success: false, message: err?.message || 'No se pudo actualizar el estado.' };
    }
  }

  /** Marca el reporte como 'visto' SOLO si está 'abierto' (no retrocede). */
  async marcarVisto(id: string): Promise<{ success: boolean; message?: string }> {
    if (!this.firebase.isEnabled()) return { success: false, message: 'Servicio no disponible.' };
    const key = this.safeKey(id);
    if (!key) return { success: false, message: 'ID requerido.' };
    const ref = this.firebase.db().ref(`${MIRROR_FORO}/${key}`);
    const snap = await ref.get();
    if (!snap.exists()) return { success: false, message: 'El reporte no existe.' };
    const estado = this.normEstado((snap.val() || {}).estado);
    if (estado !== 'abierto') return { success: true, message: 'Sin cambios.' };
    try {
      await ref.child('estado').set('visto');
      await ref.child('actualizadoEn').set(new Date().toISOString());
      return { success: true, message: 'Reporte marcado como visto.' };
    } catch (err: any) {
      this.logger.error(`[foro] marcarVisto ${key} falló: ${err?.message}`);
      return { success: false, message: err?.message || 'No se pudo marcar como visto.' };
    }
  }

  async remove(id: string): Promise<{ success: boolean; message?: string }> {
    if (!this.firebase.isEnabled()) return { success: false, message: 'Servicio no disponible.' };
    const key = this.safeKey(id);
    if (!key) return { success: false, message: 'ID requerido.' };
    try {
      await this.firebase.db().ref(`${MIRROR_FORO}/${key}`).remove();
      return { success: true, message: 'Reporte eliminado.' };
    } catch (err: any) {
      this.logger.error(`[foro] delete ${key} falló: ${err?.message}`);
      return { success: false, message: err?.message || 'No se pudo eliminar el reporte.' };
    }
  }
}
