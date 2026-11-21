import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes } from 'crypto';
import * as QRCode from 'qrcode';
import { FirebaseService } from '../firebase/firebase.service';
import { WhatsappService } from '../whatsapp/whatsapp.service';
import { hoyISO } from '../tenants/tenant-rules';
import {
  ConfigEstadias,
  SolicitudEstadia,
  accesoVigente,
  estadoEstadia,
  generarCodigo,
  mensajeAcceso,
  mensajeWhatsappHuesped,
  normCodigo,
  normConfig,
  validarSolicitud,
} from './stay-rules';

const MIRROR_ESTADIAS = 'mirror/estadias';
const MIRROR_CONJUNTOS = 'mirror/conjuntos';
const MIRROR_USERS = 'mirror/usuarios';

type Resultado = { success: boolean; message?: string; [k: string]: any };

const norm = (s: unknown) => String(s ?? '').trim().toLowerCase();
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/**
 * Estadías cortas (alquiler por días). Reglas en ./stay-rules.
 *
 * Flujo: el propietario registra la estadía → si el conjunto exige aprobación
 * queda pendiente y el admin la aprueba o rechaza → al aprobarse, el huésped
 * recibe por WhatsApp un enlace temporal con su QR → el vigilante registra la
 * entrada y la salida (o el acceso se cierra solo al pasar la fecha de salida).
 */
@Injectable()
export class StaysService {
  private readonly logger = new Logger(StaysService.name);
  private readonly frontendUrl: string;

  constructor(
    private readonly firebase: FirebaseService,
    config: ConfigService,
    @Optional() private readonly whatsapp?: WhatsappService,
  ) {
    this.frontendUrl = config.get<string>('FRONTEND_URL', 'https://gopasehome.site').replace(/\/$/, '');
  }

  private safeKey(raw: unknown): string {
    return String(raw ?? '').trim().replace(/[.#$/\[\]]/g, '_');
  }

  // ---------------------------------------------------------------------------
  // Configuración del conjunto
  // ---------------------------------------------------------------------------

  private async findConjunto(conjunto: string): Promise<{ key: string; value: any } | null> {
    const t = norm(conjunto);
    if (!t) return null;
    const all = (await this.firebase.liveVal<Record<string, any>>(MIRROR_CONJUNTOS)) || {};
    for (const [key, value] of Object.entries(all)) {
      if (norm((value as any)?.nombre) === t || norm((value as any)?.id) === t || norm(key) === t) return { key, value };
    }
    return null;
  }

  async getConfig(conjunto: string): Promise<ConfigEstadias> {
    const found = await this.findConjunto(conjunto);
    return normConfig(found?.value?.estadiasCortas);
  }

  async setConfig(conjunto: string, dto: Partial<ConfigEstadias>): Promise<Resultado> {
    if (!this.firebase.isEnabled()) return { success: false, message: 'Servicio no disponible.' };
    const found = await this.findConjunto(conjunto);
    if (!found) return { success: false, message: 'El conjunto no existe.' };
    const config = normConfig({ ...normConfig(found.value?.estadiasCortas), ...(dto || {}) });
    await this.firebase.db().ref(`${MIRROR_CONJUNTOS}/${found.key}`).update({ estadiasCortas: config, _fbWrite: true });
    return { success: true, data: config, message: 'Configuración de estadías cortas guardada.' };
  }

  // ---------------------------------------------------------------------------
  // Lectura
  // ---------------------------------------------------------------------------

  private async todas(): Promise<any[]> {
    return this.firebase.liveValues<any>(MIRROR_ESTADIAS);
  }

  async getById(id: string): Promise<any | null> {
    const key = this.safeKey(id);
    if (!key) return null;
    const snap = await this.firebase.db().ref(`${MIRROR_ESTADIAS}/${key}`).get();
    return snap.exists() ? snap.val() : null;
  }

  /** Lo que ven el propietario, el admin y el vigilante (sin el hash del enlace). */
  toDto(e: any, hoy = hoyISO()) {
    const { tokenHash, _fbWrite, ...rest } = e || {};
    return { ...rest, estadoActual: estadoEstadia(e, hoy), vigente: accesoVigente(e, hoy) };
  }

  /** Estadías de un propietario, las próximas/actuales primero. */
  async dePropietario(propietario: string): Promise<any[]> {
    const p = norm(propietario);
    const hoy = hoyISO();
    return (await this.todas())
      .filter((e) => norm(e?.propietario) === p)
      .map((e) => this.toDto(e, hoy))
      .sort((a, b) => String(b.llegada).localeCompare(String(a.llegada)));
  }

  /**
   * Estadías de un conjunto.
   *  - 'pendientes': por aprobar (bandeja del admin).
   *  - 'hoy': las que están en el conjunto o llegan hoy (vigilante).
   *  - 'todas': todas, recientes primero.
   */
  async deConjunto(conjunto: string, vista: 'pendientes' | 'hoy' | 'todas' = 'todas'): Promise<any[]> {
    const c = norm(conjunto);
    const hoy = hoyISO();
    let lista = (await this.todas()).filter((e) => !c || norm(e?.conjunto) === c).map((e) => this.toDto(e, hoy));
    if (vista === 'pendientes') lista = lista.filter((e) => e.estadoActual === 'pendiente');
    if (vista === 'hoy') lista = lista.filter((e) => e.estadoActual === 'por_llegar' || e.estadoActual === 'en_curso');
    return lista.sort((a, b) => String(a.llegada).localeCompare(String(b.llegada)) || String(a.huesped?.nombre).localeCompare(String(b.huesped?.nombre)));
  }

  /** Busca por el código que muestra el huésped (lo digita o escanea el vigilante). */
  async porCodigo(codigoRaw: unknown): Promise<any | null> {
    const codigo = normCodigo(codigoRaw);
    if (codigo.length !== 6) return null;
    const e = (await this.todas()).find((x) => String(x?.codigo || '') === codigo);
    return e ? this.toDto(e) : null;
  }

  // ---------------------------------------------------------------------------
  // Propietario
  // ---------------------------------------------------------------------------

  async crear(propietario: string, input: SolicitudEstadia): Promise<Resultado> {
    if (!this.firebase.isEnabled()) return { success: false, message: 'Servicio no disponible.' };
    const ownerSnap = await this.firebase.db().ref(`${MIRROR_USERS}/${this.safeKey(propietario)}`).get();
    const owner = ownerSnap.exists() ? ownerSnap.val() : null;
    if (!owner || norm(owner.rol) !== 'propietario') {
      return { success: false, message: 'Solo el propietario de la unidad puede registrar estadías cortas.' };
    }
    if (!String(owner.parcela || '').trim()) {
      return { success: false, message: 'Primero registra tu unidad (casa o apartamento) en tu perfil.' };
    }
    const conjunto = String(owner.conjunto || '');
    const config = await this.getConfig(conjunto);
    const v = validarSolicitud(input, config);
    if ('error' in v) return { success: false, message: v.error };

    // Código único entre todas las estadías.
    const usados = new Set((await this.todas()).map((e) => String(e?.codigo || '')));
    let codigo = generarCodigo();
    for (let i = 0; i < 20 && usados.has(codigo); i++) codigo = generarCodigo();

    const id = `est_${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
    const registro: Record<string, any> = {
      id,
      codigo,
      conjunto,
      propietario: String(owner.usuario || propietario),
      propietarioNombre: String(owner.nombre || propietario),
      parcela: String(owner.parcela || ''),
      ...v.datos,
      estado: config.requiereAprobacion ? 'pendiente' : 'aprobada',
      creadoPor: String(propietario),
      creadoEn: new Date().toISOString(),
      _fbWrite: true,
    };
    if (!config.requiereAprobacion) {
      registro.aprobadoPor = 'automatico';
      registro.aprobadoEn = registro.creadoEn;
    }
    await this.firebase.db().ref(`${MIRROR_ESTADIAS}/${id}`).set(registro);

    if (config.requiereAprobacion) {
      return { success: true, id, codigo, message: 'Estadía registrada. Queda pendiente de aprobación por la administración.' };
    }
    const envio = await this.enviarEnlace(registro);
    return {
      success: true,
      id,
      codigo,
      message: envio.success
        ? 'Estadía registrada. Le enviamos al huésped su acceso por WhatsApp.'
        : `Estadía registrada, pero no se pudo enviar el acceso: ${envio.message}. Usa "Reenviar acceso".`,
    };
  }

  async cancelar(id: string): Promise<Resultado> {
    const e = await this.getById(id);
    if (!e) return { success: false, message: 'La estadía no existe.' };
    const s = estadoEstadia(e);
    if (s === 'finalizada' || s === 'cancelada' || s === 'rechazada') {
      return { success: false, message: 'Esta estadía ya no está activa.' };
    }
    await this.firebase
      .db()
      .ref(`${MIRROR_ESTADIAS}/${this.safeKey(id)}`)
      .update({ estado: 'cancelada', canceladaEn: new Date().toISOString(), _fbWrite: true });
    return { success: true, message: 'Estadía cancelada. El enlace del huésped ya no funciona.' };
  }

  /**
   * Genera un enlace NUEVO (el anterior deja de servir) y lo envía al huésped.
   * Solo para estadías aprobadas que no han terminado.
   */
  async enviarEnlace(e: any): Promise<Resultado> {
    const s = estadoEstadia(e);
    if (!['programada', 'por_llegar', 'en_curso'].includes(s)) {
      return { success: false, message: 'Solo se envía el acceso de estadías aprobadas que no han terminado.' };
    }
    const token = randomBytes(24).toString('base64url');
    await this.firebase
      .db()
      .ref(`${MIRROR_ESTADIAS}/${this.safeKey(e.id)}`)
      .update({ tokenHash: sha256(token), enlaceEnviadoEn: new Date().toISOString(), _fbWrite: true });
    const enlace = `${this.frontendUrl}/estadia?token=${token}`;
    const phone = String(e?.huesped?.phone || '').replace(/\D/g, '');
    if (!this.whatsapp || phone.length < 7) return { success: false, message: 'WhatsApp no disponible o celular inválido', enlace };
    const ok = await this.whatsapp.sendMessage(phone, mensajeWhatsappHuesped(e, enlace), e.conjunto).catch(() => false);
    return ok ? { success: true, message: 'Acceso enviado por WhatsApp.' } : { success: false, message: 'WhatsApp no está conectado', enlace };
  }

  async reenviar(id: string): Promise<Resultado> {
    const e = await this.getById(id);
    if (!e) return { success: false, message: 'La estadía no existe.' };
    return this.enviarEnlace(e);
  }

  // ---------------------------------------------------------------------------
  // Administración
  // ---------------------------------------------------------------------------

  async aprobar(id: string, por: string): Promise<Resultado> {
    const e = await this.getById(id);
    if (!e) return { success: false, message: 'La estadía no existe.' };
    if (e.estado !== 'pendiente') return { success: false, message: 'Esta estadía ya fue revisada.' };
    const aprobada = { ...e, estado: 'aprobada', aprobadoPor: por, aprobadoEn: new Date().toISOString() };
    await this.firebase
      .db()
      .ref(`${MIRROR_ESTADIAS}/${this.safeKey(id)}`)
      .update({ estado: 'aprobada', aprobadoPor: por, aprobadoEn: aprobada.aprobadoEn, _fbWrite: true });
    if (estadoEstadia(aprobada) === 'finalizada') {
      return { success: true, message: 'Estadía aprobada, pero sus fechas ya pasaron: no se envió acceso.' };
    }
    const envio = await this.enviarEnlace(aprobada);
    await this.avisarPropietario(aprobada, `✅ La administración aprobó la estadía de *${aprobada.huesped?.nombre}* (${aprobada.llegada} a ${aprobada.salida}).`);
    return {
      success: true,
      message: envio.success
        ? 'Estadía aprobada. El huésped recibió su acceso por WhatsApp.'
        : `Estadía aprobada, pero no se pudo enviar el acceso: ${envio.message}.`,
    };
  }

  async rechazar(id: string, por: string, motivo: string): Promise<Resultado> {
    const e = await this.getById(id);
    if (!e) return { success: false, message: 'La estadía no existe.' };
    if (e.estado !== 'pendiente') return { success: false, message: 'Esta estadía ya fue revisada.' };
    const m = String(motivo || '').trim().slice(0, 300);
    await this.firebase
      .db()
      .ref(`${MIRROR_ESTADIAS}/${this.safeKey(id)}`)
      .update({ estado: 'rechazada', motivo: m, aprobadoPor: por, aprobadoEn: new Date().toISOString(), _fbWrite: true });
    await this.avisarPropietario(e, `❌ La administración no aprobó la estadía de *${e.huesped?.nombre}*${m ? `: ${m}` : '.'}`);
    return { success: true, message: 'Estadía rechazada. Le avisamos al propietario.' };
  }

  /** WhatsApp al propietario (best-effort). */
  private async avisarPropietario(e: any, texto: string): Promise<void> {
    try {
      const snap = await this.firebase.db().ref(`${MIRROR_USERS}/${this.safeKey(e.propietario)}`).get();
      const phone = String(snap.exists() ? snap.val()?.phone || '' : '').replace(/\D/g, '');
      if (this.whatsapp && phone.length >= 7) await this.whatsapp.sendMessage(phone, `${texto}\n\n_GoPase · ${e.conjunto}_`, e.conjunto);
    } catch (err: any) {
      this.logger.warn(`[stays] no se pudo avisar al propietario ${e?.propietario}: ${err?.message}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Portería
  // ---------------------------------------------------------------------------

  async registrarEntrada(id: string, por: string): Promise<Resultado> {
    const e = await this.getById(id);
    if (!e) return { success: false, message: 'La estadía no existe.' };
    const msg = mensajeAcceso(e);
    if (msg) return { success: false, message: msg };
    if (e.entrada?.en) return { success: false, message: 'La entrada ya estaba registrada.' };
    const entrada = { en: new Date().toISOString(), por };
    await this.firebase.db().ref(`${MIRROR_ESTADIAS}/${this.safeKey(id)}`).update({ entrada, _fbWrite: true });
    return { success: true, message: `Entrada de ${e.huesped?.nombre} registrada.` };
  }

  async registrarSalida(id: string, por: string): Promise<Resultado> {
    const e = await this.getById(id);
    if (!e) return { success: false, message: 'La estadía no existe.' };
    if (estadoEstadia(e) !== 'en_curso') return { success: false, message: 'El huésped no tiene una entrada registrada.' };
    const salidaReal = { en: new Date().toISOString(), por };
    await this.firebase.db().ref(`${MIRROR_ESTADIAS}/${this.safeKey(id)}`).update({ salidaReal, _fbWrite: true });
    return { success: true, message: `Salida de ${e.huesped?.nombre} registrada. Su acceso quedó cerrado.` };
  }

  // ---------------------------------------------------------------------------
  // Enlace público del huésped (sin sesión)
  // ---------------------------------------------------------------------------

  async acceso(token: string): Promise<Resultado> {
    const t = String(token || '').trim();
    if (t.length < 20) return { success: false, message: 'El enlace no es válido.' };
    const hash = sha256(t);
    const e = (await this.todas()).find((x) => x?.tokenHash && x.tokenHash === hash);
    if (!e) return { success: false, message: 'El enlace no es válido o fue reemplazado por uno nuevo.' };

    const vigente = accesoVigente(e);
    const config = await this.getConfig(e.conjunto);
    const data: Record<string, any> = {
      huesped: String(e.huesped?.nombre || ''),
      conjunto: String(e.conjunto || ''),
      parcela: String(e.parcela || ''),
      anfitrion: String(e.propietarioNombre || '').split(/\s+/)[0],
      llegada: e.llegada,
      salida: e.salida,
      acompanantes: Number(e.acompanantes) || 0,
      estado: estadoEstadia(e),
      vigente,
      mensaje: mensajeAcceso(e),
      reglas: config.reglas,
    };
    if (vigente) {
      // El QR lleva al vigilante (con sesión) directo a esta estadía en su Inicio.
      data.codigo = e.codigo;
      data.qr = await QRCode.toDataURL(`${this.frontendUrl}/app/home?estadia=${e.codigo}`, { margin: 1, width: 320 });
      data.noticias = await this.noticiasRecientes(e.conjunto);
    }
    return { success: true, data };
  }

  private async noticiasRecientes(conjunto: string): Promise<any[]> {
    try {
      const todas = await this.firebase.liveValues<any>('mirror/noticias');
      return todas
        .filter((n) => norm(n?.conjunto) === norm(conjunto))
        .sort((a, b) => String(b?.creadoEn || '').localeCompare(String(a?.creadoEn || '')))
        .slice(0, 5)
        .map((n) => ({ titulo: String(n?.titulo || ''), subtitulo: String(n?.subtitulo || ''), creadoEn: String(n?.creadoEn || '') }));
    } catch {
      return [];
    }
  }
}
