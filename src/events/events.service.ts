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

  /** Normaliza la lista de puntos a tratar: [{ id, titulo, descripcion }]. */
  private normalizePuntos(raw: any): Array<{ id: string; titulo: string; descripcion: string }> {
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((p) => p && (p.titulo || p.descripcion))
      .map((p, i) => ({
        id: String(p.id ?? `${Date.now()}_${i}`),
        titulo: String(p.titulo ?? ''),
        descripcion: String(p.descripcion ?? ''),
      }));
  }

  /**
   * Normaliza el mapa de asistencias indexado por usuario:
   *   { [usuario]: { usuario, nombre, estado: 'asistio'|'no_asistio', fecha } }
   */
  private normalizeAsistencias(raw: any): Record<string, any> {
    if (!raw || typeof raw !== 'object') return {};
    const out: Record<string, any> = {};
    for (const key of Object.keys(raw)) {
      const a = raw[key] || {};
      const estado = a.estado === 'no_asistio' ? 'no_asistio' : 'asistio';
      out[this.safeKey(key)] = {
        usuario: String(a.usuario ?? key),
        nombre: String(a.nombre ?? ''),
        estado,
        fecha: String(a.fecha ?? ''),
      };
    }
    return out;
  }

  /**
   * Calcula el instante de INICIO del evento a partir de fecha (YYYY-MM-DD) y
   * hora (HH:mm o HH:mm AM/PM; opcional). Sin hora, usa el inicio del día.
   * Devuelve null si la fecha es inválida. Debe coincidir con parseEventStart
   * del frontend (events.tsx).
   */
  private eventStart(fecha: string, hora?: string): Date | null {
    const parts = String(fecha || '').split('-');
    if (parts.length !== 3) return null;
    const y = parseInt(parts[0], 10);
    const m = parseInt(parts[1], 10) - 1;
    const d = parseInt(parts[2], 10);
    if (Number.isNaN(y) || Number.isNaN(m) || Number.isNaN(d)) return null;

    let hh = 0;
    let mm = 0;
    const raw = String(hora || '').trim();
    if (raw) {
      const match = raw.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm|AM|PM)?/);
      if (match) {
        hh = parseInt(match[1], 10) || 0;
        mm = match[2] ? parseInt(match[2], 10) : 0;
        const ampm = (match[3] || '').toLowerCase();
        if (ampm === 'pm' && hh < 12) hh += 12;
        if (ampm === 'am' && hh === 12) hh = 0;
      }
    }
    return new Date(y, m, d, hh, mm, 0, 0);
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
      // Puntos a tratar (lista) y asistencias (mapa por usuario). Se conservan
      // tal cual; en update() se preservan si el dto no los trae.
      puntos: this.normalizePuntos(dto.puntos),
      asistencias: this.normalizeAsistencias(dto.asistencias),
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
        // Normaliza las entidades hijas por si RTDB las devolvió como objeto.
        puntos: this.normalizePuntos(rest.puntos),
        asistencias: this.normalizeAsistencias(rest.asistencias),
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
      const prev = snap.val() || {};
      // update() hace SET completo (reescribe). Para no perder las entidades
      // hijas, si el dto NO las trae, se conservan las existentes.
      const merged = {
        ...dto,
        id,
        puntos: dto.puntos !== undefined ? dto.puntos : prev.puntos,
        asistencias:
          dto.asistencias !== undefined ? dto.asistencias : prev.asistencias,
      };
      await ref.set(this.buildRecord(merged));
      return { success: true, message: 'Evento actualizado.' };
    } catch (err: any) {
      this.logger.error(`[events] update ${key} falló: ${err?.message}`);
      return { success: false, message: err?.message || 'No se pudo actualizar el evento.' };
    }
  }

  /**
   * Marca la asistencia de un usuario a un evento (merge: no pisa a otros).
   * `estado` = 'asistio' | 'no_asistio'. Rechaza si el evento aún no ha
   * iniciado (misma regla que el frontend, validada también aquí).
   */
  async markAttendance(
    id: string,
    dto: { usuario: string; nombre?: string; estado: string },
  ): Promise<{ success: boolean; message?: string }> {
    if (!this.firebase.isEnabled()) return { success: false, message: 'Servicio no disponible.' };
    const key = this.safeKey(id);
    if (!key) return { success: false, message: 'ID requerido.' };
    const usuario = String(dto?.usuario ?? '').trim();
    if (!usuario) return { success: false, message: 'Usuario requerido.' };

    const estado = dto.estado === 'no_asistio' ? 'no_asistio' : 'asistio';
    const userKey = this.safeKey(usuario);
    const ref = this.firebase.db().ref(`${MIRROR_EVENTOS}/${key}`);
    const snap = await ref.get();
    if (!snap.exists()) return { success: false, message: 'El evento no existe.' };

    // Regla de negocio: la asistencia solo puede marcarse DESPUÉS de que el
    // evento inició. Se valida en el backend (además del frontend) para que una
    // llamada directa a la API no pueda saltarse la restricción.
    const evento = snap.val() || {};
    const start = this.eventStart(evento.fecha, evento.hora);
    if (!start) {
      return { success: false, message: 'El evento no tiene una fecha válida.' };
    }
    if (Date.now() < start.getTime()) {
      return {
        success: false,
        message: 'La asistencia solo puede marcarse una vez que el evento haya iniciado.',
      };
    }

    try {
      // Merge directo sobre el nodo del usuario: no reescribe el evento entero.
      await ref.child('asistencias').child(userKey).set({
        usuario,
        nombre: String(dto.nombre ?? ''),
        estado,
        fecha: new Date().toISOString(),
      });
      return { success: true, message: 'Asistencia registrada.' };
    } catch (err: any) {
      this.logger.error(`[events] markAttendance ${key} falló: ${err?.message}`);
      return { success: false, message: err?.message || 'No se pudo registrar la asistencia.' };
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
