import { Injectable, Logger } from '@nestjs/common';
import { FirebaseService } from '../firebase/firebase.service';
import { UsersService } from '../users/users.service';
import { UsersInviteService } from '../users/users-invite.service';
import {
  DatosInquilino,
  conPropietario,
  ROL_INQUILINO,
  esInquilino,
  estadoInquilino,
  puedePagarPorCuenta,
  resumenParaSesion,
  validarArriendo,
} from './tenant-rules';

const MIRROR_USERS = 'mirror/usuarios';

export interface TenantInput {
  nombre?: string;
  documentType?: string;
  documentNumber?: string;
  phone?: string;
  email?: string;
  placa1?: string;
  placa2?: string;
  inicio?: string;
  fin?: string;
  pagaAdministracion?: boolean;
  puedeReservar?: boolean;
  /** Al crear: enviar usuario y contraseña temporal por WhatsApp. */
  enviarAcceso?: boolean;
}

type Resultado = { success: boolean; message?: string; [k: string]: any };

/**
 * Inquilinos creados por el propietario de una unidad (rol "inquilino").
 * Ver reglas en ./tenant-rules. Se guardan como usuarios normales
 * (mirror/usuarios + Firebase Auth) para reutilizar login, perfil, invitados,
 * PQRS, etc.; el bloque `inquilino` guarda el arriendo.
 */
@Injectable()
export class TenantsService {
  private readonly logger = new Logger(TenantsService.name);

  constructor(
    private readonly firebase: FirebaseService,
    private readonly users: UsersService,
    private readonly invite: UsersInviteService,
  ) {}

  private safeKey(raw: unknown): string {
    return String(raw ?? '').trim().replace(/[.#$/\[\]]/g, '_');
  }

  private async leerUsuario(usuario: string): Promise<any | null> {
    const key = this.safeKey(usuario);
    if (!key) return null;
    const snap = await this.firebase.db().ref(`${MIRROR_USERS}/${key}`).get();
    return snap.exists() ? snap.val() : null;
  }

  /** Lo que ve el propietario de cada inquilino. */
  private toDto(u: any) {
    const d: DatosInquilino = u?.inquilino || {};
    return {
      usuario: String(u.usuario || ''),
      nombre: String(u.nombre || ''),
      documentType: String(u.docType || ''),
      documentNumber: String(u.docNum || ''),
      phone: String(u.phone || ''),
      email: String(u.email || ''),
      placa1: String(u.placa1 || ''),
      placa2: String(u.placa2 || ''),
      parcela: String(u.parcela || ''),
      conjunto: String(u.conjunto || ''),
      tipo: String(d.tipo || 'arriendo'),
      inicio: String(d.inicio || ''),
      fin: String(d.fin || ''),
      pagaAdministracion: d.pagaAdministracion === true,
      puedeReservar: d.puedeReservar === true,
      propietario: String(d.propietario || ''),
      propietarioNombre: String(d.propietarioNombre || ''),
      estado: estadoInquilino(d),
      creadoEn: String(d.creadoEn || ''),
    };
  }

  /** Propietario válido (existe y es propietario). */
  private async propietarioValido(propietario: string): Promise<any | { error: string }> {
    const owner = await this.leerUsuario(propietario);
    if (!owner) return { error: 'El propietario no existe.' };
    if (String(owner.rol || '').toLowerCase() !== 'propietario') {
      return { error: 'Solo un propietario puede registrar inquilinos de su unidad.' };
    }
    if (!String(owner.parcela || '').trim()) {
      return { error: 'Primero registra tu unidad (casa o apartamento) en tu perfil, o pídeselo al administrador.' };
    }
    return owner;
  }

  /** Inquilino que pertenece al propietario (o null). */
  private async inquilinoDe(propietario: string, usuario: string): Promise<any | null> {
    const u = await this.leerUsuario(usuario);
    if (!u || !esInquilino(u.rol)) return null;
    if (String(u.inquilino?.propietario || '').toLowerCase() !== String(propietario || '').toLowerCase()) return null;
    return u;
  }

  /** Usuario libre a partir del nombre (únicos en toda la plataforma). */
  private async usuarioLibre(nombre: string): Promise<string> {
    const base =
      String(nombre || '')
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '')
        .slice(0, 24) || 'inquilino';
    const existentes = new Set(
      (await this.firebase.liveValues<any>(MIRROR_USERS)).map((u) => String(u?.usuario || '').toLowerCase()),
    );
    if (!existentes.has(base)) return base;
    for (let i = 2; i <= 999; i++) if (!existentes.has(`${base}${i}`)) return `${base}${i}`;
    return `${base}${Date.now()}`;
  }

  /** Inquilinos del propietario, los vigentes primero. */
  async listar(propietario: string): Promise<any[]> {
    if (!this.firebase.isEnabled()) throw new Error('Servicio no disponible.');
    const p = String(propietario || '').toLowerCase();
    const orden: Record<string, number> = { activo: 0, programado: 1, vencido: 2, revocado: 3 };
    return conPropietario(await this.firebase.liveValues<any>(MIRROR_USERS))
      .filter((u) => esInquilino(u?.rol) && String(u?.inquilino?.propietario || '').toLowerCase() === p)
      .map((u) => this.toDto(u))
      .sort((a, b) => orden[a.estado] - orden[b.estado] || a.nombre.localeCompare(b.nombre));
  }

  async crear(propietario: string, input: TenantInput): Promise<Resultado> {
    if (!this.firebase.isEnabled()) return { success: false, message: 'Servicio no disponible.' };
    const owner = await this.propietarioValido(propietario);
    if ('error' in owner) return { success: false, message: owner.error };

    const nombre = String(input.nombre || '').trim();
    if (nombre.length < 3) return { success: false, message: 'Escribe el nombre completo del inquilino.' };
    const phone = String(input.phone || '').trim();
    if (phone.replace(/\D/g, '').length < 7) {
      return { success: false, message: 'Escribe el celular del inquilino: por ahí le llega su acceso.' };
    }
    const v = validarArriendo(input);
    if ('error' in v) return { success: false, message: v.error };

    const usuario = await this.usuarioLibre(nombre);
    const conjunto = String(owner.conjunto || '');
    const creado = await this.users.create({
      usuario,
      nombre,
      rol: ROL_INQUILINO,
      documentType: input.documentType || 'CC',
      documentNumber: String(input.documentNumber || '').trim(),
      phone,
      email: String(input.email || '').trim(),
      conjunto,
      parcela: String(owner.parcela || ''),
      placa1: String(input.placa1 || '').trim().toUpperCase(),
      placa2: String(input.placa2 || '').trim().toUpperCase(),
      fechaIngreso: v.datos.inicio,
      // Correo real solo en el perfil: puede repetirse con otras cuentas.
      authEmailSintetico: true,
    });
    if (!creado.success) return { success: false, message: creado.message || 'No se pudo crear el inquilino.' };

    const datos: DatosInquilino = {
      propietario: String(owner.usuario || propietario),
      propietarioNombre: String(owner.nombre || propietario),
      tipo: 'arriendo',
      ...v.datos,
      revocado: false,
      creadoPor: String(propietario),
      creadoEn: new Date().toISOString(),
    };
    await this.firebase.db().ref(`${MIRROR_USERS}/${this.safeKey(usuario)}`).update({ inquilino: datos, _fbWrite: true });

    let envio: Resultado | null = null;
    if (input.enviarAcceso !== false) envio = await this.invite.sendCredentials(usuario, conjunto);

    return {
      success: true,
      usuario,
      message: envio
        ? envio.success
          ? 'Inquilino creado. Le enviamos su acceso por WhatsApp.'
          : `Inquilino creado, pero no se pudo enviar el acceso: ${envio.message || 'WhatsApp no disponible'}. Inténtalo de nuevo con "Enviar acceso".`
        : 'Inquilino creado.',
      envioOk: envio ? envio.success : undefined,
    };
  }

  async actualizar(propietario: string, usuario: string, input: TenantInput): Promise<Resultado> {
    if (!this.firebase.isEnabled()) return { success: false, message: 'Servicio no disponible.' };
    const u = await this.inquilinoDe(propietario, usuario);
    if (!u) return { success: false, message: 'Ese inquilino no es de tu unidad.' };

    const prev: DatosInquilino = u.inquilino || {};
    const v = validarArriendo({
      inicio: input.inicio ?? prev.inicio,
      fin: input.fin ?? prev.fin,
      pagaAdministracion: input.pagaAdministracion ?? prev.pagaAdministracion,
      puedeReservar: input.puedeReservar ?? prev.puedeReservar,
    });
    if ('error' in v) return { success: false, message: v.error };
    if (input.nombre !== undefined && String(input.nombre).trim().length < 3) {
      return { success: false, message: 'Escribe el nombre completo del inquilino.' };
    }
    if (input.phone !== undefined && String(input.phone).replace(/\D/g, '').length < 7) {
      return { success: false, message: 'El celular no es válido.' };
    }

    const perfil = await this.users.update(usuario, {
      nombre: input.nombre !== undefined ? String(input.nombre).trim() : undefined,
      documentType: input.documentType,
      documentNumber: input.documentNumber !== undefined ? String(input.documentNumber).trim() : undefined,
      phone: input.phone !== undefined ? String(input.phone).trim() : undefined,
      email: input.email !== undefined ? String(input.email).trim() : undefined,
      placa1: input.placa1 !== undefined ? String(input.placa1).trim().toUpperCase() : undefined,
      placa2: input.placa2 !== undefined ? String(input.placa2).trim().toUpperCase() : undefined,
      fechaIngreso: v.datos.inicio,
    });
    if (!perfil.success) return perfil;

    await this.firebase
      .db()
      .ref(`${MIRROR_USERS}/${this.safeKey(usuario)}`)
      .update({ inquilino: { ...prev, ...v.datos }, _fbWrite: true });
    return { success: true, message: 'Inquilino actualizado.' };
  }

  /** Retira (revocar=true) o devuelve (false) el acceso del inquilino. */
  async setRevocado(propietario: string, usuario: string, revocar: boolean): Promise<Resultado> {
    if (!this.firebase.isEnabled()) return { success: false, message: 'Servicio no disponible.' };
    const u = await this.inquilinoDe(propietario, usuario);
    if (!u) return { success: false, message: 'Ese inquilino no es de tu unidad.' };
    const key = this.safeKey(usuario);
    await this.firebase
      .db()
      .ref(`${MIRROR_USERS}/${key}`)
      .update({ inquilino: { ...(u.inquilino || {}), revocado: revocar }, _fbWrite: true });
    try {
      // Cuenta deshabilitada en Auth: no puede volver a iniciar sesión.
      await this.firebase.auth().updateUser(key, { disabled: revocar });
    } catch (e: any) {
      this.logger.warn(`[tenants] no se pudo ${revocar ? 'deshabilitar' : 'habilitar'} ${key} en Auth: ${e?.message}`);
    }
    if (!revocar && estadoInquilino({ ...(u.inquilino || {}), revocado: false }) === 'vencido') {
      return { success: true, message: 'Acceso devuelto, pero el arriendo ya venció: actualiza la fecha de fin.' };
    }
    return { success: true, message: revocar ? 'Acceso retirado.' : 'Acceso devuelto.' };
  }

  async eliminar(propietario: string, usuario: string): Promise<Resultado> {
    if (!this.firebase.isEnabled()) return { success: false, message: 'Servicio no disponible.' };
    const u = await this.inquilinoDe(propietario, usuario);
    if (!u) return { success: false, message: 'Ese inquilino no es de tu unidad.' };
    return this.users.remove(usuario);
  }

  /** Reenvía usuario y una contraseña temporal nueva por WhatsApp. */
  async enviarAcceso(propietario: string, usuario: string): Promise<Resultado> {
    const u = await this.inquilinoDe(propietario, usuario);
    if (!u) return { success: false, message: 'Ese inquilino no es de tu unidad.' };
    if (estadoInquilino(u.inquilino) === 'revocado') {
      return { success: false, message: 'Primero devuélvele el acceso al inquilino.' };
    }
    return this.invite.sendCredentials(usuario, String(u.conjunto || ''));
  }

  /** Resumen del arriendo de un inquilino (para su sesión). null si no lo es. */
  async miArriendo(usuario: string): Promise<ReturnType<typeof resumenParaSesion> | null> {
    const u = await this.leerUsuario(usuario);
    if (!u || !esInquilino(u.rol)) return null;
    return resumenParaSesion(u);
  }

  /** Para chequeos rápidos (guards, pagos): datos del inquilino desde la caché. */
  async datosDesdeCache(usuario: string): Promise<any | null> {
    const todos = (await this.firebase.liveVal<Record<string, any>>(MIRROR_USERS)) || {};
    const u = todos[this.safeKey(usuario)];
    return u && esInquilino(u.rol) ? u : null;
  }

  /** ¿El inquilino puede pagar la administración de la cuenta `cuenta` hoy? */
  async puedePagarPor(inquilino: string, cuenta: string): Promise<boolean> {
    return puedePagarPorCuenta(await this.datosDesdeCache(inquilino), cuenta);
  }
}
