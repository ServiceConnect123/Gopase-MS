import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AccessToken,
  RoomServiceClient,
  EgressClient,
  EncodedFileType,
  EncodedFileOutput,
  SegmentedFileOutput,
  S3Upload,
  GCPUpload,
} from 'livekit-server-sdk';
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

  constructor(
    private readonly firebase: FirebaseService,
    private readonly config: ConfigService,
  ) {}

  /** Nombre determinístico de la sala LiveKit de un evento. */
  private roomName(evento: any): string {
    const conj = this.safeKey(evento?.conjunto || 'sin-conjunto').toLowerCase();
    return `gopase-${conj}-${this.safeKey(evento?.id || '')}`;
  }

  /** Credenciales LiveKit (host http(s), api key, secret). Null si falta algo. */
  private livekitCreds(): { host: string; apiKey: string; apiSecret: string } | null {
    const apiKey = this.config.get<string>('LIVEKIT_API_KEY', '');
    const apiSecret = this.config.get<string>('LIVEKIT_API_SECRET', '');
    const url = this.config.get<string>('LIVEKIT_URL', '');
    if (!apiKey || !apiSecret || !url) return null;
    // RoomService/Egress usan HTTP(S), no WSS: convertimos el esquema.
    const host = url.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
    return { host, apiKey, apiSecret };
  }

  private roomService(): RoomServiceClient | null {
    const c = this.livekitCreds();
    return c ? new RoomServiceClient(c.host, c.apiKey, c.apiSecret) : null;
  }

  private egressClient(): EgressClient | null {
    const c = this.livekitCreds();
    return c ? new EgressClient(c.host, c.apiKey, c.apiSecret) : null;
  }

  /** Carga el evento desde RTDB o null si no existe. */
  private async loadEvento(id: string): Promise<any | null> {
    const key = this.safeKey(id);
    if (!key) return null;
    const snap = await this.firebase.db().ref(`${MIRROR_EVENTOS}/${key}`).get();
    return snap.exists() ? snap.val() : null;
  }

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

  /** Normaliza la lista de invitados (usernames) de un evento de audiencia dirigida. */
  private normalizeInvitados(raw: any): string[] {
    if (!Array.isArray(raw)) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const u of raw) {
      const s = String(u ?? '').trim();
      if (s && !seen.has(s)) {
        seen.add(s);
        out.push(s);
      }
    }
    return out;
  }

  /** Normaliza las opciones de una votación: [{ id, texto }]. */
  private normalizeOpciones(raw: any): Array<{ id: string; texto: string }> {
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((o) => o && o.texto)
      .map((o, i) => ({
        id: String(o.id ?? `${Date.now()}_${i}`),
        texto: String(o.texto ?? ''),
      }));
  }

  /**
   * Normaliza el mapa de votos indexado por usuario:
   *   { [usuario]: { usuario, nombre, opcionId, fecha } }
   */
  private normalizeVotos(raw: any): Record<string, any> {
    if (!raw || typeof raw !== 'object') return {};
    const out: Record<string, any> = {};
    for (const key of Object.keys(raw)) {
      const v = raw[key] || {};
      out[this.safeKey(key)] = {
        usuario: String(v.usuario ?? key),
        nombre: String(v.nombre ?? ''),
        opcionId: String(v.opcionId ?? ''),
        fecha: String(v.fecha ?? ''),
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
    const tipo = dto.tipo === 'votacion' ? 'votacion' : 'evento';
    return {
      id: String(dto.id),
      // Tipo de evento: 'evento' (reunión normal) o 'votacion'.
      tipo,
      titulo: dto.titulo ?? '',
      descripcion: dto.descripcion ?? '',
      fecha: dto.fecha ?? '',
      hora: dto.hora ?? '',
      lugar: dto.lugar ?? '',
      conjunto: String(dto.conjunto ?? ''),
      creador: String(dto.creador ?? ''),
      // Audiencia: 'todos' (todo el conjunto) o 'seleccion' (solo invitados[]).
      audiencia: dto.audiencia === 'seleccion' ? 'seleccion' : 'todos',
      invitados:
        dto.audiencia === 'seleccion' ? this.normalizeInvitados(dto.invitados) : [],
      // Videollamada (LiveKit): habilitada por el admin; modo 'reunion' (todos
      // pueden hablar) o 'streaming' (solo admin + ponentes publican). ponentes
      // es la lista de usernames autorizados a hablar/transmitir.
      meetHabilitado: dto.meetHabilitado === true || dto.meetHabilitado === 'true',
      meetModo: dto.meetModo === 'streaming' ? 'streaming' : 'reunion',
      ponentes: this.normalizeInvitados(dto.ponentes),
      // Puntos a tratar (lista) y asistencias (mapa por usuario). Se conservan
      // tal cual; en update() se preservan si el dto no los trae.
      puntos: this.normalizePuntos(dto.puntos),
      asistencias: this.normalizeAsistencias(dto.asistencias),
      // Votación: pregunta + opciones [{id,texto}] + votos (mapa por usuario).
      pregunta: tipo === 'votacion' ? String(dto.pregunta ?? '') : '',
      opciones: tipo === 'votacion' ? this.normalizeOpciones(dto.opciones) : [],
      votos: this.normalizeVotos(dto.votos),
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
        tipo: rest.tipo === 'votacion' ? 'votacion' : 'evento',
        audiencia: rest.audiencia === 'seleccion' ? 'seleccion' : 'todos',
        invitados: this.normalizeInvitados(rest.invitados),
        meetHabilitado: rest.meetHabilitado === true,
        meetModo: rest.meetModo === 'streaming' ? 'streaming' : 'reunion',
        ponentes: this.normalizeInvitados(rest.ponentes),
        // Normaliza las entidades hijas por si RTDB las devolvió como objeto.
        puntos: this.normalizePuntos(rest.puntos),
        asistencias: this.normalizeAsistencias(rest.asistencias),
        pregunta: rest.pregunta ?? '',
        opciones: this.normalizeOpciones(rest.opciones),
        votos: this.normalizeVotos(rest.votos),
        // Votaciones hechas en vivo (RTDB las guarda como objeto por push-id).
        votacionesEnVivo: rest.votacionesEnVivo
          ? Object.values(rest.votacionesEnVivo)
          : [],
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
        tipo: dto.tipo !== undefined ? dto.tipo : prev.tipo,
        audiencia: dto.audiencia !== undefined ? dto.audiencia : prev.audiencia,
        invitados: dto.invitados !== undefined ? dto.invitados : prev.invitados,
        meetHabilitado: dto.meetHabilitado !== undefined ? dto.meetHabilitado : prev.meetHabilitado,
        meetModo: dto.meetModo !== undefined ? dto.meetModo : prev.meetModo,
        ponentes: dto.ponentes !== undefined ? dto.ponentes : prev.ponentes,
        puntos: dto.puntos !== undefined ? dto.puntos : prev.puntos,
        asistencias:
          dto.asistencias !== undefined ? dto.asistencias : prev.asistencias,
        pregunta: dto.pregunta !== undefined ? dto.pregunta : prev.pregunta,
        opciones: dto.opciones !== undefined ? dto.opciones : prev.opciones,
        // Los votos NUNCA se pisan desde el form: siempre se conservan.
        votos: prev.votos,
      };
      await ref.set(this.buildRecord(merged));
      return { success: true, message: 'Evento actualizado.' };
    } catch (err: any) {
      this.logger.error(`[events] update ${key} falló: ${err?.message}`);
      return { success: false, message: err?.message || 'No se pudo actualizar el evento.' };
    }
  }

  /**
   * ¿El usuario pertenece a la audiencia del evento? Si la audiencia es
   * 'seleccion', solo los invitados pueden interactuar (asistencia/voto).
   */
  private puedeParticipar(evento: any, usuario: string): boolean {
    if ((evento?.audiencia ?? 'todos') !== 'seleccion') return true;
    const invitados = this.normalizeInvitados(evento?.invitados);
    return invitados.includes(String(usuario ?? '').trim());
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

    // Audiencia dirigida: solo los invitados pueden marcar asistencia.
    if (!this.puedeParticipar(evento, usuario)) {
      return { success: false, message: 'Este evento no está dirigido a ti.' };
    }

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

  /**
   * Registra el voto de un usuario en un evento de tipo votación (merge: no
   * pisa a otros). Valida que el evento sea votación, que ya haya iniciado y
   * que la opción exista. El admin NO vota por otros: esto lo invoca el
   * propietario desde su sesión.
   */
  async markVote(
    id: string,
    dto: { usuario: string; nombre?: string; opcionId: string },
  ): Promise<{ success: boolean; message?: string }> {
    if (!this.firebase.isEnabled()) return { success: false, message: 'Servicio no disponible.' };
    const key = this.safeKey(id);
    if (!key) return { success: false, message: 'ID requerido.' };
    const usuario = String(dto?.usuario ?? '').trim();
    if (!usuario) return { success: false, message: 'Usuario requerido.' };
    const opcionId = String(dto?.opcionId ?? '').trim();
    if (!opcionId) return { success: false, message: 'Opción requerida.' };

    const userKey = this.safeKey(usuario);
    const ref = this.firebase.db().ref(`${MIRROR_EVENTOS}/${key}`);
    const snap = await ref.get();
    if (!snap.exists()) return { success: false, message: 'El evento no existe.' };

    const evento = snap.val() || {};
    if ((evento.tipo || 'evento') !== 'votacion') {
      return { success: false, message: 'Este evento no es una votación.' };
    }

    // Audiencia dirigida: solo los invitados pueden votar.
    if (!this.puedeParticipar(evento, usuario)) {
      return { success: false, message: 'Esta votación no está dirigida a ti.' };
    }

    // La votación se habilita tras el inicio (misma regla que la asistencia).
    const start = this.eventStart(evento.fecha, evento.hora);
    if (!start) return { success: false, message: 'El evento no tiene una fecha válida.' };
    if (Date.now() < start.getTime()) {
      return { success: false, message: 'La votación se habilita una vez que el evento haya iniciado.' };
    }

    // La opción debe existir en la votación.
    const opciones = this.normalizeOpciones(evento.opciones);
    if (!opciones.some((o) => o.id === opcionId)) {
      return { success: false, message: 'La opción seleccionada no es válida.' };
    }

    try {
      await ref.child('votos').child(userKey).set({
        usuario,
        nombre: String(dto.nombre ?? ''),
        opcionId,
        fecha: new Date().toISOString(),
      });
      return { success: true, message: 'Voto registrado.' };
    } catch (err: any) {
      this.logger.error(`[events] markVote ${key} falló: ${err?.message}`);
      return { success: false, message: err?.message || 'No se pudo registrar el voto.' };
    }
  }

  /**
   * Emite un token de acceso a la videollamada (LiveKit) para un usuario.
   * Seguridad: solo usuarios que pertenezcan a la audiencia del evento obtienen
   * token (sin token no se puede entrar a la sala, aunque se conozca su nombre).
   *
   * Roles:
   *  - admin: siempre puede publicar y moderar (canPublish + roomAdmin).
   *  - ponentes[] o modo 'reunion': pueden publicar.
   *  - resto en modo 'streaming': solo reciben (subscribe-only).
   */
  async createMeetToken(
    id: string,
    dto: { usuario: string; nombre?: string; esAdmin?: boolean },
  ): Promise<{
    success: boolean;
    message?: string;
    url?: string;
    token?: string;
    room?: string;
    canPublish?: boolean;
  }> {
    if (!this.firebase.isEnabled()) return { success: false, message: 'Servicio no disponible.' };

    const apiKey = this.config.get<string>('LIVEKIT_API_KEY', '');
    const apiSecret = this.config.get<string>('LIVEKIT_API_SECRET', '');
    const url = this.config.get<string>('LIVEKIT_URL', '');
    if (!apiKey || !apiSecret || !url) {
      return { success: false, message: 'La videollamada no está configurada en el servidor.' };
    }

    const key = this.safeKey(id);
    const usuario = String(dto?.usuario ?? '').trim();
    if (!key) return { success: false, message: 'ID requerido.' };
    if (!usuario) return { success: false, message: 'Usuario requerido.' };

    const snap = await this.firebase.db().ref(`${MIRROR_EVENTOS}/${key}`).get();
    if (!snap.exists()) return { success: false, message: 'El evento no existe.' };
    const evento = snap.val() || {};

    if (evento.meetHabilitado !== true) {
      return { success: false, message: 'La videollamada no está habilitada para este evento.' };
    }

    // Audiencia: solo invitados (o todos) pueden entrar.
    const esAdmin = dto?.esAdmin === true;
    if (!esAdmin && !this.puedeParticipar(evento, usuario)) {
      return { success: false, message: 'Este evento no está dirigido a ti.' };
    }

    // Rol de publicación: admin y ponentes publican; en modo reunión, todos.
    const modo = evento.meetModo === 'streaming' ? 'streaming' : 'reunion';
    const ponentes = this.normalizeInvitados(evento.ponentes);
    const canPublish = esAdmin || modo === 'reunion' || ponentes.includes(usuario);

    const room = this.roomName(evento);
    try {
      const at = new AccessToken(apiKey, apiSecret, {
        identity: usuario,
        name: String(dto.nombre || usuario),
        // El token caduca en 4h: cubre reuniones largas sin reemitir.
        ttl: '4h',
      });
      at.addGrant({
        room,
        roomJoin: true,
        canPublish,
        canSubscribe: true,
        canPublishData: true,
        // El admin puede moderar la sala (silenciar, expulsar, etc.).
        roomAdmin: esAdmin,
      });
      const token = await at.toJwt();
      return { success: true, url, token, room, canPublish };
    } catch (err: any) {
      this.logger.error(`[events] createMeetToken ${key} falló: ${err?.message}`);
      return { success: false, message: err?.message || 'No se pudo generar el acceso a la videollamada.' };
    }
  }

  // ==========================================================================
  // Moderación de la sala (solo admin). Actúan sobre LiveKit en vivo.
  // ==========================================================================

  /**
   * Cambia el permiso de publicación de un participante (promover ponente o
   * degradar a espectador). Solo admin. `canPublish` true = puede hablar.
   */
  async setParticipantPublish(
    id: string,
    targetIdentity: string,
    canPublish: boolean,
  ): Promise<{ success: boolean; message?: string }> {
    const svc = this.roomService();
    if (!svc) return { success: false, message: 'La videollamada no está configurada.' };
    const evento = await this.loadEvento(id);
    if (!evento) return { success: false, message: 'El evento no existe.' };
    const room = this.roomName(evento);
    try {
      await svc.updateParticipant(room, targetIdentity, undefined, {
        canPublish,
        canSubscribe: true,
        canPublishData: true,
      });
      return { success: true, message: canPublish ? 'Ponente habilitado.' : 'Vuelto a espectador.' };
    } catch (err: any) {
      this.logger.error(`[events] setParticipantPublish falló: ${err?.message}`);
      return { success: false, message: err?.message || 'No se pudo actualizar el participante.' };
    }
  }

  /** Silencia (mute) todas las pistas publicadas por un participante. */
  async muteParticipant(
    id: string,
    targetIdentity: string,
  ): Promise<{ success: boolean; message?: string }> {
    const svc = this.roomService();
    if (!svc) return { success: false, message: 'La videollamada no está configurada.' };
    const evento = await this.loadEvento(id);
    if (!evento) return { success: false, message: 'El evento no existe.' };
    const room = this.roomName(evento);
    try {
      const p = await svc.getParticipant(room, targetIdentity);
      for (const track of p.tracks || []) {
        await svc.mutePublishedTrack(room, targetIdentity, track.sid, true);
      }
      return { success: true, message: 'Participante silenciado.' };
    } catch (err: any) {
      this.logger.error(`[events] muteParticipant falló: ${err?.message}`);
      return { success: false, message: err?.message || 'No se pudo silenciar.' };
    }
  }

  /** Silencia a TODOS los participantes excepto, opcionalmente, al admin. */
  async muteAll(
    id: string,
    exceptIdentity?: string,
  ): Promise<{ success: boolean; message?: string; silenciados?: number }> {
    const svc = this.roomService();
    if (!svc) return { success: false, message: 'La videollamada no está configurada.' };
    const evento = await this.loadEvento(id);
    if (!evento) return { success: false, message: 'El evento no existe.' };
    const room = this.roomName(evento);
    try {
      const participants = await svc.listParticipants(room);
      let count = 0;
      for (const p of participants) {
        if (exceptIdentity && p.identity === exceptIdentity) continue;
        for (const track of p.tracks || []) {
          // Solo silencia audio; el video no se toca.
          if ((track as any).type === 1 /* AUDIO */ || (track as any).source === 2 /* MICROPHONE */) {
            await svc.mutePublishedTrack(room, p.identity, track.sid, true);
            count++;
          }
        }
      }
      return { success: true, silenciados: count, message: `Se silenciaron ${count} pistas.` };
    } catch (err: any) {
      this.logger.error(`[events] muteAll falló: ${err?.message}`);
      return { success: false, message: err?.message || 'No se pudo silenciar a todos.' };
    }
  }

  /** Expulsa a un participante de la sala. */
  async removeParticipant(
    id: string,
    targetIdentity: string,
  ): Promise<{ success: boolean; message?: string }> {
    const svc = this.roomService();
    if (!svc) return { success: false, message: 'La videollamada no está configurada.' };
    const evento = await this.loadEvento(id);
    if (!evento) return { success: false, message: 'El evento no existe.' };
    const room = this.roomName(evento);
    try {
      await svc.removeParticipant(room, targetIdentity);
      return { success: true, message: 'Participante expulsado.' };
    } catch (err: any) {
      this.logger.error(`[events] removeParticipant falló: ${err?.message}`);
      return { success: false, message: err?.message || 'No se pudo expulsar.' };
    }
  }

  // ==========================================================================
  // Grabación (Egress a archivo) y HLS (Egress a segmentos). Requieren storage.
  // ==========================================================================

  /** Configura el destino de almacenamiento (S3 o GCP) desde env. */
  private buildUpload(): S3Upload | GCPUpload | null {
    const provider = this.config.get<string>('LIVEKIT_EGRESS_PROVIDER', '').toLowerCase();
    if (provider === 's3') {
      return new S3Upload({
        accessKey: this.config.get<string>('LIVEKIT_S3_ACCESS_KEY', ''),
        secret: this.config.get<string>('LIVEKIT_S3_SECRET', ''),
        region: this.config.get<string>('LIVEKIT_S3_REGION', ''),
        bucket: this.config.get<string>('LIVEKIT_S3_BUCKET', ''),
        endpoint: this.config.get<string>('LIVEKIT_S3_ENDPOINT', '') || undefined,
      });
    }
    if (provider === 'gcp') {
      return new GCPUpload({
        credentials: this.config.get<string>('LIVEKIT_GCP_CREDENTIALS', ''),
        bucket: this.config.get<string>('LIVEKIT_GCP_BUCKET', ''),
      });
    }
    return null;
  }

  /** Inicia la grabación (acta en video) de la sala. Solo admin. */
  async startRecording(id: string): Promise<{ success: boolean; message?: string; egressId?: string }> {
    const egress = this.egressClient();
    if (!egress) return { success: false, message: 'La videollamada no está configurada.' };
    const upload = this.buildUpload();
    if (!upload) return { success: false, message: 'El almacenamiento de grabación no está configurado.' };
    const evento = await this.loadEvento(id);
    if (!evento) return { success: false, message: 'El evento no existe.' };
    const room = this.roomName(evento);
    const key = this.safeKey(id);

    try {
      const output = new EncodedFileOutput({
        fileType: EncodedFileType.MP4,
        filepath: `grabaciones/${room}-{time}.mp4`,
        output: upload instanceof S3Upload ? { case: 's3', value: upload } : { case: 'gcp', value: upload },
      });
      const info = await egress.startRoomCompositeEgress(room, output);
      // Guarda el egressId en el evento para poder detenerlo luego.
      await this.firebase.db().ref(`${MIRROR_EVENTOS}/${key}/grabacionEgressId`).set(info.egressId);
      return { success: true, egressId: info.egressId, message: 'Grabación iniciada.' };
    } catch (err: any) {
      this.logger.error(`[events] startRecording falló: ${err?.message}`);
      return { success: false, message: err?.message || 'No se pudo iniciar la grabación.' };
    }
  }

  /** Detiene la grabación en curso de la sala. Solo admin. */
  async stopRecording(id: string): Promise<{ success: boolean; message?: string }> {
    const egress = this.egressClient();
    if (!egress) return { success: false, message: 'La videollamada no está configurada.' };
    const evento = await this.loadEvento(id);
    if (!evento) return { success: false, message: 'El evento no existe.' };
    const egressId = evento.grabacionEgressId;
    if (!egressId) return { success: false, message: 'No hay una grabación en curso.' };
    const key = this.safeKey(id);
    try {
      await egress.stopEgress(egressId);
      await this.firebase.db().ref(`${MIRROR_EVENTOS}/${key}/grabacionEgressId`).remove();
      return { success: true, message: 'Grabación detenida. El archivo quedará disponible en el almacenamiento.' };
    } catch (err: any) {
      this.logger.error(`[events] stopRecording falló: ${err?.message}`);
      return { success: false, message: err?.message || 'No se pudo detener la grabación.' };
    }
  }

  /**
   * Inicia una transmisión HLS de la sala (segmentos a storage) para que
   * audiencias masivas vean sin entrar como participantes. Solo admin.
   */
  async startHls(id: string): Promise<{ success: boolean; message?: string; egressId?: string }> {
    const egress = this.egressClient();
    if (!egress) return { success: false, message: 'La videollamada no está configurada.' };
    const upload = this.buildUpload();
    if (!upload) return { success: false, message: 'El almacenamiento de HLS no está configurado.' };
    const evento = await this.loadEvento(id);
    if (!evento) return { success: false, message: 'El evento no existe.' };
    const room = this.roomName(evento);
    const key = this.safeKey(id);
    try {
      const output = new SegmentedFileOutput({
        filenamePrefix: `hls/${room}`,
        playlistName: `${room}.m3u8`,
        output: upload instanceof S3Upload ? { case: 's3', value: upload } : { case: 'gcp', value: upload },
      });
      const info = await egress.startRoomCompositeEgress(room, { segments: output });
      await this.firebase.db().ref(`${MIRROR_EVENTOS}/${key}/hlsEgressId`).set(info.egressId);
      return { success: true, egressId: info.egressId, message: 'Transmisión HLS iniciada.' };
    } catch (err: any) {
      this.logger.error(`[events] startHls falló: ${err?.message}`);
      return { success: false, message: err?.message || 'No se pudo iniciar la transmisión.' };
    }
  }

  async stopHls(id: string): Promise<{ success: boolean; message?: string }> {
    const egress = this.egressClient();
    if (!egress) return { success: false, message: 'La videollamada no está configurada.' };
    const evento = await this.loadEvento(id);
    if (!evento) return { success: false, message: 'El evento no existe.' };
    const egressId = evento.hlsEgressId;
    if (!egressId) return { success: false, message: 'No hay una transmisión en curso.' };
    const key = this.safeKey(id);
    try {
      await egress.stopEgress(egressId);
      await this.firebase.db().ref(`${MIRROR_EVENTOS}/${key}/hlsEgressId`).remove();
      return { success: true, message: 'Transmisión detenida.' };
    } catch (err: any) {
      this.logger.error(`[events] stopHls falló: ${err?.message}`);
      return { success: false, message: err?.message || 'No se pudo detener la transmisión.' };
    }
  }

  /**
   * Guarda el resultado de una votación hecha EN VIVO durante la llamada en el
   * registro del evento (array `votacionesEnVivo`). No interfiere con la
   * votación "principal" del evento (campos votacion/opciones/votos).
   */
  async saveLivePoll(
    id: string,
    dto: {
      pregunta?: string;
      opciones: Array<{ id: string; texto: string }>;
      resultados: Record<string, number>;
      totalVotos?: number;
    },
  ): Promise<{ success: boolean; message?: string }> {
    if (!this.firebase.isEnabled()) return { success: false, message: 'Servicio no disponible.' };
    const key = this.safeKey(id);
    if (!key) return { success: false, message: 'ID requerido.' };
    const opciones = this.normalizeOpciones(dto?.opciones);
    if (opciones.length === 0) return { success: false, message: 'Faltan opciones.' };

    const ref = this.firebase.db().ref(`${MIRROR_EVENTOS}/${key}`);
    const snap = await ref.get();
    if (!snap.exists()) return { success: false, message: 'El evento no existe.' };

    const registro = {
      id: Date.now().toString(),
      pregunta: String(dto?.pregunta ?? ''),
      // Resultado consolidado: cada opción con su conteo de votos.
      resultados: opciones.map((o) => ({
        opcionId: o.id,
        texto: o.texto,
        votos: Number(dto?.resultados?.[o.id] ?? 0),
      })),
      totalVotos: Number(
        dto?.totalVotos ??
          opciones.reduce((s, o) => s + Number(dto?.resultados?.[o.id] ?? 0), 0),
      ),
      fecha: new Date().toISOString(),
    };

    try {
      // Append al array existente (push en un nodo lista).
      await ref.child('votacionesEnVivo').push().set(registro);
      return { success: true, message: 'Votación guardada en el evento.' };
    } catch (err: any) {
      this.logger.error(`[events] saveLivePoll ${key} falló: ${err?.message}`);
      return { success: false, message: err?.message || 'No se pudo guardar la votación.' };
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
