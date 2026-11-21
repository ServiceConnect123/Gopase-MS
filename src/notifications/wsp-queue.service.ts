import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID } from 'crypto';
import { FirebaseService } from '../firebase/firebase.service';
import { SendResult, WhatsappService } from '../whatsapp/whatsapp.service';

/** Estado de cada destinatario de un envío masivo. */
export type ItemEstado =
  | 'pendiente'
  | 'enviando'
  | 'enviado'
  | 'fallido'
  | 'sin_whatsapp'
  | 'numero_invalido'
  /** Se cortó el proceso justo mientras se enviaba: puede o no haber llegado. No se reenvía. */
  | 'incierto';

export interface JobItem {
  nombre: string;
  telefono: string;
  texto: string;
  estado: ItemEstado;
  error?: string;
  at?: string;
  /** Id del mensaje en WhatsApp: su entrega se consulta en `wsp_entrega`. */
  msgId?: string;
}

export type JobEstado = 'pendiente' | 'procesando' | 'completado' | 'expirado';

export interface WspJob {
  id: string;
  tipo: 'recordatorio' | 'noticia';
  conjunto: string;
  creadoPor: string;
  creadoEn: number;
  firma: string;
  imageUrl?: string;
  estado: JobEstado;
  intentosConexion: number;
  total: number;
  enviados: number;
  fallidos: number;
  terminadoEn?: string;
  items: JobItem[];
}

/** Nodos RTDB de la cola. */
const COLA = 'wsp_cola';
const ACTIVOS = 'wsp_cola_activos';
const FIRMAS = 'wsp_cola_firmas';

/** Ventana en la que un envío idéntico se considera duplicado (doble clic). */
const DEDUPE_MS = 10 * 60_000;
/** Si WhatsApp no conecta, se reintenta cada minuto hasta este número de veces. */
const MAX_INTENTOS_CONEXION = 30;

/**
 * Cola PERSISTIDA de envíos masivos (recordatorios de cobro, invitaciones y
 * noticias).
 *
 * Antes el envío vivía solo en memoria: un deploy o reinicio de Render a mitad
 * de un lote perdía el resto sin dejar rastro, un doble clic duplicaba todos
 * los mensajes y no había forma de saber a quién le llegó.
 *
 * Ahora:
 *   - Cada lote se guarda en RTDB (`wsp_cola/<id>`) con el estado de cada
 *     destinatario, y se reanuda al reiniciar el proceso.
 *   - Un lote idéntico (mismo conjunto, textos y teléfonos) dentro de 10 min se
 *     deduplica y devuelve el lote existente.
 *   - Se procesa un lote a la vez POR CONJUNTO (cada conjunto usa su número);
 *     conjuntos distintos avanzan en paralelo.
 *   - Si WhatsApp no está listo, el lote espera y reintenta (hasta ~30 min) en
 *     lugar de marcar todo como fallido.
 *   - Pausa con jitter entre mensajes (patrón menos detectable por WhatsApp).
 */
@Injectable()
export class WspQueueService implements OnApplicationBootstrap {
  private readonly logger = new Logger(WspQueueService.name);
  /** Lotes pendientes por conjunto (clave en minúsculas), en orden de llegada. */
  private readonly colas = new Map<string, string[]>();
  /** Conjuntos con un procesador corriendo. */
  private readonly corriendo = new Set<string>();

  constructor(
    private readonly firebase: FirebaseService,
    private readonly whatsapp: WhatsappService,
    private readonly config: ConfigService,
  ) {}

  /** Reanuda los lotes que quedaron activos antes del último reinicio. */
  async onApplicationBootstrap(): Promise<void> {
    if (!this.firebase.isEnabled()) return;
    // Margen para que las sesiones de WhatsApp empiecen a reconectar.
    setTimeout(() => {
      this.reanudar().catch((e) => this.logger.error(`No se pudo reanudar la cola: ${e?.message}`));
      this.limpiar().catch((e) => this.logger.warn(`Limpieza de la cola falló: ${e?.message}`));
    }, 10_000);
  }

  private async reanudar(): Promise<void> {
    const snap = await this.firebase.db().ref(ACTIVOS).get();
    if (!snap.exists()) return;
    const activos = Object.entries<any>(snap.val() || {})
      .map(([id, v]) => ({ id, conjunto: String(v?.conjunto ?? ''), creadoEn: Number(v?.creadoEn ?? 0) }))
      .sort((a, b) => a.creadoEn - b.creadoEn);
    for (const a of activos) this.encolar(a.conjunto, a.id);
    if (activos.length) this.logger.log(`Cola: ${activos.length} lotes reanudados tras el reinicio.`);
  }

  /**
   * Retención: borra firmas de deduplicación de más de 1 día y lotes terminados
   * de más de 30 días (contienen teléfonos y textos). Corre al arrancar.
   * Para que la consulta por `creadoEn` no descargue todo el nodo, conviene
   * declarar `".indexOn": ["creadoEn"]` en las reglas de `wsp_cola`.
   */
  private async limpiar(): Promise<void> {
    const db = this.firebase.db();
    const updates: Record<string, null> = {};
    const firmas = await db.ref(FIRMAS).get();
    for (const [k, v] of Object.entries<any>(firmas.val() || {})) {
      if (Date.now() - Number(v?.at || 0) > 24 * 3600_000) updates[`${FIRMAS}/${k}`] = null;
    }
    const viejos = await db
      .ref(COLA)
      .orderByChild('creadoEn')
      .endAt(Date.now() - 30 * 24 * 3600_000)
      .limitToFirst(200)
      .get();
    for (const [k, v] of Object.entries<any>(viejos.val() || {})) {
      if (v?.estado === 'completado' || v?.estado === 'expirado') updates[`${COLA}/${k}`] = null;
    }
    const n = Object.keys(updates).length;
    if (n) {
      await db.ref().update(updates);
      this.logger.log(`Cola: limpieza de ${n} registros antiguos.`);
    }
  }

  private key(conjunto: string): string {
    return String(conjunto ?? '').trim().toLowerCase();
  }

  private encolar(conjunto: string, id: string): void {
    const k = this.key(conjunto);
    const cola = this.colas.get(k) || [];
    if (!cola.includes(id)) cola.push(id);
    this.colas.set(k, cola);
    this.procesar(k);
  }

  /**
   * Clave de un teléfono para deduplicar: últimos 10 dígitos (así
   * "3001234567" y "+57 300 123 4567" cuentan como el mismo destinatario).
   */
  private digitos(tel: string): string {
    return String(tel ?? '').replace(/\D/g, '').slice(-10);
  }

  /**
   * Crea un lote. Los textos llegan ya personalizados por destinatario.
   * Devuelve el id del lote (o el del lote existente si es un duplicado).
   */
  async crear(input: {
    tipo: WspJob['tipo'];
    conjunto: string;
    creadoPor: string;
    imageUrl?: string;
    destinatarios: Array<{ nombre: string; telefono: string; texto: string }>;
  }): Promise<{ id: string; total: number; duplicado: boolean }> {
    // Un mismo teléfono solo recibe una vez por lote.
    const vistos = new Set<string>();
    const items: JobItem[] = [];
    for (const d of input.destinatarios) {
      const dig = this.digitos(d.telefono);
      if (!dig || vistos.has(dig)) continue;
      vistos.add(dig);
      items.push({ nombre: d.nombre || '', telefono: String(d.telefono), texto: d.texto, estado: 'pendiente' });
    }

    const firma = createHash('sha256')
      .update(
        JSON.stringify([
          input.tipo,
          this.key(input.conjunto),
          input.imageUrl || '',
          items.map((i) => `${this.digitos(i.telefono)}:${i.texto}`).sort(),
        ]),
      )
      .digest('hex')
      .slice(0, 40);

    const db = this.firebase.db();
    const firmaSnap = await db.ref(`${FIRMAS}/${firma}`).get();
    const previo = firmaSnap.exists() ? firmaSnap.val() : null;
    if (previo && Date.now() - Number(previo.at || 0) < DEDUPE_MS) {
      this.logger.warn(`Cola: lote duplicado ignorado (igual a ${previo.id}).`);
      return { id: String(previo.id), total: items.length, duplicado: true };
    }

    const id = `${Date.now()}_${randomUUID().slice(0, 8)}`;
    const job: WspJob = {
      id,
      tipo: input.tipo,
      conjunto: input.conjunto || '',
      creadoPor: input.creadoPor || '',
      creadoEn: Date.now(),
      firma,
      ...(input.imageUrl ? { imageUrl: input.imageUrl } : {}),
      estado: 'pendiente',
      intentosConexion: 0,
      total: items.length,
      enviados: 0,
      fallidos: 0,
      items,
    };
    await db.ref().update({
      [`${COLA}/${id}`]: job,
      [`${ACTIVOS}/${id}`]: { conjunto: job.conjunto, creadoEn: job.creadoEn },
      [`${FIRMAS}/${firma}`]: { id, at: job.creadoEn },
    });
    this.encolar(job.conjunto, id);
    return { id, total: items.length, duplicado: false };
  }

  /** Lote por id (para consultar el avance). */
  async obtener(id: string): Promise<WspJob | null> {
    const safe = String(id ?? '').replace(/[.#$/\[\]]/g, '_');
    if (!safe) return null;
    const snap = await this.firebase.db().ref(`${COLA}/${safe}`).get();
    if (!snap.exists()) return null;
    const job = snap.val() as WspJob;
    job.items = this.itemsArray(job.items);
    return job;
  }

  private itemsArray(items: any): JobItem[] {
    return Array.isArray(items) ? items : Object.values(items || {});
  }

  /** Procesador de un conjunto: toma sus lotes de a uno, en orden. */
  private procesar(k: string): void {
    if (this.corriendo.has(k)) return;
    this.corriendo.add(k);
    (async () => {
      try {
        for (;;) {
          const cola = this.colas.get(k) || [];
          const id = cola[0];
          if (!id) break;
          const resultado = await this.procesarLote(id).catch((e) => {
            this.logger.error(`Cola: error procesando ${id}: ${e?.message}`);
            return 'reintentar' as const;
          });
          if (resultado === 'reintentar') {
            // WhatsApp no estaba listo: se reintenta en 1 min sin bloquear otros conjuntos.
            setTimeout(() => this.procesar(k), 60_000);
            return;
          }
          cola.shift();
        }
      } finally {
        this.corriendo.delete(k);
      }
    })();
  }

  private sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
  }

  /** Pausa entre mensajes: base configurable + jitter aleatorio de hasta 75%. */
  private pausa(): number {
    const base = Number(this.config.get<string>('WHATSAPP_MESSAGE_DELAY_MS', '4000')) || 4000;
    return base + Math.floor(Math.random() * base * 0.75);
  }

  /** Espera hasta ~maxMs a que la sesión del conjunto (o la global) esté lista. */
  private async esperarWhatsapp(conjunto: string, maxMs = 60_000): Promise<boolean> {
    const listo = () => this.whatsapp.isReady(conjunto) || this.whatsapp.isReady();
    for (let t = 0; !listo() && t < maxMs; t += 3000) await this.sleep(3000);
    return listo();
  }

  /**
   * Procesa un lote. Devuelve 'listo' (terminado o expirado) o 'reintentar'
   * (WhatsApp no disponible por ahora).
   */
  private async procesarLote(id: string): Promise<'listo' | 'reintentar'> {
    const db = this.firebase.db();
    const ref = db.ref(`${COLA}/${id}`);
    const snap = await ref.get();
    if (!snap.exists()) {
      await db.ref(`${ACTIVOS}/${id}`).remove();
      return 'listo';
    }
    const job = snap.val() as WspJob;
    const items = this.itemsArray(job.items);
    if (job.estado === 'completado' || job.estado === 'expirado') {
      await db.ref(`${ACTIVOS}/${id}`).remove();
      return 'listo';
    }

    // Un item que quedó "enviando" es porque el proceso murió en pleno envío:
    // pudo haber llegado. No se reenvía (evita duplicados al destinatario).
    for (let i = 0; i < items.length; i++) {
      if (items[i].estado === 'enviando') {
        items[i].estado = 'incierto';
        await ref.child(`items/${i}`).update({ estado: 'incierto', at: new Date().toISOString() });
      }
    }

    if (!(await this.esperarWhatsapp(job.conjunto))) {
      const intentos = (job.intentosConexion || 0) + 1;
      if (intentos >= MAX_INTENTOS_CONEXION) {
        this.logger.error(`Cola: lote ${id} expiró esperando WhatsApp (${intentos} intentos).`);
        await this.cerrar(id, items, 'expirado', 'WhatsApp no conectado');
        return 'listo';
      }
      await ref.update({ intentosConexion: intentos });
      this.logger.warn(`Cola: lote ${id} espera WhatsApp (intento ${intentos}/${MAX_INTENTOS_CONEXION}).`);
      return 'reintentar';
    }

    await ref.update({ estado: 'procesando' });
    let primero = true;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.estado !== 'pendiente') continue;
      if (!primero) await this.sleep(this.pausa());
      primero = false;

      await ref.child(`items/${i}`).update({ estado: 'enviando' });
      const r: SendResult = job.imageUrl
        ? await this.whatsapp.sendImageDetailed(it.telefono, { imageUrl: job.imageUrl, caption: it.texto }, job.conjunto)
        : await this.whatsapp.sendMessageDetailed(it.telefono, it.texto, job.conjunto);

      if (!r.ok && r.reason === 'sin_sesion') {
        // Se cayó la sesión a mitad del lote: devolver el item a pendiente y reintentar luego.
        await ref.child(`items/${i}`).update({ estado: 'pendiente' });
        return 'reintentar';
      }
      const estado: ItemEstado = r.ok
        ? 'enviado'
        : r.reason === 'sin_whatsapp'
          ? 'sin_whatsapp'
          : r.reason === 'numero_invalido'
            ? 'numero_invalido'
            : 'fallido';
      it.estado = estado;
      await ref.child(`items/${i}`).update({
        estado,
        at: new Date().toISOString(),
        ...(r.error ? { error: String(r.error).slice(0, 200) } : {}),
        ...(r.messageId ? { msgId: r.messageId } : {}),
      });
    }

    await this.cerrar(id, items, 'completado');
    return 'listo';
  }

  /** Cierra el lote: marca pendientes como fallidos (si expiró), totaliza y lo saca de activos. */
  private async cerrar(id: string, items: JobItem[], estado: JobEstado, motivo?: string): Promise<void> {
    const db = this.firebase.db();
    const updates: Record<string, any> = {};
    if (motivo) {
      items.forEach((it, i) => {
        if (it.estado === 'pendiente') {
          it.estado = 'fallido';
          updates[`${COLA}/${id}/items/${i}/estado`] = 'fallido';
          updates[`${COLA}/${id}/items/${i}/error`] = motivo;
        }
      });
    }
    const enviados = items.filter((i) => i.estado === 'enviado').length;
    const fallidos = items.length - enviados;
    updates[`${COLA}/${id}/estado`] = estado;
    updates[`${COLA}/${id}/enviados`] = enviados;
    updates[`${COLA}/${id}/fallidos`] = fallidos;
    updates[`${COLA}/${id}/terminadoEn`] = new Date().toISOString();
    updates[`${ACTIVOS}/${id}`] = null;
    await db.ref().update(updates);
    this.logger.log(`Cola: lote ${id} ${estado}: ${enviados}/${items.length} enviados.`);
  }
}
