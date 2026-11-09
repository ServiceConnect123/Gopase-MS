// ==========================================
// MinutasService — Minuta digital de portería
// ==========================================
// Una MINUTA es el registro oficial del turno de un vigilante.
// Tiene un ciclo de vida: apertura → novedades durante el turno → cierre.
//
// Colecciones en RTDB:
//   mirror/minutas/{id}   — datos del turno (apertura/cierre, vigilante, estado)
//   mirror/turnos/{id}    — asignaciones futuras (reemplaza turns.json local)
//
// Tipos de novedad dentro de una minuta:
//   'ingreso_persona'  — visita a propietario
//   'ingreso_vehiculo' — vehículo no registrado
//   'paquete'          — paquete/correspondencia recibida
//   'ronda'            — ronda de vigilancia
//   'incidente'        — novedad de seguridad/convivencia
//   'otro'             — cualquier otra observación
import { Injectable, Logger } from '@nestjs/common';
import { FirebaseService } from '../firebase/firebase.service';

const MIRROR_MINUTAS = 'mirror/minutas';
const MIRROR_TURNOS  = 'mirror/turnos';

export type NovedadTipo =
  | 'ingreso_persona'
  | 'ingreso_vehiculo'
  | 'paquete'
  | 'ronda'
  | 'incidente'
  | 'otro';

export interface NovedadDTO {
  tipo: NovedadTipo;
  descripcion: string;
  /** Nombre del visitante / placa del vehículo / destinatario del paquete. */
  referencia?: string;
  /** Unidad/apartamento relacionada. */
  unidad?: string;
  /** URL de imagen (Drive) adjunta a la novedad. */
  imagenUrl?: string;
}

@Injectable()
export class MinutasService {
  private readonly logger = new Logger(MinutasService.name);

  constructor(private readonly firebase: FirebaseService) {}

  private safeKey(raw: unknown): string {
    return String(raw ?? '').replace(/[.#$/\[\]]/g, '_');
  }

  private now(): string {
    return new Date().toISOString();
  }

  // ===========================================================================
  // MINUTAS
  // ===========================================================================

  /** Lista las minutas de un conjunto. Filtra por fecha si se pasa. */
  async listMinutas(filters: {
    conjunto: string;
    fecha?: string;   // YYYY-MM-DD — filtra por el día
    estado?: string;  // 'abierta' | 'cerrada'
    limit?: number;
  }): Promise<{ success: boolean; data: any[]; message?: string }> {
    if (!this.firebase.isEnabled()) return { success: false, data: [], message: 'Servicio no disponible.' };
    try {
      const snap = await this.firebase.db().ref(MIRROR_MINUTAS).get();
      if (!snap.exists()) return { success: true, data: [] };
      const norm = (s: unknown) => String(s ?? '').trim().toLowerCase();
      let items = Object.values(snap.val() || {}) as any[];
      items = items.filter((m) => norm(m.conjunto) === norm(filters.conjunto));
      if (filters.fecha) {
        items = items.filter((m) => String(m.fechaApertura || '').startsWith(filters.fecha!));
      }
      if (filters.estado) {
        items = items.filter((m) => norm(m.estado) === norm(filters.estado));
      }
      items.sort((a, b) => String(b.fechaApertura || '').localeCompare(String(a.fechaApertura || '')));
      const limit = Math.min(filters.limit ?? 50, 200);
      return { success: true, data: items.slice(0, limit).map(this.sanitize) };
    } catch (err: any) {
      this.logger.error(`[minutas] listMinutas: ${err?.message}`);
      return { success: false, data: [], message: err?.message };
    }
  }

  /** Obtiene una minuta por id. */
  async getMinuta(id: string): Promise<{ success: boolean; data?: any; message?: string }> {
    if (!this.firebase.isEnabled()) return { success: false, message: 'Servicio no disponible.' };
    const snap = await this.firebase.db().ref(`${MIRROR_MINUTAS}/${this.safeKey(id)}`).get();
    if (!snap.exists()) return { success: false, message: 'Minuta no encontrada.' };
    return { success: true, data: this.sanitize(snap.val()) };
  }

  /** Abre una nueva minuta (inicio de turno). */
  async abrirMinuta(dto: {
    conjunto: string;
    vigilante: string;       // username del vigilante
    vigilanteNombre: string; // nombre legible
    turno: 'Mañana' | 'Noche' | 'Personalizado';
    observacionInicial?: string;
  }): Promise<{ success: boolean; data?: any; message?: string }> {
    if (!this.firebase.isEnabled()) return { success: false, message: 'Servicio no disponible.' };
    // Solo puede haber UNA minuta abierta por conjunto a la vez.
    const abierta = await this.getMinutaAbierta(dto.conjunto);
    if (abierta) {
      return { success: false, message: `Ya hay una minuta abierta (turno de ${abierta.vigilanteNombre}). Ciérrala primero.` };
    }
    const id = `minuta_${Date.now()}`;
    const record = {
      id,
      conjunto: dto.conjunto,
      vigilante: dto.vigilante,
      vigilanteNombre: dto.vigilanteNombre,
      turno: dto.turno,
      estado: 'abierta',
      fechaApertura: this.now(),
      fechaCierre: null,
      observacionInicial: dto.observacionInicial || '',
      observacionCierre: '',
      novedades: [],
      _fbWrite: true,
    };
    try {
      await this.firebase.db().ref(`${MIRROR_MINUTAS}/${this.safeKey(id)}`).set(record);
      this.logger.log(`[minutas] abierta ${id} por ${dto.vigilante} en ${dto.conjunto}`);
      return { success: true, data: this.sanitize(record) };
    } catch (err: any) {
      this.logger.error(`[minutas] abrirMinuta: ${err?.message}`);
      return { success: false, message: err?.message };
    }
  }

  /** Cierra la minuta activa del conjunto. */
  async cerrarMinuta(id: string, dto: {
    observacionCierre?: string;
    cerradoPor: string;
  }): Promise<{ success: boolean; message?: string }> {
    if (!this.firebase.isEnabled()) return { success: false, message: 'Servicio no disponible.' };
    const key = this.safeKey(id);
    const ref = this.firebase.db().ref(`${MIRROR_MINUTAS}/${key}`);
    const snap = await ref.get();
    if (!snap.exists()) return { success: false, message: 'Minuta no encontrada.' };
    const m = snap.val();
    if (m.estado === 'cerrada') return { success: false, message: 'La minuta ya está cerrada.' };
    try {
      await ref.update({
        estado: 'cerrada',
        fechaCierre: this.now(),
        observacionCierre: dto.observacionCierre || '',
        cerradoPor: dto.cerradoPor,
        _fbWrite: true,
      });
      this.logger.log(`[minutas] cerrada ${id} por ${dto.cerradoPor}`);
      return { success: true, message: 'Minuta cerrada.' };
    } catch (err: any) {
      this.logger.error(`[minutas] cerrarMinuta: ${err?.message}`);
      return { success: false, message: err?.message };
    }
  }

  /** Agrega una novedad a la minuta activa. */
  async agregarNovedad(minutaId: string, novedad: NovedadDTO & { registradoPor: string }): Promise<{
    success: boolean; novedadId?: string; message?: string;
  }> {
    if (!this.firebase.isEnabled()) return { success: false, message: 'Servicio no disponible.' };
    const key = this.safeKey(minutaId);
    const ref = this.firebase.db().ref(`${MIRROR_MINUTAS}/${key}`);
    const snap = await ref.get();
    if (!snap.exists()) return { success: false, message: 'Minuta no encontrada.' };
    const m = snap.val();
    if (m.estado === 'cerrada') return { success: false, message: 'No se pueden agregar novedades a una minuta cerrada.' };
    const novedadId = `nov_${Date.now()}`;
    const nuevaNovedad = {
      id: novedadId,
      tipo: novedad.tipo,
      descripcion: novedad.descripcion,
      referencia: novedad.referencia || '',
      unidad: novedad.unidad || '',
      imagenUrl: novedad.imagenUrl || '',
      registradoPor: novedad.registradoPor,
      fecha: this.now(),
    };
    const novedades = Array.isArray(m.novedades) ? [...m.novedades, nuevaNovedad] : [nuevaNovedad];
    try {
      await ref.update({ novedades, _fbWrite: true });
      this.logger.log(`[minutas] novedad ${novedadId} (${novedad.tipo}) en ${minutaId}`);
      return { success: true, novedadId };
    } catch (err: any) {
      this.logger.error(`[minutas] agregarNovedad: ${err?.message}`);
      return { success: false, message: err?.message };
    }
  }

  /** Devuelve la minuta abierta del conjunto (o null si no hay). */
  async getMinutaAbierta(conjunto: string): Promise<any | null> {
    if (!this.firebase.isEnabled()) return null;
    try {
      const snap = await this.firebase.db().ref(MIRROR_MINUTAS).get();
      if (!snap.exists()) return null;
      const norm = (s: unknown) => String(s ?? '').trim().toLowerCase();
      const all = Object.values(snap.val() || {}) as any[];
      return all.find((m) => norm(m.conjunto) === norm(conjunto) && m.estado === 'abierta') ?? null;
    } catch {
      return null;
    }
  }

  // ===========================================================================
  // TURNOS ASIGNADOS (reemplaza turns.json local)
  // ===========================================================================

  /** Lista turnos asignados de un conjunto desde hoy en adelante. */
  async listTurnos(conjunto: string, diasAdelante = 14): Promise<{ success: boolean; data: any[] }> {
    if (!this.firebase.isEnabled()) return { success: false, data: [] };
    try {
      const snap = await this.firebase.db().ref(MIRROR_TURNOS).get();
      if (!snap.exists()) return { success: true, data: [] };
      const norm = (s: unknown) => String(s ?? '').trim().toLowerCase();
      const hoy = new Date(); hoy.setHours(0,0,0,0);
      const limite = new Date(hoy); limite.setDate(limite.getDate() + diasAdelante);
      const fmtDate = (d: Date) => d.toISOString().slice(0, 10);
      let items = Object.values(snap.val() || {}) as any[];
      items = items
        .filter((t) => norm(t.conjunto) === norm(conjunto))
        .filter((t) => {
          const f = String(t.fecha || '');
          return f >= fmtDate(hoy) && f <= fmtDate(limite);
        })
        .sort((a, b) => String(a.fecha || '').localeCompare(String(b.fecha || '')));
      return { success: true, data: items };
    } catch (err: any) {
      this.logger.error(`[minutas] listTurnos: ${err?.message}`);
      return { success: false, data: [] };
    }
  }

  /** Asigna un turno (admin). */
  async asignarTurno(dto: {
    conjunto: string;
    fecha: string;         // YYYY-MM-DD
    turno: 'Mañana' | 'Noche';
    vigilantes: string[];  // usernames
    vigilantesNombres: string[];
    creadoPor: string;
  }): Promise<{ success: boolean; message?: string; id?: string }> {
    if (!this.firebase.isEnabled()) return { success: false, message: 'Servicio no disponible.' };
    // Verificar que no exista ya ese turno para esa fecha.
    const snap = await this.firebase.db().ref(MIRROR_TURNOS).get();
    if (snap.exists()) {
      const norm = (s: unknown) => String(s ?? '').trim().toLowerCase();
      const all = Object.values(snap.val() || {}) as any[];
      const duplicado = all.find((t) =>
        norm(t.conjunto) === norm(dto.conjunto) &&
        t.fecha === dto.fecha &&
        norm(t.turno) === norm(dto.turno),
      );
      if (duplicado) return { success: false, message: `Ya existe un turno de ${dto.turno} para ${dto.fecha}.` };
    }
    const id = `turno_${Date.now()}`;
    try {
      await this.firebase.db().ref(`${MIRROR_TURNOS}/${this.safeKey(id)}`).set({
        id, conjunto: dto.conjunto, fecha: dto.fecha, turno: dto.turno,
        vigilantes: dto.vigilantes, vigilantesNombres: dto.vigilantesNombres,
        creadoPor: dto.creadoPor, creadoEn: this.now(), _fbWrite: true,
      });
      return { success: true, id, message: `Turno ${dto.turno} asignado para ${dto.fecha}.` };
    } catch (err: any) {
      this.logger.error(`[minutas] asignarTurno: ${err?.message}`);
      return { success: false, message: err?.message };
    }
  }

  /** Elimina un turno asignado. */
  async eliminarTurno(id: string): Promise<{ success: boolean; message?: string }> {
    if (!this.firebase.isEnabled()) return { success: false, message: 'Servicio no disponible.' };
    try {
      await this.firebase.db().ref(`${MIRROR_TURNOS}/${this.safeKey(id)}`).remove();
      return { success: true, message: 'Turno eliminado.' };
    } catch (err: any) {
      return { success: false, message: err?.message };
    }
  }

  // ===========================================================================
  // Internals
  // ===========================================================================
  private sanitize(m: any): any {
    const { _fbWrite, ...rest } = m || {};
    return rest;
  }
}
