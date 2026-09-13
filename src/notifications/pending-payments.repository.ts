import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SheetsService } from '../sheets/sheets.service';

export interface ConjuntoConfig {
  nombre: string;
  adminNombre: string;
  adminWhatsapp: string;
  activo: boolean;
  rutaAprobacion: string;
}

export interface PendingPayment {
  id: string;
  usuario: string;
  concepto: string;
  valor: string;
  fecha: string;
  estado: string;
}

/**
 * Acceso a datos para el flujo de pagos pendientes.
 *
 * Mapeo de columnas conocido (según el Apps Script y goPase):
 *  - usuarios (Hoja 1): dato_1=usuario, dato_2=email, dato_3=password,
 *      dato_4=nombre, dato_5=rol, dato_6=docType, dato_7=docNum,
 *      dato_8=phone, dato_9=conjunto
 *  - pagos (Hoja 2): dato_1=id, dato_2=usuario, dato_3=concepto,
 *      dato_4=valor, dato_5=fecha, dato_6=estado, dato_7=referencia
 *  - propiedades (Hoja 5): dato_1=id, dato_2=nombre, dato_3=direccion,
 *      dato_4=tipo, dato_5=descripcion, dato_6=mercadoPagoKey, dato_7=cuotaMonto,
 *      dato_8=moneda, dato_9=llaveBreB, dato_10=geminiKey, dato_11=driveFolderId,
 *      dato_12=adminUsuario, dato_13=adminNombre, dato_14=adminWhatsapp,
 *      dato_15=notifActivo   <-- config del admin de notificaciones WhatsApp
 *  - wsp_envios (control diario): dato_1=conjunto, dato_2=fecha(YYYY-MM-DD),
 *      dato_3=cantidad_pagos, dato_4=estado, dato_5=timestamp
 */
@Injectable()
export class PendingPaymentsRepository {
  private readonly logger = new Logger(PendingPaymentsRepository.name);
  private readonly pendingStatus: string;

  static readonly SHEET_PROPIEDADES = 'propiedades';
  static readonly SHEET_ENVIOS = 'wsp_envios';

  constructor(
    private readonly sheets: SheetsService,
    private readonly config: ConfigService,
  ) {
    this.pendingStatus = this.config
      .get<string>('PENDING_STATUS', 'Pendiente')
      .toLowerCase();
  }

  private str(v: any): string {
    return v == null ? '' : v.toString().trim();
  }

  /**
   * Lee la hoja de propiedades (conjuntos) y devuelve solo los que tienen
   * admin de WhatsApp configurado y notificaciones activas.
   */
  async getConjuntos(): Promise<ConjuntoConfig[]> {
    const rows = await this.sheets.read(
      PendingPaymentsRepository.SHEET_PROPIEDADES,
    );
    const defaultPath = this.config.get<string>('APP_APPROVAL_PATH', '/app/payments');
    return rows
      .map((r) => {
        // notifActivo (dato_15): si viene vacío, se asume activo.
        const notifRaw = this.str(r.dato_15).toLowerCase();
        const activo =
          notifRaw === '' ||
          ['true', '1', 'si', 'sí', 'activo'].includes(notifRaw);
        return {
          nombre: this.str(r.dato_2),
          adminNombre: this.str(r.dato_13),
          adminWhatsapp: this.str(r.dato_14),
          activo,
          rutaAprobacion: defaultPath,
        };
      })
      .filter((c) => c.nombre && c.adminWhatsapp && c.activo);
  }

  /**
   * Construye un mapa usuario(username) -> conjunto a partir de la hoja usuarios.
   */
  async getUserToConjunto(): Promise<Map<string, string>> {
    const rows = await this.sheets.read('usuarios');
    const map = new Map<string, string>();
    for (const r of rows) {
      const usuario = this.str(r.dato_1).toLowerCase();
      const conjunto = this.str(r.dato_9);
      if (usuario && conjunto) map.set(usuario, conjunto);
    }
    return map;
  }

  /** Lee los pagos en estado pendiente (dato_6). */
  async getPendingPayments(): Promise<PendingPayment[]> {
    const rows = await this.sheets.read('pagos');
    return rows
      .filter((r) => this.str(r.dato_6).toLowerCase() === this.pendingStatus)
      .map((r) => ({
        id: this.str(r.dato_1),
        usuario: this.str(r.dato_2),
        concepto: this.str(r.dato_3),
        valor: this.str(r.dato_4),
        fecha: this.str(r.dato_5),
        estado: this.str(r.dato_6),
      }));
  }

  /**
   * Agrupa los pagos pendientes por conjunto usando el mapa usuario->conjunto.
   */
  async getPendingByConjunto(): Promise<Map<string, PendingPayment[]>> {
    const [pending, userMap] = await Promise.all([
      this.getPendingPayments(),
      this.getUserToConjunto(),
    ]);
    const grouped = new Map<string, PendingPayment[]>();
    for (const p of pending) {
      const conjunto = userMap.get(p.usuario.toLowerCase());
      if (!conjunto) {
        this.logger.debug(
          `Pago ${p.id} de usuario '${p.usuario}' sin conjunto asociado. Se omite.`,
        );
        continue;
      }
      if (!grouped.has(conjunto)) grouped.set(conjunto, []);
      grouped.get(conjunto)!.push(p);
    }
    return grouped;
  }

  /** Devuelve el set de "conjunto|fecha" que ya fueron notificados. */
  async getEnviosDelDia(fecha: string): Promise<Set<string>> {
    const rows = await this.sheets.read(PendingPaymentsRepository.SHEET_ENVIOS);
    const set = new Set<string>();
    for (const r of rows) {
      const conjunto = this.str(r.dato_1);
      const f = this.str(r.dato_2);
      const estado = this.str(r.dato_4).toLowerCase();
      if (f === fecha && estado === 'enviado') {
        set.add(conjunto.toLowerCase());
      }
    }
    return set;
  }

  /** Registra un envío en la hoja de control. */
  async registrarEnvio(
    conjunto: string,
    fecha: string,
    cantidad: number,
  ): Promise<void> {
    await this.sheets.create(PendingPaymentsRepository.SHEET_ENVIOS, [
      conjunto,
      fecha,
      cantidad,
      'enviado',
      new Date().toISOString(),
    ]);
  }
}
