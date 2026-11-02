import { Injectable, Logger } from '@nestjs/common';
import { FirebaseService } from '../firebase/firebase.service';

/**
 * PQRS (Peticiones, Quejas, Reclamos y Sugerencias) por conjunto, en Firebase
 * RTDB mirror/pqrs.
 *
 * Visibilidad (se aplica en el cliente, pero el backend expone todo lo del
 * conjunto): el creador ve solo las suyas; admin/superAdmin ven todas las del
 * conjunto. Cada PQRS tiene un hilo de mensajes (`mensajes`) para la
 * comunicación entre el creador y los administradores.
 *
 * Estados del ciclo de vida:
 *   abierta      -> recién creada, el admin aún no la ha visto
 *   visto        -> un admin la abrió/leyó
 *   en_curso     -> el admin está gestionándola
 *   finalizada   -> cerrada
 *
 * Campos:
 *   id, conjunto, creador, creadorNombre, asunto, categoria, descripcion,
 *   estado, mensajes {pushId -> {autor, autorNombre, esAdmin, texto, fecha}},
 *   creadoEn, actualizadoEn
 */
const MIRROR_PQRS = 'mirror/pqrs';

/** Estados válidos de una PQRS. */
export const PQRS_ESTADOS = ['abierta', 'visto', 'en_curso', 'finalizada'] as const;
export type PqrsEstado = (typeof PQRS_ESTADOS)[number];

/** Categorías válidas (tipo de PQRS). */
const PQRS_CATEGORIAS = ['peticion', 'queja', 'reclamo', 'sugerencia'] as const;

@Injectable()
export class PqrsService {
  private readonly logger = new Logger(PqrsService.name);

  constructor(private readonly firebase: FirebaseService) {}

  private safeKey(raw: unknown): string {
    return String(raw ?? '').trim().replace(/[.#$/\[\]]/g, '_');
  }

  private normEstado(raw: unknown): PqrsEstado {
    const s = String(raw ?? '').trim().toLowerCase();
    return (PQRS_ESTADOS as readonly string[]).includes(s) ? (s as PqrsEstado) : 'abierta';
  }

  private normCategoria(raw: unknown): string {
    const s = String(raw ?? '').trim().toLowerCase();
    return (PQRS_CATEGORIAS as readonly string[]).includes(s) ? s : 'peticion';
  }

  /**
   * Normaliza el mapa de mensajes del hilo. RTDB los guarda por push-id; se
   * devuelven como array ordenado por fecha ascendente.
   */
  private normalizeMensajes(raw: any): Array<{
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
      creador: String(dto.creador ?? ''),
      creadorNombre: String(dto.creadorNombre ?? ''),
      asunto: String(dto.asunto ?? ''),
      categoria: this.normCategoria(dto.categoria),
      descripcion: String(dto.descripcion ?? ''),
      estado: this.normEstado(dto.estado),
      // El hilo de mensajes se preserva tal cual (mapa por push-id). En
      // create() arranca vacío; addMensaje() hace push sin reescribir el nodo.
      mensajes: dto.mensajes && typeof dto.mensajes === 'object' ? dto.mensajes : {},
      creadoEn: String(dto.creadoEn ?? ahora),
      actualizadoEn: ahora,
      _fbWrite: true,
    };
  }

  /** Lista de PQRS. Filtra por conjunto (nombre) si se pasa. */
  async list(conjunto?: string): Promise<any[]> {
    if (!this.firebase.isEnabled()) throw new Error('Servicio no disponible.');
    const snap = await this.firebase.db().ref(MIRROR_PQRS).get();
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
        categoria: this.normCategoria(rest.categoria),
        mensajes: this.normalizeMensajes(rest.mensajes),
      };
    });
  }

  async create(dto: any): Promise<{ success: boolean; message?: string; id?: string }> {
    if (!this.firebase.isEnabled()) return { success: false, message: 'Servicio no disponible.' };
    if (!String(dto?.asunto ?? '').trim()) return { success: false, message: 'El asunto es requerido.' };
    if (!String(dto?.creador ?? '').trim()) return { success: false, message: 'El creador es requerido.' };

    const id = String(dto.id || Date.now().toString());
    // Una PQRS nueva arranca en 'abierta' y sin mensajes.
    const record = this.buildRecord({ ...dto, id, estado: 'abierta', mensajes: {} });
    try {
      await this.firebase.db().ref(`${MIRROR_PQRS}/${this.safeKey(id)}`).set(record);
      return { success: true, id, message: 'PQRS creada.' };
    } catch (err: any) {
      this.logger.error(`[pqrs] create falló: ${err?.message}`);
      return { success: false, message: err?.message || 'No se pudo crear la PQRS.' };
    }
  }

  /**
   * Edita los campos base de la PQRS (asunto/categoría/descripción). Hace SET
   * completo, así que preserva el hilo de mensajes y la fecha de creación.
   */
  async update(id: string, dto: any): Promise<{ success: boolean; message?: string }> {
    if (!this.firebase.isEnabled()) return { success: false, message: 'Servicio no disponible.' };
    const key = this.safeKey(id);
    if (!key) return { success: false, message: 'ID requerido.' };
    const ref = this.firebase.db().ref(`${MIRROR_PQRS}/${key}`);
    const snap = await ref.get();
    if (!snap.exists()) return { success: false, message: 'La PQRS no existe.' };
    try {
      const prev = snap.val() || {};
      const merged = {
        ...prev,
        ...dto,
        id,
        conjunto: prev.conjunto,
        creador: prev.creador,
        creadorNombre: prev.creadorNombre,
        creadoEn: prev.creadoEn,
        // El estado y los mensajes NO se tocan desde aquí: tienen endpoints propios.
        estado: prev.estado,
        mensajes: prev.mensajes || {},
      };
      await ref.set(this.buildRecord(merged));
      return { success: true, message: 'PQRS actualizada.' };
    } catch (err: any) {
      this.logger.error(`[pqrs] update ${key} falló: ${err?.message}`);
      return { success: false, message: err?.message || 'No se pudo actualizar la PQRS.' };
    }
  }

  /**
   * Agrega un mensaje al hilo (merge por push-id: no reescribe el nodo).
   * Si quien escribe es un admin y la PQRS está 'abierta', pasa a 'en_curso'
   * (ya hay respuesta en gestión). La respuesta no reabre una PQRS finalizada.
   */
  async addMensaje(
    id: string,
    dto: { autor: string; autorNombre?: string; esAdmin?: boolean; texto: string },
  ): Promise<{ success: boolean; message?: string }> {
    if (!this.firebase.isEnabled()) return { success: false, message: 'Servicio no disponible.' };
    const key = this.safeKey(id);
    if (!key) return { success: false, message: 'ID requerido.' };
    const autor = String(dto?.autor ?? '').trim();
    const texto = String(dto?.texto ?? '').trim();
    if (!autor) return { success: false, message: 'Autor requerido.' };
    if (!texto) return { success: false, message: 'El mensaje no puede estar vacío.' };

    const ref = this.firebase.db().ref(`${MIRROR_PQRS}/${key}`);
    const snap = await ref.get();
    if (!snap.exists()) return { success: false, message: 'La PQRS no existe.' };
    const pqrs = snap.val() || {};
    if (this.normEstado(pqrs.estado) === 'finalizada') {
      return { success: false, message: 'La PQRS está finalizada; no admite más mensajes.' };
    }

    const esAdmin = dto?.esAdmin === true;
    const ahora = new Date().toISOString();
    try {
      const nodo = ref.child('mensajes').push();
      await nodo.set({
        id: nodo.key,
        autor,
        autorNombre: String(dto.autorNombre ?? ''),
        esAdmin,
        texto,
        fecha: ahora,
      });
      // Si un admin responde una PQRS aún 'abierta' o 'visto', pasa a 'en_curso'.
      const estadoActual = this.normEstado(pqrs.estado);
      if (esAdmin && (estadoActual === 'abierta' || estadoActual === 'visto')) {
        await ref.child('estado').set('en_curso');
      }
      await ref.child('actualizadoEn').set(ahora);
      return { success: true, message: 'Mensaje enviado.' };
    } catch (err: any) {
      this.logger.error(`[pqrs] addMensaje ${key} falló: ${err?.message}`);
      return { success: false, message: err?.message || 'No se pudo enviar el mensaje.' };
    }
  }

  /** Cambia el estado de la PQRS (visto / en_curso / finalizada / abierta). */
  async setEstado(id: string, estado: string): Promise<{ success: boolean; message?: string }> {
    if (!this.firebase.isEnabled()) return { success: false, message: 'Servicio no disponible.' };
    const key = this.safeKey(id);
    if (!key) return { success: false, message: 'ID requerido.' };
    const nuevo = this.normEstado(estado);
    const ref = this.firebase.db().ref(`${MIRROR_PQRS}/${key}`);
    const snap = await ref.get();
    if (!snap.exists()) return { success: false, message: 'La PQRS no existe.' };
    try {
      await ref.child('estado').set(nuevo);
      await ref.child('actualizadoEn').set(new Date().toISOString());
      return { success: true, message: 'Estado actualizado.' };
    } catch (err: any) {
      this.logger.error(`[pqrs] setEstado ${key} falló: ${err?.message}`);
      return { success: false, message: err?.message || 'No se pudo actualizar el estado.' };
    }
  }

  /**
   * Marca la PQRS como 'visto' SOLO si está 'abierta' (idempotente: no
   * retrocede desde en_curso/finalizada). Lo llama el admin al abrir el detalle.
   */
  async marcarVisto(id: string): Promise<{ success: boolean; message?: string }> {
    if (!this.firebase.isEnabled()) return { success: false, message: 'Servicio no disponible.' };
    const key = this.safeKey(id);
    if (!key) return { success: false, message: 'ID requerido.' };
    const ref = this.firebase.db().ref(`${MIRROR_PQRS}/${key}`);
    const snap = await ref.get();
    if (!snap.exists()) return { success: false, message: 'La PQRS no existe.' };
    const estado = this.normEstado((snap.val() || {}).estado);
    if (estado !== 'abierta') return { success: true, message: 'Sin cambios.' };
    try {
      await ref.child('estado').set('visto');
      await ref.child('actualizadoEn').set(new Date().toISOString());
      return { success: true, message: 'PQRS marcada como vista.' };
    } catch (err: any) {
      this.logger.error(`[pqrs] marcarVisto ${key} falló: ${err?.message}`);
      return { success: false, message: err?.message || 'No se pudo marcar como vista.' };
    }
  }

  async remove(id: string): Promise<{ success: boolean; message?: string }> {
    if (!this.firebase.isEnabled()) return { success: false, message: 'Servicio no disponible.' };
    const key = this.safeKey(id);
    if (!key) return { success: false, message: 'ID requerido.' };
    try {
      await this.firebase.db().ref(`${MIRROR_PQRS}/${key}`).remove();
      return { success: true, message: 'PQRS eliminada.' };
    } catch (err: any) {
      this.logger.error(`[pqrs] delete ${key} falló: ${err?.message}`);
      return { success: false, message: err?.message || 'No se pudo eliminar la PQRS.' };
    }
  }
}
