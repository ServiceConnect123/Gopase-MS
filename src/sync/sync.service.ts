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
      id: row.dato_1 ?? '',
      nombre: row.dato_2 ?? '',
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
      id: row.dato_1 ?? '',
      usuario: row.dato_2 ?? '',
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
      id: row.dato_1 ?? '',
      usuario: row.dato_1 ?? '',
      email: row.dato_2 ?? '',
      // password (dato_3) NO se copia al espejo.
      nombre: row.dato_4 ?? '',
      rol: row.dato_5 ?? '',
      docType: row.dato_6 ?? '',
      docNum: row.dato_7 ?? '',
      phone: row.dato_8 ?? '',
      conjunto: row.dato_9 ?? '',
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

  /** Sincroniza las tres colecciones. No lanza: devuelve resultado por colección. */
  async syncAll(): Promise<{ success: boolean; results: SyncResult[] }> {
    const results: SyncResult[] = [];
    for (const fn of [
      () => this.syncConjuntos(),
      () => this.syncPagos(),
      () => this.syncUsuarios(),
    ]) {
      results.push(await fn());
    }
    return { success: results.every((r) => r.success), results };
  }
}
