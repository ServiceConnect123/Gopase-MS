import { Injectable, Logger } from '@nestjs/common';
import { FirebaseService } from '../firebase/firebase.service';

/**
 * CRUD de reservas de zonas comunes contra Firebase (RTDB mirror/reservas).
 * Reemplaza getReservas/addReserva/updateReserva del frontend (Sheets).
 *
 * Campos (alineados con mapReserva del SyncService):
 *   id, conjunto, zonaId, zonaNombre, usuario, fecha, horas (CSV),
 *   costo, estado, pagoId, comprobanteUrl, fechaAprobacion
 *
 * NOTA: la aprobación/rechazo de una reserva vinculada a un pago la maneja
 * PaymentsService.reviewPayment (también escribe aquí con _fbWrite).
 */
const MIRROR_RESERVAS = 'mirror/reservas';

@Injectable()
export class ReservationsService {
  private readonly logger = new Logger(ReservationsService.name);

  constructor(private readonly firebase: FirebaseService) {}

  private safeKey(raw: unknown): string {
    return String(raw ?? '').trim().replace(/[.#$/\[\]]/g, '_');
  }

  /** Normaliza horas a CSV de enteros (acepta array o string). */
  private horasToCsv(horas: any): string {
    if (Array.isArray(horas)) return horas.join(',');
    return String(horas ?? '');
  }

  private buildRecord(dto: any): Record<string, any> {
    return {
      id: String(dto.id),
      conjunto: dto.conjunto ?? '',
      zonaId: String(dto.zonaId ?? ''),
      zonaNombre: dto.zonaNombre ?? '',
      usuario: String(dto.usuario ?? ''),
      fecha: dto.fecha ?? '',
      horas: this.horasToCsv(dto.horas),
      costo: String(dto.costo ?? 0),
      estado: dto.estado ?? 'Solicitada',
      pagoId: String(dto.pagoId ?? ''),
      comprobanteUrl: dto.comprobanteUrl ?? '',
      fechaAprobacion: dto.fechaAprobacion ?? '',
      _fbWrite: true,
    };
  }

  /** Lista de reservas. Filtra por conjunto y/o usuario si se pasan. */
  async list(filters: { conjunto?: string; usuario?: string }): Promise<any[]> {
    if (!this.firebase.isEnabled()) throw new Error('Servicio no disponible.');
    const snap = await this.firebase.db().ref(MIRROR_RESERVAS).get();
    if (!snap.exists()) return [];
    let reservas = Object.values(snap.val() || {}) as any[];
    const norm = (s: unknown) => String(s ?? '').trim().toLowerCase();
    if (filters.conjunto) reservas = reservas.filter((r) => norm(r.conjunto) === norm(filters.conjunto));
    if (filters.usuario) reservas = reservas.filter((r) => norm(r.usuario) === norm(filters.usuario));
    return reservas.map((r) => {
      const { _fbWrite, ...rest } = r;
      return rest;
    });
  }

  async create(dto: any): Promise<{ success: boolean; message?: string; id?: string }> {
    if (!this.firebase.isEnabled()) return { success: false, message: 'Servicio no disponible.' };
    const id = String(dto.id || Date.now().toString());
    try {
      await this.firebase.db().ref(`${MIRROR_RESERVAS}/${this.safeKey(id)}`).set(this.buildRecord({ ...dto, id }));
      return { success: true, id, message: 'Reserva creada.' };
    } catch (err: any) {
      this.logger.error(`[reservations] create falló: ${err?.message}`);
      return { success: false, message: err?.message || 'No se pudo crear la reserva.' };
    }
  }

  async update(id: string, dto: any): Promise<{ success: boolean; message?: string }> {
    if (!this.firebase.isEnabled()) return { success: false, message: 'Servicio no disponible.' };
    const key = this.safeKey(id);
    if (!key) return { success: false, message: 'ID requerido.' };
    const ref = this.firebase.db().ref(`${MIRROR_RESERVAS}/${key}`);
    const snap = await ref.get();
    if (!snap.exists()) return { success: false, message: 'La reserva no existe.' };
    try {
      // Reescribe la reserva completa (como updateReserva en Sheets).
      await ref.set(this.buildRecord({ ...dto, id }));
      return { success: true, message: 'Reserva actualizada.' };
    } catch (err: any) {
      this.logger.error(`[reservations] update ${key} falló: ${err?.message}`);
      return { success: false, message: err?.message || 'No se pudo actualizar la reserva.' };
    }
  }

  async remove(id: string): Promise<{ success: boolean; message?: string }> {
    if (!this.firebase.isEnabled()) return { success: false, message: 'Servicio no disponible.' };
    const key = this.safeKey(id);
    if (!key) return { success: false, message: 'ID requerido.' };
    try {
      await this.firebase.db().ref(`${MIRROR_RESERVAS}/${key}`).remove();
      return { success: true, message: 'Reserva eliminada.' };
    } catch (err: any) {
      this.logger.error(`[reservations] delete ${key} falló: ${err?.message}`);
      return { success: false, message: err?.message || 'No se pudo eliminar la reserva.' };
    }
  }
}
