import { Injectable, Logger } from '@nestjs/common';
import { SheetsService } from '../sheets/sheets.service';
import { FirebaseService } from '../firebase/firebase.service';

/**
 * Sincronización unidireccional Google Sheets -> Realtime Database.
 *
 * Google Sheets sigue siendo la fuente de verdad; este servicio LEE de Sheets
 * y ESPEJA los datos en el RTDB bajo el namespace `mirror/`. Sirve para migrar
 * paulatinamente sin cambiar el comportamiento actual de la app.
 *
 * Cubre por ahora: conjuntos (propiedades), pagos y usuarios.
 *
 * - Unidireccional: nunca escribe en Sheets.
 * - Idempotente: reescribe la colección completa en cada corrida.
 * - No lanza si falta Firebase: registra y devuelve un resultado.
 */
export type SyncCollection = 'conjuntos' | 'pagos' | 'usuarios';

export interface SyncResult {
  collection: SyncCollection;
  success: boolean;
  count: number;
  message?: string;
}

const MIRROR_ROOT = 'mirror';

@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);

  constructor(
    private readonly sheets: SheetsService,
    private readonly firebase: FirebaseService,
  ) {}

  /** Sanea una clave para usarla como key de nodo en RTDB. */
  private safeKey(raw: unknown, fallbackIndex: number): string {
    const s = (raw == null ? '' : String(raw)).trim();
    if (!s) return `row_${fallbackIndex}`;
    return s.replace(/[.#$/\[\]]/g, '_');
  }

  private toKeyed<T extends { id?: string }>(items: T[]): Record<string, T> {
    const out: Record<string, T> = {};
    items.forEach((item, i) => {
      out[this.safeKey(item.id, i)] = item;
    });
    return out;
  }

  // -------------------- Mapeos dato_n -> objeto --------------------

  // propiedades (Hoja 5): dato_1=id, dato_2=nombre, dato_3=direccion, dato_4=tipo,
  // dato_5=descripcion, dato_6=mercadoPagoKey, dato_7=cuotaMonto, dato_8=moneda,
  // dato_9=llaveBreB, dato_10=geminiKey, dato_11=driveFolderId, ...
  // Se omiten claves sensibles (mercadoPagoKey, geminiKey, llaveBreB) del espejo.
  private mapConjunto(row: any) {
    return {
      id: String(row.dato_1 ?? ''),
      nombre: String(row.dato_2 ?? ''),
      direccion: row.dato_3 ?? '',
      tipo: row.dato_4 ?? '',
      descripcion: row.dato_5 ?? '',
      cuotaMonto: row.dato_7 ?? '',
      moneda: row.dato_8 ?? 'COP',
      driveFolderId: row.dato_11 ?? '',
    };
  }

  // pagos (Hoja 2): dato_1=id, dato_2=usuario, dato_3=concepto, dato_4=valor,
  // dato_5=fecha, dato_6=estado, dato_7=referencia
  private mapPago(row: any) {
    return {
      id: String(row.dato_1 ?? ''),
      usuario: String(row.dato_2 ?? ''),
      concepto: row.dato_3 ?? '',
      valor: row.dato_4 ?? '',
      fecha: row.dato_5 ?? '',
      estado: row.dato_6 ?? '',
      referencia: row.dato_7 ?? '',
    };
  }

  // usuarios (Hoja 1): dato_1=usuario, dato_2=email, dato_3=password(omitida),
  // dato_4=nombre, dato_5=rol, dato_6=docType, dato_7=docNum, dato_8=phone, dato_9=conjunto
  private mapUsuario(row: any) {
    return {
      id: String(row.dato_1 ?? ''),
      usuario: String(row.dato_1 ?? ''),
      email: row.dato_2 ?? '',
      // password (dato_3) NO se copia al espejo.
      nombre: row.dato_4 ?? '',
      rol: row.dato_5 ?? '',
      docType: row.dato_6 ?? '',
      docNum: row.dato_7 ?? '',
      phone: row.dato_8 ?? '',
      // Valor crudo del conjunto en Sheets (puede ser id o nombre).
      conjunto: String(row.dato_9 ?? ''),
    };
  }

  /**
   * Índice para resolver el conjunto de un usuario a su id, sin importar si en
   * Sheets se guardó por id o por nombre. Mapea id->id y nombre(normalizado)->id.
   */
  private buildConjuntoIndex(conjuntos: Array<{ id: unknown; nombre?: unknown }>) {
    const byKey = new Map<string, string>();
    // Fuerza a string antes de normalizar: los valores de Sheets pueden venir
    // como number (ej. un id numérico) y number.trim() no existe.
    const norm = (s: unknown) => String(s ?? '').trim().toLowerCase();
    for (const c of conjuntos) {
      const id = String(c.id ?? '');
      if (id) byKey.set(norm(id), id);
      if (c.nombre != null && String(c.nombre) !== '') byKey.set(norm(c.nombre), id);
    }
    return {
      resolve(raw: unknown): string {
        return byKey.get(norm(raw)) ?? '';
      },
    };
  }

  // -------------------- Escritura del espejo --------------------

  private async writeMirror<T extends { id?: string }>(
    collection: SyncCollection,
    items: T[],
  ): Promise<SyncResult> {
    if (!this.firebase.isEnabled()) {
      const message = 'Firebase no está habilitado (revisa las env de Firebase).';
      this.logger.warn(`[sync] ${collection}: ${message}`);
      return { collection, success: false, count: 0, message };
    }
    try {
      const db = this.firebase.db();
      await db.ref(`${MIRROR_ROOT}/${collection}`).set(this.toKeyed(items));
      await db.ref(`${MIRROR_ROOT}/_meta/${collection}`).set({
        count: items.length,
        syncedAt: Date.now(),
      });
      this.logger.log(`[sync] ${collection}: ${items.length} registros espejados.`);
      return { collection, success: true, count: items.length };
    } catch (err: any) {
      this.logger.error(`[sync] ${collection} falló: ${err?.message || err}`);
      return { collection, success: false, count: 0, message: err?.message || 'Error al escribir en RTDB' };
    }
  }

  // -------------------- API pública --------------------

  async syncConjuntos(): Promise<SyncResult> {
    const rows = await this.sheets.read('propiedades');
    return this.writeMirror('conjuntos', rows.map((r) => this.mapConjunto(r)));
  }

  async syncPagos(): Promise<SyncResult> {
    const rows = await this.sheets.read('pagos');
    return this.writeMirror('pagos', rows.map((r) => this.mapPago(r)));
  }

  async syncUsuarios(): Promise<SyncResult> {
    const rows = await this.sheets.read('usuarios');
    return this.writeMirror('usuarios', rows.map((r) => this.mapUsuario(r)));
  }

  /**
   * Sincroniza las tres colecciones RESOLVIENDO las relaciones entre ellas:
   *  - a cada usuario le agrega `conjuntoId` (resuelto desde su conjunto en Sheets).
   *  - a cada pago le agrega `usuarioId` y `conjuntoId` (vía su usuario).
   *  - además escribe un árbol anidado en `mirror/tree`:
   *      conjuntoId -> { ...conjunto, usuarios: { userId -> { ...usuario, pagos: { pagoId -> pago } } } }
   *
   * Lee las tres hojas juntas porque las referencias cruzadas lo requieren.
   * No lanza: devuelve el resultado por colección.
   */
  async syncAll(): Promise<{ success: boolean; results: SyncResult[] }> {
    if (!this.firebase.isEnabled()) {
      const message = 'Firebase no está habilitado (revisa las env de Firebase).';
      this.logger.warn(`[sync] syncAll: ${message}`);
      return {
        success: false,
        results: (['conjuntos', 'pagos', 'usuarios'] as SyncCollection[]).map((c) => ({
          collection: c,
          success: false,
          count: 0,
          message,
        })),
      };
    }

    try {
      // 1. Leer las tres hojas.
      const [conjRows, pagoRows, userRows] = await Promise.all([
        this.sheets.read('propiedades'),
        this.sheets.read('pagos'),
        this.sheets.read('usuarios'),
      ]);

      const conjuntos = conjRows.map((r) => this.mapConjunto(r));
      const pagos = pagoRows.map((r) => this.mapPago(r));
      const usuarios = userRows.map((r) => this.mapUsuario(r));

      // 2. Índices de resolución.
      const conjIndex = this.buildConjuntoIndex(conjuntos);

      // 3. Enriquecer usuarios con conjuntoId.
      const usuariosEnriched = usuarios.map((u) => ({
        ...u,
        conjuntoId: conjIndex.resolve(u.conjunto),
      }));

      // usuarioId -> conjuntoId (para resolver el conjunto de cada pago).
      const userToConjunto = new Map<string, string>();
      usuariosEnriched.forEach((u) => userToConjunto.set(u.id, u.conjuntoId));

      // 4. Enriquecer pagos con usuarioId y conjuntoId.
      const pagosEnriched = pagos.map((p) => ({
        ...p,
        usuarioId: p.usuario,
        conjuntoId: userToConjunto.get(p.usuario) ?? '',
      }));

      // 5. Escribir colecciones planas (enriquecidas).
      const results: SyncResult[] = [];
      results.push(await this.writeMirror('conjuntos', conjuntos));
      results.push(await this.writeMirror('pagos', pagosEnriched));
      results.push(await this.writeMirror('usuarios', usuariosEnriched));

      // 6. Construir y escribir el árbol anidado conjunto -> usuarios -> pagos.
      await this.writeTree(conjuntos, usuariosEnriched, pagosEnriched);

      return { success: results.every((r) => r.success), results };
    } catch (err: any) {
      this.logger.error(`[sync] syncAll falló: ${err?.message || err}`);
      return {
        success: false,
        results: (['conjuntos', 'pagos', 'usuarios'] as SyncCollection[]).map((c) => ({
          collection: c,
          success: false,
          count: 0,
          message: err?.message || 'Error en syncAll',
        })),
      };
    }
  }

  /**
   * Escribe el árbol relacional en `mirror/tree`:
   *   conjuntoId -> { ...conjunto, usuarios: { userId -> { ...usuario, pagos: { pagoId -> pago } } } }
   * Los usuarios/pagos sin conjunto resuelto quedan bajo la clave "_sin_conjunto".
   */
  private async writeTree(
    conjuntos: Array<{ id: string; nombre?: string }>,
    usuarios: Array<{ id: string; conjuntoId: string } & Record<string, any>>,
    pagos: Array<{ id: string; usuarioId: string } & Record<string, any>>,
  ): Promise<void> {
    const UNASSIGNED = '_sin_conjunto';

    // Agrupar pagos por usuarioId.
    const pagosPorUsuario = new Map<string, Record<string, any>>();
    pagos.forEach((p, i) => {
      const uid = this.safeKey(p.usuarioId, i);
      if (!pagosPorUsuario.has(uid)) pagosPorUsuario.set(uid, {});
      pagosPorUsuario.get(uid)![this.safeKey(p.id, i)] = p;
    });

    // Base del árbol: cada conjunto con su nodo de usuarios vacío.
    const tree: Record<string, any> = {};
    conjuntos.forEach((c, i) => {
      tree[this.safeKey(c.id, i)] = { ...c, usuarios: {} };
    });
    // Bucket para usuarios sin conjunto resuelto.
    tree[UNASSIGNED] = { id: UNASSIGNED, nombre: 'Sin conjunto', usuarios: {} };

    // Colocar cada usuario (con sus pagos) bajo su conjunto.
    usuarios.forEach((u, i) => {
      const cid = u.conjuntoId ? this.safeKey(u.conjuntoId, i) : UNASSIGNED;
      const bucket = tree[cid] ?? tree[UNASSIGNED];
      const uid = this.safeKey(u.id, i);
      bucket.usuarios[uid] = {
        ...u,
        pagos: pagosPorUsuario.get(uid) ?? {},
      };
    });

    // No dejar el bucket "_sin_conjunto" si quedó vacío.
    if (Object.keys(tree[UNASSIGNED].usuarios).length === 0) {
      delete tree[UNASSIGNED];
    }

    const db = this.firebase.db();
    await db.ref(`${MIRROR_ROOT}/tree`).set(tree);
    this.logger.log('[sync] tree: árbol conjunto->usuarios->pagos escrito.');
  }
}
