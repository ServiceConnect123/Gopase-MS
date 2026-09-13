import { Injectable, Logger } from '@nestjs/common';
import { FirebaseService } from '../firebase/firebase.service';
import { SheetsService } from '../sheets/sheets.service';

/**
 * CRUD de propiedades (conjuntos) contra Firebase (RTDB mirror/conjuntos).
 * Los datos ya no viven en Sheets: incluidos los secretos.
 *
 * Estructura en RTDB:
 *   mirror/conjuntos/{id}                -> datos no sensibles + llaveBreB (visible)
 *                                           + config de notificaciones (adminUsuario, etc.)
 *   mirror/conjuntos/{id}/_secrets       -> { mercadoPagoKey, geminiKey } (NO se exponen al cliente)
 *
 * - GET /properties (listPublic): datos no sensibles + llaveBreB + flags
 *   hasMercadoPago/hasBreB/hasGemini. Nunca las claves.
 * - OCR (Gemini) y Mercado Pago leen las claves con getSecretsByConjunto (RTDB).
 * - La edición de configuración (superAdmin) escribe todo vía updateConfig.
 *
 * La migración inicial de secretos desde Sheets se hace una sola vez con
 * migrateSecretsFromSheets().
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

// Campos no sensibles del conjunto (registro normal).
const BASIC_FIELDS = [
  'nombre', 'direccion', 'tipo', 'descripcion', 'cuotaMonto', 'moneda', 'driveFolderId',
  'llaveBreB', 'adminUsuario', 'adminNombre', 'adminWhatsapp', 'notifActivo',
] as const;

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

  /**
   * Lista pública de propiedades desde RTDB. Deriva los flags de la presencia de
   * las claves en el subnodo _secrets, pero NUNCA expone las claves.
   */
  async listPublic(): Promise<PropertyPublic[]> {
    if (!this.firebase.isEnabled()) throw new Error('Servicio no disponible.');
    const snap = await this.firebase.db().ref(MIRROR_CONJUNTOS).get();
    const mirror: Record<string, any> = snap.exists() ? snap.val() : {};

    return Object.values(mirror).map((c: any) => {
      const secrets = c._secrets || {};
      return {
        id: String(c.id ?? ''),
        nombre: c.nombre ?? '',
        direccion: c.direccion ?? '',
        tipo: c.tipo ?? '',
        descripcion: c.descripcion ?? '',
        cuotaMonto: c.cuotaMonto ?? '',
        moneda: c.moneda ?? 'COP',
        driveFolderId: c.driveFolderId ?? '',
        llaveBreB: c.llaveBreB ?? '',
        hasMercadoPago: !!secrets.mercadoPagoKey,
        hasBreB: !!c.llaveBreB,
        hasGemini: !!secrets.geminiKey,
      };
    });
  }

  /** Busca el nodo del conjunto por id o nombre. Devuelve {key, value} o null. */
  private async findConjunto(conjunto: string): Promise<{ key: string; value: any } | null> {
    const snap = await this.firebase.db().ref(MIRROR_CONJUNTOS).get();
    if (!snap.exists()) return null;
    const norm = (s: unknown) => String(s ?? '').trim().toLowerCase();
    const target = norm(conjunto);
    const all = snap.val() || {};
    for (const key of Object.keys(all)) {
      const v = all[key];
      if (norm(v.id) === target || norm(v.nombre) === target) return { key, value: v };
    }
    return null;
  }

  /**
   * Resuelve las claves sensibles de un conjunto (por id o nombre) desde RTDB.
   * Uso interno del backend (OCR, Mercado Pago). Nunca se expone al cliente.
   */
  async getSecretsByConjunto(conjunto: string): Promise<PropertySecrets | null> {
    const raw = String(conjunto || '').trim();
    if (!raw || !this.firebase.isEnabled()) return null;
    try {
      const found = await this.findConjunto(raw);
      if (!found) return null;
      const c = found.value;
      const s = c._secrets || {};
      return {
        id: String(c.id ?? ''),
        nombre: c.nombre ?? '',
        mercadoPagoKey: String(s.mercadoPagoKey ?? ''),
        geminiKey: String(s.geminiKey ?? ''),
        llaveBreB: String(c.llaveBreB ?? ''),
        cuotaMonto: String(c.cuotaMonto ?? ''),
        driveFolderId: String(c.driveFolderId ?? ''),
      };
    } catch (e: any) {
      this.logger.warn(`getSecretsByConjunto(${raw}) falló: ${e?.message}`);
      return null;
    }
  }

  /**
   * Configuración COMPLETA de un conjunto para la pantalla de edición
   * (superAdmin). Incluye las claves sensibles. Este endpoint es administrativo.
   */
  async getConfig(id: string): Promise<any | null> {
    if (!this.firebase.isEnabled()) return null;
    const key = this.safeKey(id);
    const snap = await this.firebase.db().ref(`${MIRROR_CONJUNTOS}/${key}`).get();
    if (!snap.exists()) return null;
    const c = snap.val();
    const s = c._secrets || {};
    const { _secrets, _fbWrite, ...rest } = c;
    return {
      ...rest,
      mercadoPagoKey: s.mercadoPagoKey ?? '',
      geminiKey: s.geminiKey ?? '',
    };
  }

  /** Crea una propiedad (datos no sensibles) en mirror/conjuntos. */
  async create(dto: any): Promise<{ success: boolean; message?: string; id?: string }> {
    if (!this.firebase.isEnabled()) return { success: false, message: 'Servicio no disponible.' };
    const id = String(dto.id || Date.now().toString());
    const key = this.safeKey(id);
    const record: Record<string, any> = { id, _fbWrite: true };
    BASIC_FIELDS.forEach((f) => {
      record[f] = dto[f] ?? (f === 'moneda' ? 'COP' : '');
    });
    try {
      await this.firebase.db().ref(`${MIRROR_CONJUNTOS}/${key}`).set(record);
      return { success: true, id, message: 'Propiedad creada.' };
    } catch (err: any) {
      this.logger.error(`[properties] create falló: ${err?.message}`);
      return { success: false, message: err?.message || 'No se pudo crear la propiedad.' };
    }
  }

  /** Edita datos no sensibles de una propiedad en mirror/conjuntos. */
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

  /**
   * Edita la CONFIGURACIÓN COMPLETA del conjunto (superAdmin): datos no sensibles
   * + llaveBreB + config de notificaciones en el registro, y mercadoPagoKey /
   * geminiKey en el subnodo _secrets. Todo en RTDB (ya no Sheets).
   */
  async updateConfig(id: string, dto: any): Promise<{ success: boolean; message?: string }> {
    if (!this.firebase.isEnabled()) return { success: false, message: 'Servicio no disponible.' };
    const key = this.safeKey(id);
    if (!key) return { success: false, message: 'ID requerido.' };
    const ref = this.firebase.db().ref(`${MIRROR_CONJUNTOS}/${key}`);
    const snap = await ref.get();
    if (!snap.exists()) return { success: false, message: 'La propiedad no existe.' };

    try {
      const patch: Record<string, any> = { _fbWrite: true };
      BASIC_FIELDS.forEach((f) => {
        if (dto[f] !== undefined) patch[f] = dto[f];
      });

      // Secretos: solo se tocan si vienen en el DTO (permite no reenviarlos).
      const prevSecrets = snap.val()._secrets || {};
      const secrets: Record<string, any> = { ...prevSecrets };
      if (dto.mercadoPagoKey !== undefined) secrets.mercadoPagoKey = String(dto.mercadoPagoKey);
      if (dto.geminiKey !== undefined) secrets.geminiKey = String(dto.geminiKey);
      patch._secrets = secrets;

      await ref.update(patch);
      return { success: true, message: 'Configuración actualizada.' };
    } catch (err: any) {
      this.logger.error(`[properties] updateConfig ${key} falló: ${err?.message}`);
      return { success: false, message: err?.message || 'No se pudo actualizar la configuración.' };
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

  /**
   * Migración one-time: lee los secretos y la config de notificaciones desde la
   * hoja 'propiedades' de Sheets y los escribe en RTDB (registro + _secrets).
   * Idempotente: se puede ejecutar varias veces. Solo escribe lo que encuentra.
   *
   * Mapeo Sheets: dato_1=id, dato_6=mercadoPagoKey, dato_9=llaveBreB,
   * dato_10=geminiKey, dato_12=adminUsuario, dato_13=adminNombre,
   * dato_14=adminWhatsapp, dato_15=notifActivo.
   */
  async migrateSecretsFromSheets(): Promise<{ success: boolean; migrated: number; message?: string }> {
    if (!this.firebase.isEnabled()) return { success: false, migrated: 0, message: 'Servicio no disponible.' };
    try {
      const rows = await this.sheets.read('propiedades');
      const db = this.firebase.db();
      let migrated = 0;
      for (const r of rows) {
        const id = String((r as any).dato_1 ?? '').trim();
        if (!id) continue;
        const key = this.safeKey(id);
        const ref = db.ref(`${MIRROR_CONJUNTOS}/${key}`);
        const snap = await ref.get();
        if (!snap.exists()) continue; // solo conjuntos ya espejados
        const patch: Record<string, any> = {
          llaveBreB: (r as any).dato_9 ?? '',
          adminUsuario: (r as any).dato_12 ?? '',
          adminNombre: (r as any).dato_13 ?? '',
          adminWhatsapp: (r as any).dato_14 ?? '',
          notifActivo: (r as any).dato_15 ?? 'true',
          _secrets: {
            mercadoPagoKey: String((r as any).dato_6 ?? ''),
            geminiKey: String((r as any).dato_10 ?? ''),
          },
        };
        await ref.update(patch);
        migrated++;
      }
      this.logger.log(`[properties] migrateSecretsFromSheets: ${migrated} conjuntos migrados.`);
      return { success: true, migrated };
    } catch (e: any) {
      this.logger.error(`migrateSecretsFromSheets falló: ${e?.message}`);
      return { success: false, migrated: 0, message: e?.message };
    }
  }
}
