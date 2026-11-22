import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as QRCode from 'qrcode';
import { FirebaseService } from '../firebase/firebase.service';
import { horaColombia, hoyISO } from '../tenants/tenant-rules';
import { firmaEnlace, firmaValida, generarCodigo, mensajeCompartir, normCodigoInvitado, validezQr } from './guest-qr';

/**
 * CRUD de invitados (hoja 'vigilantes') contra Firebase (RTDB mirror/invitados).
 * Reemplaza getData('vigilantes')/createData('vigilantes')/update/delete del
 * frontend (Sheets). Usado por guests.tsx (registro de invitados, marcar ingreso
 * en portería, eliminar).
 *
 * Campos (alineados con mapInvitado del SyncService):
 *   id, nombre, placa, fecha, propietario (username), parcela, estado,
 *   horaIngreso, nota
 * Agregados con el QR de invitados (ver ./guest-qr):
 *   conjunto (del anfitrión; los registros viejos lo derivan del anfitrión),
 *   qr { codigo, creadoEn, anulado, usadoEn }, ingresoPor, ingresoEn
 */
const MIRROR_INVITADOS = 'mirror/invitados';
const MIRROR_USERS = 'mirror/usuarios';

const norm = (s: unknown) => String(s ?? '').trim().toLowerCase();
type Resultado = { success: boolean; message?: string; [k: string]: any };

@Injectable()
export class GuestsService {
  private readonly logger = new Logger(GuestsService.name);

  private readonly secreto: string;
  private readonly frontendUrl: string;

  constructor(
    private readonly firebase: FirebaseService,
    config: ConfigService,
  ) {
    this.secreto = config.get<string>('JWT_SECRET', 'gopase-dev-secret-change-me');
    this.frontendUrl = config.get<string>('FRONTEND_URL', 'https://gopasehome.site').replace(/\/$/, '');
  }

  private safeKey(raw: unknown): string {
    return String(raw ?? '').trim().replace(/[.#$/\[\]]/g, '_');
  }

  private buildRecord(dto: any): Record<string, any> {
    return {
      id: String(dto.id),
      nombre: dto.nombre ?? '',
      placa: dto.placa ?? '',
      fecha: dto.fecha ?? '',
      propietario: String(dto.propietario ?? ''),
      parcela: dto.parcela ?? '',
      estado: dto.estado ?? 'Pendiente',
      horaIngreso: dto.horaIngreso ?? '',
      nota: dto.nota ?? '',
      conjunto: String(dto.conjunto ?? ''),
      ...(dto.qr ? { qr: dto.qr } : {}),
      _fbWrite: true,
    };
  }

  private async usuarios(): Promise<Record<string, any>> {
    return (await this.firebase.liveVal<Record<string, any>>(MIRROR_USERS)) || {};
  }

  /** Conjunto del invitado: el guardado o, en registros viejos, el de su anfitrión. */
  private conjuntoDe(inv: any, usuarios: Record<string, any>): string {
    if (inv?.conjunto) return String(inv.conjunto);
    return String(usuarios[this.safeKey(inv?.propietario)]?.conjunto || '');
  }

  /**
   * Lista de invitados. Filtra por propietario (username) y/o por conjunto
   * (portería y administración solo ven los de su conjunto).
   */
  async list(filters: { propietario?: string; conjunto?: string }): Promise<any[]> {
    if (!this.firebase.isEnabled()) throw new Error('Servicio no disponible.');
    const snap = await this.firebase.db().ref(MIRROR_INVITADOS).get();
    if (!snap.exists()) return [];
    let invitados = Object.values(snap.val() || {}) as any[];
    if (filters.propietario) {
      invitados = invitados.filter((g) => norm(g.propietario) === norm(filters.propietario));
    }
    const usuarios = await this.usuarios();
    if (filters.conjunto) {
      invitados = invitados.filter((g) => norm(this.conjuntoDe(g, usuarios)) === norm(filters.conjunto));
    }
    const hoy = hoyISO();
    // Campos nombrados + alias posicionales dato_n (compat parsing por posición).
    return invitados.map((g) => {
      const { _fbWrite, ...rest } = g;
      const validez = validezQr(g, hoy);
      return {
        ...rest,
        conjunto: this.conjuntoDe(g, usuarios),
        // Estado del QR para la app (sin datos que permitan abrir el enlace).
        qrEstado: g.qr?.codigo ? validez.motivo : 'sin_qr',
        dato_1: rest.id ?? '',
        dato_2: rest.nombre ?? '',
        dato_3: rest.placa ?? '',
        dato_4: rest.fecha ?? '',
        dato_5: rest.propietario ?? '',
        dato_6: rest.parcela ?? '',
        dato_7: rest.estado ?? '',
        dato_8: rest.horaIngreso ?? '',
        dato_9: rest.nota ?? '',
      };
    });
  }

  async create(dto: any): Promise<{ success: boolean; message?: string; id?: string; codigo?: string }> {
    if (!this.firebase.isEnabled()) return { success: false, message: 'Servicio no disponible.' };
    const id = String(dto.id || Date.now().toString());
    try {
      // Conjunto y unidad salen del anfitrión (no del cliente).
      const host = (await this.usuarios())[this.safeKey(dto.propietario)];
      const registro: any = {
        ...dto,
        id,
        conjunto: host?.conjunto || dto.conjunto || '',
        parcela: host?.parcela || dto.parcela || '',
        estado: 'Pendiente',
        horaIngreso: '',
      };
      if (dto.generarQr !== false) registro.qr = { codigo: await this.codigoLibre(), creadoEn: new Date().toISOString(), anulado: false };
      await this.firebase.db().ref(`${MIRROR_INVITADOS}/${this.safeKey(id)}`).set(this.buildRecord(registro));
      return { success: true, id, codigo: registro.qr?.codigo, message: 'Invitado registrado.' };
    } catch (err: any) {
      this.logger.error(`[guests] create falló: ${err?.message}`);
      return { success: false, message: err?.message || 'No se pudo registrar el invitado.' };
    }
  }

  /** Actualiza un invitado (reescribe; usado para marcar ingreso: estado + hora). */
  async update(id: string, dto: any): Promise<{ success: boolean; message?: string }> {
    if (!this.firebase.isEnabled()) return { success: false, message: 'Servicio no disponible.' };
    const key = this.safeKey(id);
    if (!key) return { success: false, message: 'ID requerido.' };
    const ref = this.firebase.db().ref(`${MIRROR_INVITADOS}/${key}`);
    const snap = await ref.get();
    if (!snap.exists()) return { success: false, message: 'El invitado no existe.' };
    try {
      // Merge por campo presente (marcar ingreso solo toca estado/horaIngreso).
      const patch: Record<string, any> = { _fbWrite: true };
      ['nombre', 'placa', 'fecha', 'propietario', 'parcela', 'estado', 'horaIngreso', 'nota'].forEach((f) => {
        if (dto[f] !== undefined) patch[f] = dto[f];
      });
      await ref.update(patch);
      return { success: true, message: 'Invitado actualizado.' };
    } catch (err: any) {
      this.logger.error(`[guests] update ${key} falló: ${err?.message}`);
      return { success: false, message: err?.message || 'No se pudo actualizar el invitado.' };
    }
  }

  // ---------------------------------------------------------------------------
  // QR de acceso
  // ---------------------------------------------------------------------------

  private async codigoLibre(): Promise<string> {
    const snap = await this.firebase.db().ref(MIRROR_INVITADOS).get();
    const usados = new Set(Object.values(snap.exists() ? snap.val() || {} : {}).map((g: any) => String(g?.qr?.codigo || '')));
    let c = generarCodigo();
    for (let i = 0; i < 20 && usados.has(c); i++) c = generarCodigo();
    return c;
  }

  async getById(id: string): Promise<any | null> {
    const key = this.safeKey(id);
    if (!key) return null;
    const snap = await this.firebase.db().ref(`${MIRROR_INVITADOS}/${key}`).get();
    return snap.exists() ? snap.val() : null;
  }

  async porCodigo(codigoRaw: unknown): Promise<any | null> {
    const codigo = normCodigoInvitado(codigoRaw);
    if (codigo.length !== 6) return null;
    const snap = await this.firebase.db().ref(MIRROR_INVITADOS).get();
    const todos = Object.values(snap.exists() ? snap.val() || {} : {}) as any[];
    return todos.find((g) => String(g?.qr?.codigo || '') === codigo) || null;
  }

  /** Conjunto efectivo del invitado (para validar permisos en el controlador). */
  async conjuntoDelInvitado(inv: any): Promise<string> {
    return this.conjuntoDe(inv, await this.usuarios());
  }

  /** Lo que ve portería al validar (sin datos del enlace). */
  async paraPorteria(inv: any): Promise<any> {
    const usuarios = await this.usuarios();
    const host = usuarios[this.safeKey(inv.propietario)];
    const v = validezQr(inv);
    return {
      id: inv.id,
      nombre: inv.nombre,
      placa: inv.placa || '',
      fecha: inv.fecha,
      nota: inv.nota || '',
      estado: inv.estado,
      horaIngreso: inv.horaIngreso || '',
      anfitrion: String(host?.nombre || inv.propietario || ''),
      parcela: String(inv.parcela || host?.parcela || ''),
      conjunto: this.conjuntoDe(inv, usuarios),
      codigo: inv.qr?.codigo || '',
      ...v,
    };
  }

  /**
   * Datos para compartir el QR: imagen, código, enlace del invitado y texto
   * del WhatsApp. Si el invitado no tenía QR (registros viejos), se le crea.
   */
  async compartir(id: string): Promise<Resultado> {
    if (!this.firebase.isEnabled()) return { success: false, message: 'Servicio no disponible.' };
    let inv = await this.getById(id);
    if (!inv) return { success: false, message: 'El invitado no existe.' };
    if (!inv.qr?.codigo) {
      const qr = { codigo: await this.codigoLibre(), creadoEn: new Date().toISOString(), anulado: false };
      await this.firebase.db().ref(`${MIRROR_INVITADOS}/${this.safeKey(id)}`).update({ qr, _fbWrite: true });
      inv = { ...inv, qr };
    }
    const usuarios = await this.usuarios();
    const host = usuarios[this.safeKey(inv.propietario)];
    const conjunto = this.conjuntoDe(inv, usuarios);
    const codigo = inv.qr.codigo;
    const enlace = `${this.frontendUrl}/invitado?c=${codigo}&s=${firmaEnlace(this.secreto, String(inv.id), codigo)}`;
    const v = validezQr(inv);
    return {
      success: true,
      data: {
        id: inv.id,
        nombre: inv.nombre,
        fecha: inv.fecha,
        placa: inv.placa || '',
        conjunto,
        parcela: String(inv.parcela || host?.parcela || ''),
        anfitrion: String(host?.nombre || inv.propietario || ''),
        codigo,
        enlace,
        qr: await QRCode.toDataURL(this.urlPorteria(codigo), { margin: 1, width: 360 }),
        // Texto listo para WhatsApp (el `mensaje` de la validez va aparte).
        textoWhatsapp: mensajeCompartir({ ...inv, conjunto }, enlace, String(host?.nombre || 'Tu anfitrión').split(/\s+/)[0]),
        ...v,
      },
    };
  }

  /** Lo que codifica la imagen QR: abre la validación en portería. */
  private urlPorteria(codigo: string): string {
    return `${this.frontendUrl}/app/guests?codigo=${codigo}`;
  }

  async anularQr(id: string): Promise<Resultado> {
    const inv = await this.getById(id);
    if (!inv?.qr?.codigo) return { success: false, message: 'Este invitado no tiene QR.' };
    if (inv.qr.usadoEn) return { success: false, message: 'El QR ya se usó.' };
    await this.firebase
      .db()
      .ref(`${MIRROR_INVITADOS}/${this.safeKey(id)}`)
      .update({ qr: { ...inv.qr, anulado: true, anuladoEn: new Date().toISOString() }, _fbWrite: true });
    return { success: true, message: 'QR anulado. Ya no sirve para entrar.' };
  }

  /** Portería: registra la entrada con el QR (solo si es válido hoy). Queda usado. */
  async registrarIngresoQr(inv: any, por: string): Promise<Resultado> {
    const v = validezQr(inv);
    if (!v.valido) return { success: false, message: v.mensaje, motivo: v.motivo };
    const hora = horaColombia();
    await this.firebase
      .db()
      .ref(`${MIRROR_INVITADOS}/${this.safeKey(inv.id)}`)
      .update({
        estado: 'Ingresó',
        horaIngreso: hora,
        ingresoPor: por,
        ingresoEn: new Date().toISOString(),
        qr: { ...inv.qr, usadoEn: new Date().toISOString() },
        _fbWrite: true,
      });
    return { success: true, horaIngreso: hora, message: `Entrada de ${inv.nombre} registrada a las ${hora}.` };
  }

  /** Enlace público del invitado (/invitado?c=&s=). Sin sesión. */
  async acceso(codigoRaw: unknown, firma: unknown): Promise<Resultado> {
    const inv = await this.porCodigo(codigoRaw);
    if (!inv || !firmaValida(this.secreto, String(inv.id), inv.qr.codigo, firma)) {
      return { success: false, message: 'El enlace no es válido.' };
    }
    const usuarios = await this.usuarios();
    const host = usuarios[this.safeKey(inv.propietario)];
    const v = validezQr(inv);
    const data: Record<string, any> = {
      nombre: inv.nombre,
      fecha: inv.fecha,
      placa: inv.placa || '',
      conjunto: this.conjuntoDe(inv, usuarios),
      parcela: String(inv.parcela || host?.parcela || ''),
      anfitrion: String(host?.nombre || '').split(/\s+/)[0],
      valido: v.valido,
      motivo: v.motivo,
      mensaje: v.valido ? 'Muéstrale este QR al vigilante al llegar.' : v.mensaje,
    };
    // El QR solo se entrega mientras sirve (hoy, sin usar ni anular).
    if (v.valido) {
      data.codigo = inv.qr.codigo;
      data.qr = await QRCode.toDataURL(this.urlPorteria(inv.qr.codigo), { margin: 1, width: 360 });
    }
    return { success: true, data };
  }

  async remove(id: string): Promise<{ success: boolean; message?: string }> {
    if (!this.firebase.isEnabled()) return { success: false, message: 'Servicio no disponible.' };
    const key = this.safeKey(id);
    if (!key) return { success: false, message: 'ID requerido.' };
    try {
      await this.firebase.db().ref(`${MIRROR_INVITADOS}/${key}`).remove();
      return { success: true, message: 'Invitado eliminado.' };
    } catch (err: any) {
      this.logger.error(`[guests] delete ${key} falló: ${err?.message}`);
      return { success: false, message: err?.message || 'No se pudo eliminar el invitado.' };
    }
  }
}
