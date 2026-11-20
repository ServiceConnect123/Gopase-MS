import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FirebaseService } from '../firebase/firebase.service';

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

/** Nodo RTDB del control diario: wsp_envios/<YYYY-MM-DD>/<conjunto> = {...}. */
const ENVIOS_ROOT = 'wsp_envios';

/**
 * Acceso a datos para el aviso diario de "pagos pendientes por aprobar".
 *
 * Lee de Firebase RTDB (mirror/*) usando la caché en vivo de FirebaseService.
 * Antes leía de Google Sheets, pero los pagos ya se crean y aprueban en RTDB y
 * nada actualiza la hoja: los pagos nuevos nunca se avisaban y los antiguos que
 * quedaron "Pendiente" en la hoja se podían avisar a diario aunque ya
 * estuvieran aprobados.
 *
 * Campos usados:
 *  - mirror/conjuntos: nombre, adminNombre, adminWhatsapp, notifActivo
 *  - mirror/usuarios:  usuario, conjunto
 *  - mirror/pagos:     id, usuario, concepto, valor, fecha, estado
 *
 * Las claves de conjunto de los mapas devueltos van en minúsculas.
 */
@Injectable()
export class PendingPaymentsRepository {
  private readonly logger = new Logger(PendingPaymentsRepository.name);
  private readonly pendingStatus: string;

  constructor(
    private readonly firebase: FirebaseService,
    private readonly config: ConfigService,
  ) {
    this.pendingStatus = this.config.get<string>('PENDING_STATUS', 'Pendiente').toLowerCase();
  }

  private str(v: any): string {
    return v == null ? '' : v.toString().trim();
  }

  private safeKey(raw: string): string {
    return String(raw ?? '').trim().toLowerCase().replace(/[.#$/\[\]]/g, '_') || '_';
  }

  /** Conjuntos con admin de WhatsApp configurado y notificaciones activas. */
  async getConjuntos(): Promise<ConjuntoConfig[]> {
    const rows = await this.firebase.liveValues<any>('mirror/conjuntos');
    const defaultPath = this.config.get<string>('APP_APPROVAL_PATH', '/app/payments');
    return rows
      .map((r) => {
        // notifActivo: si viene vacío, se asume activo.
        const notifRaw = this.str(r?.notifActivo).toLowerCase();
        const activo = notifRaw === '' || ['true', '1', 'si', 'sí', 'activo'].includes(notifRaw);
        return {
          nombre: this.str(r?.nombre),
          adminNombre: this.str(r?.adminNombre),
          adminWhatsapp: this.str(r?.adminWhatsapp),
          activo,
          rutaAprobacion: defaultPath,
        };
      })
      .filter((c) => c.nombre && c.adminWhatsapp && c.activo);
  }

  /** Pagos pendientes agrupados por conjunto (clave en minúsculas). */
  async getPendingByConjunto(): Promise<Map<string, PendingPayment[]>> {
    const [pagos, usuarios] = await Promise.all([
      this.firebase.liveValues<any>('mirror/pagos'),
      this.firebase.liveValues<any>('mirror/usuarios'),
    ]);
    const conjuntoDe = new Map<string, string>();
    for (const u of usuarios) {
      const usuario = this.str(u?.usuario).toLowerCase();
      const conjunto = this.str(u?.conjunto).toLowerCase();
      if (usuario && conjunto) conjuntoDe.set(usuario, conjunto);
    }

    const grouped = new Map<string, PendingPayment[]>();
    for (const p of pagos) {
      if (this.str(p?.estado).toLowerCase() !== this.pendingStatus) continue;
      const usuario = this.str(p?.usuario);
      const conjunto = conjuntoDe.get(usuario.toLowerCase());
      if (!conjunto) {
        this.logger.debug(`Pago ${p?.id} de usuario '${usuario}' sin conjunto asociado. Se omite.`);
        continue;
      }
      const arr = grouped.get(conjunto) || [];
      arr.push({
        id: this.str(p?.id),
        usuario,
        concepto: this.str(p?.concepto),
        valor: this.str(p?.valor),
        fecha: this.str(p?.fecha),
        estado: this.str(p?.estado),
      });
      grouped.set(conjunto, arr);
    }
    return grouped;
  }

  /** Conjuntos (en minúsculas) ya notificados en `fecha` (YYYY-MM-DD). */
  async getEnviosDelDia(fecha: string): Promise<Set<string>> {
    const snap = await this.firebase.db().ref(`${ENVIOS_ROOT}/${fecha}`).get();
    const set = new Set<string>();
    if (snap.exists()) {
      for (const v of Object.values<any>(snap.val() || {})) {
        if (v?.conjunto) set.add(String(v.conjunto).toLowerCase());
      }
    }
    return set;
  }

  /** Registra que el conjunto fue notificado hoy (un aviso por conjunto y día). */
  async registrarEnvio(conjunto: string, fecha: string, cantidad: number): Promise<void> {
    await this.firebase
      .db()
      .ref(`${ENVIOS_ROOT}/${fecha}/${this.safeKey(conjunto)}`)
      .set({ conjunto: conjunto.toLowerCase(), cantidad, at: new Date().toISOString() });
  }
}
