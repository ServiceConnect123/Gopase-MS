import { Injectable, Logger } from '@nestjs/common';
import { FirebaseService } from '../firebase/firebase.service';
import { SheetsService } from '../sheets/sheets.service';

/**
 * CRUD de propiedades (conjuntos) contra Firebase (RTDB mirror/conjuntos) y
 * lectura de las CLAVES SENSIBLES desde Sheets para uso interno del backend.
 *
 * Las claves sensibles (mercadoPagoKey, geminiKey) NO se exponen al cliente:
 * - El listado GET /properties devuelve datos no sensibles + flags booleanos
 *   (hasMercadoPago/hasBreB) + llaveBreB (que es visible por diseño: el usuario
 *   la necesita para transferir).
 * - Las operaciones que requieren las claves (OCR con Gemini, preferencia de
 *   Mercado Pago) se resuelven en el backend leyendo la clave de Sheets.
 *
 * Mapeo de propiedades (Hoja 5 / 'propiedades'):
 *   dato_1=id, dato_2=nombre, dato_3=direccion, dato_4=tipo, dato_5=descripcion,
 *   dato_6=mercadoPagoKey, dato_7=cuotaMonto, dato_8=moneda, dato_9=llaveBreB,
 *   dato_10=geminiKey, dato_11=driveFolderId
 */
export interface PropertyPublic {
  id: string;
  nombre: string;
  direccion?: string;
  tipo?: string;
  descripcion?: string;
  cuotaMonto?: string;
  moneda?: string;
  driveFolderId?: string;
  llaveBreB?: string; // visible por diseño (para transferir)
  hasMercadoPago: boolean;
  hasBreB: boolean;
  hasGemini: boolean;
}

export interface PropertySecrets {
  id: string;
  nombre: string;
  mercadoPagoKey: string;
  geminiKey: string;
  llaveBreB: string;
  cuotaMonto: string;
  driveFolderId: string;
}

const MIRROR_CONJUNTOS = 'mirror/conjuntos';

@Injectable()
export class PropertiesService {
  private readonly logger = new Logger(PropertiesService.name);

  constructor(
    private readonly firebase: FirebaseService,
    private readonly sheets: SheetsService,
  ) {}

  private safeKey(raw: unknown): string {
    return String(raw ?? '').trim().replace(/[.#$/\[\]]/g, '_');
  }

  /** Mapea una fila de Sheets 'propiedades' a los secretos + datos completos. */
  private mapSheetRow(row: any): PropertySecrets & { direccion: string; tipo: string; descripcion: string; moneda: string } {
    return {
      id: String(row.dato_1 ?? ''),
      nombre: String(row.dato_2 ?? ''),
      direccion: row.dato_3 ?? '',
      tipo: row.dato_4 ?? '',
      descripcion: row.dato_5 ?? '',
      mercadoPagoKey: String(row.dato_6 ?? ''),
      cuotaMonto: String(row.dato_7 ?? ''),
      moneda: row.dato_8 ?? 'COP',
      llaveBreB: String(row.dato_9 ?? ''),
      geminiKey: String(row.dato_10 ?? ''),
      driveFolderId: String(row.dato_11 ?? ''),
    };
  }

  /**
   * Lista pública de propiedades. Combina el espejo RTDB (mirror/conjuntos, sin
   * claves) con los flags derivados de Sheets (si hay MP/Gemini configurados) y
   * la llaveBreB (visible). No expone mercadoPagoKey ni geminiKey.
   */
  async listPublic(): Promise<PropertyPublic[]> {
    if (!this.firebase.isEnabled()) throw new Error('Servicio no disponible.');

    // Base: espejo RTDB (datos no sensibles).
    const snap = await this.firebase.db().ref(MIRROR_CONJUNTOS).get();
    const mirror: Record<string, any> = snap.exists() ? snap.val() : {};

    // Secretos/flags desde Sheets (fuente de verdad de las claves).
    let sheetById = new Map<string, ReturnType<PropertiesService['mapSheetRow']>>();
    try {
      const rows = await this.sheets.read('propiedades');
      rows.forEach((r) => {
        const m = this.mapSheetRow(r);
        if (m.id) sheetById.set(m.id, m);
      });
    } catch (e: any) {
      this.logger.warn(`No se pudieron leer flags de Sheets: ${e?.message}`);
    }

    const out: PropertyPublic[] = Object.values(mirror).map((c: any) => {
      const s = sheetById.get(String(c.id));
      return {
        id: String(c.id ?? ''),
        nombre: c.nombre ?? '',
        direccion: c.direccion ?? '',
        tipo: c.tipo ?? '',
        descripcion: c.descripcion ?? '',
        cuotaMonto: c.cuotaMonto ?? s?.cuotaMonto ?? '',
        moneda: c.moneda ?? 'COP',
        driveFolderId: c.driveFolderId ?? s?.driveFolderId ?? '',
        llaveBreB: s?.llaveBreB ?? c.llaveBreB ?? '',
        hasMercadoPago: !!(s?.mercadoPagoKey),
        hasBreB: !!(s?.llaveBreB ?? c.llaveBreB),
        hasGemini: !!(s?.geminiKey),
      };
    });
    return out;
  }

  /** Resuelve los secretos de un conjunto por nombre (o id) desde Sheets. Uso interno. */
  async getSecretsByConjunto(conjunto: string): Promise<PropertySecrets | null> {
    const raw = String(conjunto || '').trim();
    if (!raw) return null;
    try {
      const rows = await this.sheets.read('propiedades');
      const norm = (s: unknown) => String(s ?? '').trim().toLowerCase();
      const found = rows
        .map((r) => this.mapSheetRow(r))
        .find((m) => norm(m.nombre) === norm(raw) || norm(m.id) === norm(raw));
      if (!found) return null;
      return {
        id: found.id,
        nombre: found.nombre,
        mercadoPagoKey: found.mercadoPagoKey,
        geminiKey: found.geminiKey,
        llaveBreB: found.llaveBreB,
        cuotaMonto: found.cuotaMonto,
        driveFolderId: found.driveFolderId,
      };
    } catch (e: any) {
      this.logger.warn(`getSecretsByConjunto(${raw}) falló: ${e?.message}`);
      return null;
    }
  }

  /** Crea una propiedad (datos no sensibles) en mirror/conjuntos. */
  async create(dto: any): Promise<{ success: boolean; message?: string; id?: string }> {
    if (!this.firebase.isEnabled()) return { success: false, message: 'Servicio no disponible.' };
    const id = String(dto.id || Date.now().toString());
    const key = this.safeKey(id);
    const record = {
      id,
      nombre: dto.nombre || '',
      direccion: dto.direccion || '',
      tipo: dto.tipo || '',
      descripcion: dto.descripcion || '',
      cuotaMonto: dto.cuotaMonto ?? '',
      moneda: dto.moneda || 'COP',
      driveFolderId: dto.driveFolderId || '',
      _fbWrite: true,
    };
    try {
      await this.firebase.db().ref(`${MIRROR_CONJUNTOS}/${key}`).set(record);
      return { success: true, id, message: 'Propiedad creada.' };
    } catch (err: any) {
      this.logger.error(`[properties] create falló: ${err?.message}`);
      return { success: false, message: err?.message || 'No se pudo crear la propiedad.' };
    }
  }

  /** Edita una propiedad (datos no sensibles) en mirror/conjuntos. */
  async update(id: string, dto: any): Promise<{ success: boolean; message?: string }> {
    if (!this.firebase.isEnabled()) return { success: false, message: 'Servicio no disponible.' };
    const key = this.safeKey(id);
    if (!key) return { success: false, message: 'ID requerido.' };
    const ref = this.firebase.db().ref(`${MIRROR_CONJUNTOS}/${key}`);
    const snap = await ref.get();
    if (!snap.exists()) return { success: false, message: 'La propiedad no existe.' };

    const patch: Record<string, any> = { _fbWrite: true };
    ['nombre', 'direccion', 'tipo', 'descripcion', 'cuotaMonto', 'moneda', 'driveFolderId'].forEach((f) => {
      if (dto[f] !== undefined) patch[f] = dto[f];
    });
    try {
      await ref.update(patch);
      return { success: true, message: 'Propiedad actualizada.' };
    } catch (err: any) {
      this.logger.error(`[properties] update ${key} falló: ${err?.message}`);
      return { success: false, message: err?.message || 'No se pudo actualizar la propiedad.' };
    }
  }

  /** Elimina una propiedad de mirror/conjuntos. */
  async remove(id: string): Promise<{ success: boolean; message?: string }> {
    if (!this.firebase.isEnabled()) return { success: false, message: 'Servicio no disponible.' };
    const key = this.safeKey(id);
    if (!key) return { success: false, message: 'ID requerido.' };
    try {
      await this.firebase.db().ref(`${MIRROR_CONJUNTOS}/${key}`).remove();
      return { success: true, message: 'Propiedad eliminada.' };
    } catch (err: any) {
      this.logger.error(`[properties] delete ${key} falló: ${err?.message}`);
      return { success: false, message: err?.message || 'No se pudo eliminar la propiedad.' };
    }
  }
}
