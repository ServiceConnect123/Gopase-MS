import { Injectable, Logger } from '@nestjs/common';
import { FirebaseService } from '../firebase/firebase.service';

/**
 * CRUD de zonas comunes contra Firebase (RTDB mirror/zonas_comunes).
 * Reemplaza getZonas/addZona/updateZona/deleteZona del frontend (Sheets).
 *
 * Campos (alineados con mapZona del SyncService):
 *   id, conjunto, nombre, esPago, precioHora, horaApertura, horaCierre, activo
 * Los valores se guardan como string (igual que el espejo de Sheets); el
 * frontend hace la conversión a bool/number al pintarlos.
 */
const MIRROR_ZONAS = 'mirror/zonas_comunes';

@Injectable()
export class ZonesService {
  private readonly logger = new Logger(ZonesService.name);

  constructor(private readonly firebase: FirebaseService) {}

  private safeKey(raw: unknown): string {
    return String(raw ?? '').trim().replace(/[.#$/\[\]]/g, '_');
  }

  private buildRecord(dto: any): Record<string, any> {
    return {
      id: String(dto.id),
      conjunto: dto.conjunto ?? '',
      nombre: dto.nombre ?? '',
      esPago: dto.esPago ? 'true' : 'false',
      precioHora: String(dto.precioHora ?? 0),
      horaApertura: String(dto.horaApertura ?? 8),
      horaCierre: String(dto.horaCierre ?? 22),
      activo: dto.activo === false ? 'false' : 'true',
      _fbWrite: true,
    };
  }

  /** Lista de zonas. Filtra por conjunto (id o nombre) si se pasa. */
  async list(conjunto?: string): Promise<any[]> {
    if (!this.firebase.isEnabled()) throw new Error('Servicio no disponible.');
    const snap = await this.firebase.db().ref(MIRROR_ZONAS).get();
    if (!snap.exists()) return [];
    let zonas = Object.values(snap.val() || {}) as any[];
    if (conjunto) {
      const norm = (s: unknown) => String(s ?? '').trim().toLowerCase();
      zonas = zonas.filter((z) => norm(z.conjunto) === norm(conjunto));
    }
    return zonas.map((z) => {
      const { _fbWrite, ...rest } = z;
      return rest;
    });
  }

  async create(dto: any): Promise<{ success: boolean; message?: string; id?: string }> {
    if (!this.firebase.isEnabled()) return { success: false, message: 'Servicio no disponible.' };
    const id = String(dto.id || Date.now().toString());
    const record = this.buildRecord({ ...dto, id });
    try {
      await this.firebase.db().ref(`${MIRROR_ZONAS}/${this.safeKey(id)}`).set(record);
      return { success: true, id, message: 'Zona creada.' };
    } catch (err: any) {
      this.logger.error(`[zones] create falló: ${err?.message}`);
      return { success: false, message: err?.message || 'No se pudo crear la zona.' };
    }
  }

  async update(id: string, dto: any): Promise<{ success: boolean; message?: string }> {
    if (!this.firebase.isEnabled()) return { success: false, message: 'Servicio no disponible.' };
    const key = this.safeKey(id);
    if (!key) return { success: false, message: 'ID requerido.' };
    const ref = this.firebase.db().ref(`${MIRROR_ZONAS}/${key}`);
    const snap = await ref.get();
    if (!snap.exists()) return { success: false, message: 'La zona no existe.' };
    try {
      // Reescribe la zona completa (como hacía updateReserva/updateZona en Sheets).
      await ref.set(this.buildRecord({ ...dto, id }));
      return { success: true, message: 'Zona actualizada.' };
    } catch (err: any) {
      this.logger.error(`[zones] update ${key} falló: ${err?.message}`);
      return { success: false, message: err?.message || 'No se pudo actualizar la zona.' };
    }
  }

  async remove(id: string): Promise<{ success: boolean; message?: string }> {
    if (!this.firebase.isEnabled()) return { success: false, message: 'Servicio no disponible.' };
    const key = this.safeKey(id);
    if (!key) return { success: false, message: 'ID requerido.' };
    try {
      await this.firebase.db().ref(`${MIRROR_ZONAS}/${key}`).remove();
      return { success: true, message: 'Zona eliminada.' };
    } catch (err: any) {
      this.logger.error(`[zones] delete ${key} falló: ${err?.message}`);
      return { success: false, message: err?.message || 'No se pudo eliminar la zona.' };
    }
  }
}
