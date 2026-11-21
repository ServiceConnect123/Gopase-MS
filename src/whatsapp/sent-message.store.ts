import { Logger } from '@nestjs/common';
import { BufferJSON } from '@whiskeysockets/baileys';
import { safeNodeKey } from './firebase-auth-state';

/**
 * Store de los mensajes que ENVÍA el servicio y de su estado de entrega.
 *
 * 1) Reenvíos sin mensajes vacíos. Cuando el teléfono que recibe (o el propio
 *    teléfono del emisor, con su copia) no logra descifrar un mensaje, pide un
 *    reenvío y Baileys llama a `getMessage`. Antes los mensajes vivían solo en
 *    memoria: tras un reinicio de Render no se encontraban y se respondía con
 *    `{ conversation: '' }`, que WhatsApp mostraba como una burbuja VACÍA.
 *    Ahora se guardan también en RTDB (72 h) y, si de verdad no existen, se
 *    devuelve `undefined` (Baileys no reenvía nada en vez de reenviar vacío).
 *
 * 2) Estado de entrega (enviado → entregado → leído, o error) a partir de los
 *    recibos que ya manda WhatsApp, para saber si un mensaje llegó.
 *
 * Rendimiento: nada de esto se espera en el camino de un envío. Las escrituras
 * se acumulan y se mandan a RTDB en UNA sola actualización cada pocos segundos;
 * las lecturas solo ocurren ante un reenvío de un mensaje que ya no está en
 * memoria (raro) o cuando un admin consulta las entregas.
 *
 * Estructura en RTDB (por día, para borrar lo viejo sin consultas):
 *   wsp_msg_store/<yyyymmdd>/<sesion>/<id> = { m: <mensaje serializado>, ts }
 *   wsp_entrega/<yyyymmdd>/<id>            = Entrega
 */

export const MSG_STORE_ROOT = 'wsp_msg_store';
export const ENTREGA_ROOT = 'wsp_entrega';

/** Valores de proto.WebMessageInfo.Status (Baileys). */
export const WA_STATUS = {
  ERROR: 0,
  PENDING: 1,
  SERVER_ACK: 2,
  DELIVERY_ACK: 3,
  READ: 4,
  PLAYED: 5,
} as const;

export type EstadoEntrega =
  | 'enviado'
  | 'entregado'
  | 'leido'
  | 'error'
  /** Pasó el plazo sin confirmación de entrega (el destinatario no se conectó). */
  | 'sin_entregar';

export interface Entrega {
  id: string;
  /** Sesión de WhatsApp que lo envió (número del conjunto o la global). */
  sesion: string;
  /** Conjunto para el que se envió (puede haber salido por la sesión global). */
  conjunto: string;
  /** JID del destinatario. */
  to: string;
  tipo: 'texto' | 'imagen';
  estado: EstadoEntrega;
  enviadoEn: number;
  entregadoEn?: number;
  leidoEn?: number;
  reintentos: number;
  error?: string;
  /** Bucket (yyyymmdd) donde vive el registro. */
  fecha: string;
}

/** Subconjunto de FirebaseService que usa el store (facilita las pruebas). */
export interface FirebaseLike {
  isEnabled(): boolean;
  db(): {
    ref(path?: string): {
      get(): Promise<{ exists(): boolean; val(): any }>;
      update(values: Record<string, any>): Promise<any>;
      remove(): Promise<any>;
    };
  };
}

export interface SentMessageStoreOptions {
  /** Cada cuánto se escriben los cambios acumulados (ms). */
  flushMs?: number;
  /** Días que se conservan en RTDB. */
  ttlDays?: number;
  /** Sin entrega tras este tiempo: se hace UN reenvío con el mismo id (ms). */
  reintentoTrasMs?: number;
  /** Sin entrega tras este tiempo: se marca `sin_entregar` (ms). */
  sinEntregarTrasMs?: number;
  /** Máximo de reenvíos automáticos por mensaje. */
  maxReintentos?: number;
}

const DIA_MS = 86_400_000;
/** Colombia (UTC-5, sin horario de verano): el "día" de los buckets. */
const OFFSET_CO_MS = 5 * 3_600_000;
const MEM_MAX = 5000;
const ORDEN: Record<EstadoEntrega, number> = {
  enviado: 1,
  sin_entregar: 1,
  error: 1,
  entregado: 2,
  leido: 3,
};

export function fechaBucket(ts: number): string {
  return new Date(ts - OFFSET_CO_MS).toISOString().slice(0, 10).replace(/-/g, '');
}

/**
 * Copia del mensaje lista para guardar: sin miniaturas (pesan y no hacen falta
 * para reenviar; la imagen se reenvía con su URL y llaves de cifrado).
 */
export function serializarMensaje(message: any): string {
  const json = JSON.stringify(message, BufferJSON.replacer);
  const copia = JSON.parse(json);
  for (const k of ['imageMessage', 'videoMessage', 'documentMessage']) {
    if (copia?.[k]?.jpegThumbnail) delete copia[k].jpegThumbnail;
  }
  return JSON.stringify(copia);
}

export function deserializarMensaje(raw: string): any {
  return JSON.parse(raw, BufferJSON.reviver);
}

export class SentMessageStore {
  private readonly mem = new Map<string, { msg: any; ts: number }>();
  private readonly entregas = new Map<string, Entrega>();
  private pendiente: Record<string, any> = {};
  private timer: NodeJS.Timeout | null = null;
  private readonly flushMs: number;
  private readonly ttlDays: number;
  private readonly reintentoTrasMs: number;
  private readonly sinEntregarTrasMs: number;
  readonly maxReintentos: number;

  constructor(
    private readonly firebase: FirebaseLike,
    private readonly logger: Logger,
    opts: SentMessageStoreOptions = {},
  ) {
    this.flushMs = opts.flushMs ?? 3000;
    this.ttlDays = opts.ttlDays ?? 3;
    this.reintentoTrasMs = opts.reintentoTrasMs ?? 30 * 60_000;
    this.sinEntregarTrasMs = opts.sinEntregarTrasMs ?? 6 * 3_600_000;
    this.maxReintentos = opts.maxReintentos ?? 2;
  }

  // ---------------------------------------------------------------- mensajes

  /** Solo memoria (mensajes propios vistos en `messages.upsert`). */
  remember(sesion: string, id: string, message: any, ts = Date.now()): void {
    if (!id || !message) return;
    this.mem.set(`${sesion}:${id}`, { msg: message, ts });
    while (this.mem.size > MEM_MAX) {
      const oldest = this.mem.keys().next().value;
      if (oldest === undefined) break;
      this.mem.delete(oldest);
    }
  }

  /**
   * Registra un envío: guarda el mensaje (memoria + RTDB) y crea su registro
   * de entrega en estado `enviado`. No bloquea: la escritura va en el lote.
   */
  registrarEnvio(params: {
    sesion: string;
    conjunto: string;
    to: string;
    id: string;
    message: any;
    tipo: 'texto' | 'imagen';
    ts?: number;
  }): Entrega | null {
    const { sesion, conjunto, to, id, message, tipo } = params;
    if (!id || !message) return null;
    const ts = params.ts ?? Date.now();
    this.remember(sesion, id, message, ts);
    const fecha = fechaBucket(ts);
    let m: string | null = null;
    try {
      m = serializarMensaje(message);
    } catch (e: any) {
      this.logger.warn(`No se pudo serializar el mensaje ${id}: ${e?.message}`);
    }
    if (m) this.encolar(`${MSG_STORE_ROOT}/${fecha}/${safeNodeKey(sesion)}/${id}`, { m, ts });

    const entrega: Entrega = { id, sesion, conjunto, to, tipo, estado: 'enviado', enviadoEn: ts, reintentos: 0, fecha };
    this.guardarEntregaEnMemoria(entrega);
    this.encolar(`${ENTREGA_ROOT}/${fecha}/${id}`, this.paraRtdb(entrega));
    return entrega;
  }

  /**
   * Mensaje para un reenvío: memoria primero; si no está (p. ej. tras un
   * reinicio), RTDB en los últimos `ttlDays` días. `undefined` si no existe:
   * así Baileys NO reenvía (antes se reenviaba un texto vacío).
   */
  async get(sesion: string, id: string, now = Date.now()): Promise<any | undefined> {
    if (!id) return undefined;
    const hit = this.mem.get(`${sesion}:${id}`);
    if (hit) return hit.msg;
    if (!this.firebase.isEnabled()) return undefined;
    const nodo = safeNodeKey(sesion);
    for (let d = 0; d < this.ttlDays; d++) {
      const fecha = fechaBucket(now - d * DIA_MS);
      try {
        const snap = await this.firebase.db().ref(`${MSG_STORE_ROOT}/${fecha}/${nodo}/${id}/m`).get();
        if (snap.exists()) {
          const msg = deserializarMensaje(String(snap.val()));
          this.remember(sesion, id, msg);
          return msg;
        }
      } catch (e: any) {
        this.logger.debug(`Lectura de ${MSG_STORE_ROOT} falló para ${id}: ${e?.message}`);
      }
    }
    return undefined;
  }

  // ---------------------------------------------------------------- entregas

  /**
   * Aplica un recibo de WhatsApp. Devuelve la entrega actualizada o null si el
   * id no es un mensaje enviado por el servicio (p. ej. lo escribió la persona
   * desde su teléfono) o si el estado no avanza.
   */
  actualizarEstado(id: string, status: number, error?: string, now = Date.now()): Entrega | null {
    const e = this.entregas.get(id);
    if (!e) return null;
    let estado: EstadoEntrega | null = null;
    if (status === WA_STATUS.ERROR) estado = 'error';
    else if (status === WA_STATUS.DELIVERY_ACK) estado = 'entregado';
    else if (status === WA_STATUS.READ || status === WA_STATUS.PLAYED) estado = 'leido';
    if (!estado) return null;
    // Nunca retroceder: un error no pisa una entrega confirmada, y un recibo
    // tardío de entrega no pisa un "leído".
    if (estado === 'error' ? ORDEN[e.estado] > 1 : ORDEN[estado] <= ORDEN[e.estado]) return null;

    const cambios: Partial<Entrega> = { estado };
    if (estado === 'entregado') cambios.entregadoEn = now;
    if (estado === 'leido') {
      cambios.leidoEn = now;
      if (!e.entregadoEn) cambios.entregadoEn = now;
    }
    if (estado === 'error') cambios.error = String(error || 'error').slice(0, 200);
    Object.assign(e, cambios);
    this.encolarCambios(e, cambios);
    // Final: ya no hace falta seguirlo en memoria.
    if (estado === 'leido') this.entregas.delete(id);
    return e;
  }

  /**
   * Revisión periódica: devuelve los mensajes a reenviar (sin entrega tras
   * `reintentoTrasMs`, o en error) y marca `sin_entregar` los que pasaron
   * `sinEntregarTrasMs`.
   */
  revisar(now = Date.now()): Entrega[] {
    const reenviar: Entrega[] = [];
    for (const e of this.entregas.values()) {
      const edad = now - e.enviadoEn;
      if (e.estado === 'entregado') {
        // Ya llegó; solo se esperaba el "leído". Se suelta tras el plazo.
        if (edad > this.sinEntregarTrasMs) this.entregas.delete(e.id);
        continue;
      }
      // Se conserva en memoria: si el recibo llega más tarde, pasa a entregado.
      if (e.estado === 'sin_entregar') continue;
      if (edad > this.sinEntregarTrasMs) {
        e.estado = 'sin_entregar';
        this.encolarCambios(e, { estado: 'sin_entregar' });
        continue;
      }
      const toca = e.estado === 'error' || edad > this.reintentoTrasMs * (e.reintentos + 1);
      if (toca && e.reintentos < this.maxReintentos) reenviar.push(e);
    }
    return reenviar;
  }

  marcarReintento(id: string): void {
    const e = this.entregas.get(id);
    if (!e) return;
    e.reintentos += 1;
    const cambios: Partial<Entrega> = { reintentos: e.reintentos };
    // Un reenvío tras un error vuelve a quedar "enviado" a la espera del recibo.
    if (e.estado === 'error') cambios.estado = e.estado = 'enviado';
    this.encolarCambios(e, cambios);
  }

  /**
   * Tras un reinicio: recarga los envíos de hoy y ayer que aún no se
   * confirmaron, para seguir aplicando sus recibos y reintentos.
   */
  async cargarRecientes(now = Date.now()): Promise<number> {
    if (!this.firebase.isEnabled()) return 0;
    let n = 0;
    for (const fecha of [fechaBucket(now), fechaBucket(now - DIA_MS)]) {
      try {
        const snap = await this.firebase.db().ref(`${ENTREGA_ROOT}/${fecha}`).get();
        if (!snap.exists()) continue;
        const val = snap.val() || {};
        for (const [id, raw] of Object.entries<any>(val)) {
          if (!raw || this.entregas.has(id)) continue;
          if (raw.estado === 'leido') continue;
          this.guardarEntregaEnMemoria({
            id,
            sesion: String(raw.sesion || ''),
            conjunto: String(raw.conjunto || ''),
            to: String(raw.to || ''),
            tipo: raw.tipo === 'imagen' ? 'imagen' : 'texto',
            estado: raw.estado,
            enviadoEn: Number(raw.enviadoEn) || now,
            entregadoEn: raw.entregadoEn ? Number(raw.entregadoEn) : undefined,
            reintentos: Number(raw.reintentos) || 0,
            fecha,
          });
          n++;
        }
      } catch (e: any) {
        this.logger.warn(`No se pudieron recargar las entregas de ${fecha}: ${e?.message}`);
      }
    }
    return n;
  }

  /** Entregas de un día (para la consulta del admin), opcionalmente por conjunto. */
  async listar(fecha: string, conjunto?: string | null): Promise<Entrega[]> {
    if (!this.firebase.isEnabled() || !/^\d{8}$/.test(fecha)) return [];
    const snap = await this.firebase.db().ref(`${ENTREGA_ROOT}/${fecha}`).get();
    if (!snap.exists()) return [];
    const filtro = conjunto ? String(conjunto).trim().toLowerCase() : null;
    const out: Entrega[] = [];
    for (const [id, raw] of Object.entries<any>(snap.val() || {})) {
      if (!raw) continue;
      if (filtro && String(raw.conjunto || '').toLowerCase() !== filtro) continue;
      out.push({ ...raw, id, fecha });
    }
    out.sort((a, b) => (b.enviadoEn || 0) - (a.enviadoEn || 0));
    return out;
  }

  /** Borra los días que pasaron el TTL (sin leer nada: rutas por fecha). */
  async limpiarViejos(now = Date.now()): Promise<void> {
    if (!this.firebase.isEnabled()) return;
    const updates: Record<string, null> = {};
    for (let d = this.ttlDays; d < this.ttlDays + 14; d++) {
      const fecha = fechaBucket(now - d * DIA_MS);
      updates[`${MSG_STORE_ROOT}/${fecha}`] = null;
      updates[`${ENTREGA_ROOT}/${fecha}`] = null;
    }
    try {
      await this.firebase.db().ref().update(updates);
    } catch (e: any) {
      this.logger.warn(`No se pudieron borrar los mensajes viejos: ${e?.message}`);
    }
    const cutoff = now - this.ttlDays * DIA_MS;
    for (const [k, v] of this.mem.entries()) if (v.ts < cutoff) this.mem.delete(k);
  }

  // ------------------------------------------------------------ escrituras

  /** Escribe ya lo acumulado (también se llama al apagar el proceso). */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const lote = this.pendiente;
    this.pendiente = {};
    if (!Object.keys(lote).length || !this.firebase.isEnabled()) return;
    try {
      await this.firebase.db().ref().update(lote);
    } catch (e: any) {
      this.logger.warn(`No se pudo guardar el lote de WhatsApp (${Object.keys(lote).length} rutas): ${e?.message}`);
      // Un reintento en el próximo lote, sin crecer sin límite.
      if (Object.keys(this.pendiente).length < 2000) this.pendiente = { ...lote, ...this.pendiente };
    }
  }

  private encolar(path: string, value: any): void {
    this.pendiente[path] = value;
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.flush().catch(() => undefined);
      }, this.flushMs);
      this.timer.unref?.();
    }
  }

  private encolarCambios(e: Entrega, cambios: Partial<Entrega>): void {
    for (const [k, v] of Object.entries(cambios)) {
      if (v === undefined) continue;
      this.encolar(`${ENTREGA_ROOT}/${e.fecha}/${e.id}/${k}`, v);
    }
  }

  private guardarEntregaEnMemoria(e: Entrega): void {
    this.entregas.set(e.id, e);
    while (this.entregas.size > MEM_MAX) {
      const oldest = this.entregas.keys().next().value;
      if (oldest === undefined) break;
      this.entregas.delete(oldest);
    }
  }

  private paraRtdb(e: Entrega): Record<string, any> {
    const { id: _id, fecha: _f, ...resto } = e;
    return Object.fromEntries(Object.entries(resto).filter(([, v]) => v !== undefined));
  }
}
