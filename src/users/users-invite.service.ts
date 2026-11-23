// ==========================================
// UsersInviteService — autoregistro por QR y envío de credenciales
// ==========================================
// Dos funcionalidades:
//
// 1. QR de autoregistro:
//    - El admin genera un link de invitación del conjunto (token JWT de corta vida).
//    - El propietario abre el link, llena sus datos y se crea su cuenta.
//    - Se le devuelven (y opcionalmente se le envían por WhatsApp) sus credenciales.
//
// 2. Envío de credenciales a usuarios que nunca han ingresado:
//    - Se cruza la lista de usuarios del conjunto con los registros de sesión
//      del módulo activity-audit (AUDIT_FIREBASE_DATABASE_URL).
//    - Los usuarios sin sesión registrada se consideran "nunca ingresaron".
//    - El admin puede enviarles su usuario + una contraseña temporal por WhatsApp.
import { Injectable, Logger, Inject, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { FirebaseService } from '../firebase/firebase.service';
import { UsersService } from './users.service';
import { WhatsappService } from '../whatsapp/whatsapp.service';
import { ACTIVITY_LOGGER } from '../activity-audit/integrations/nest/activity-audit.tokens';
import { ActivityLogger } from '../activity-audit/core/activity-logger';
import {
  Advertencia, DatosSolicitud, EstadoSolicitud, MAX_PENDIENTES, SolicitudRegistro,
  advertencias, limpiarDatos, normTelefono, requiereAprobacion, solicitudRepetida,
} from './registro-solicitudes.rules';
import { LoginCon, loginConPorDefecto, normLoginCon, textoAcceso, validarLoginCon } from './login-acceso.rules';

const MIRROR_USERS = 'mirror/usuarios';
const INVITE_TOKENS_PATH = 'mirror/inviteTokens';
const MIRROR_CONJUNTOS = 'mirror/conjuntos';
// Solicitudes de registro por QR pendientes de aprobación: {conjuntoKey}/{id}.
const SOLICITUDES_PATH = 'solicitudes_registro'; // { conjunto_key: { token, createdAt, conjunto } }

// Tiempo de vida del token de invitación: 30 días.
const INVITE_TOKEN_EXPIRY = '30d';

@Injectable()
export class UsersInviteService {
  private readonly logger = new Logger(UsersInviteService.name);
  private readonly emailDomain: string;
  private readonly tempPassword: string;
  private readonly frontendUrl: string;

  constructor(
    private readonly firebase: FirebaseService,
    private readonly config: ConfigService,
    private readonly jwt: JwtService,
    private readonly users: UsersService,
    private readonly whatsapp: WhatsappService,
    @Optional() @Inject(ACTIVITY_LOGGER) private readonly activity?: ActivityLogger,
  ) {
    this.emailDomain = this.config.get<string>('AUTH_EMAIL_DOMAIN', 'gopase.local');
    this.tempPassword = this.config.get<string>('AUTH_TEMP_PASSWORD', 'Gopase2025*');
    // URL del frontend para construir el link del QR.
    this.frontendUrl = this.config.get<string>('FRONTEND_URL', 'https://gopasehome.site').replace(/\/$/, '');
  }

  private safeKey(s: string): string {
    return String(s || '').trim().replace(/[.#$/[\]]/g, '_');
  }

  // ---------------------------------------------------------------------------
  // 1. Link / QR de invitación
  // ---------------------------------------------------------------------------

  /**
   * Genera (o renueva) el token de invitación del conjunto.
   * Devuelve el link completo y el token para generar el QR en el frontend.
   */
  async getInviteLink(conjunto: string): Promise<{
    success: boolean;
    link?: string;
    token?: string;
    message?: string;
  }> {
    if (!this.firebase.isEnabled()) return { success: false, message: 'Servicio no disponible.' };
    const conjuntoTrim = String(conjunto || '').trim();
    if (!conjuntoTrim) return { success: false, message: 'Conjunto requerido.' };

    try {
      const token = this.jwt.sign(
        { conjunto: conjuntoTrim, type: 'invite' },
        { expiresIn: INVITE_TOKEN_EXPIRY },
      );
      const conjuntoKey = this.safeKey(conjuntoTrim);
      await this.firebase.db().ref(`${INVITE_TOKENS_PATH}/${conjuntoKey}`).set({
        token,
        conjunto: conjuntoTrim,
        createdAt: new Date().toISOString(),
      });
      const link = `${this.frontendUrl}/register?token=${token}`;
      this.logger.log(`[invite] link generado para "${conjuntoTrim}"`);
      return { success: true, link, token };
    } catch (err: any) {
      this.logger.error(`[invite] getInviteLink: ${err?.message}`);
      return { success: false, message: err?.message || 'No se pudo generar el link.' };
    }
  }

  /**
   * Valida un token de invitación y devuelve el nombre del conjunto.
   * Endpoint público (lo llama la pantalla de autoregistro antes de mostrar el formulario).
   */
  async validateInviteToken(token: string): Promise<{
    valid: boolean;
    conjunto?: string;
    message?: string;
  }> {
    try {
      const payload = this.jwt.verify(token) as any;
      if (payload?.type !== 'invite' || !payload?.conjunto) {
        return { valid: false, message: 'Token inválido.' };
      }
      return { valid: true, conjunto: String(payload.conjunto) };
    } catch (err: any) {
      return { valid: false, message: 'Token inválido o expirado.' };
    }
  }

  /**
   * El propietario se autoregistra usando el token del QR.
   * Crea su usuario con rol 'propietario', password temporal y devuelve las credenciales.
   * Solo requiere nombre completo — el resto es opcional para facilitar el registro.
   */
  async selfRegister(token: string, data: {
    nombre: string;
    email?: string;
    phone?: string;
    documentType?: string;
    documentNumber?: string;
    parcela?: string; // torre / apartamento / casa
  }): Promise<{
    success: boolean;
    pendiente?: boolean;
    usuario?: string;
    password?: string;
    acceso?: { etiqueta: string; valor: string };
    conjunto?: string;
    message?: string;
  }> {
    // Validar token.
    const validation = await this.validateInviteToken(token);
    if (!validation.valid || !validation.conjunto) {
      return { success: false, message: validation.message || 'Token inválido.' };
    }
    const conjunto = validation.conjunto;
    const datos = limpiarDatos(data);
    if (!datos.nombre) return { success: false, message: 'El nombre es obligatorio.' };

    // Con aprobación (por defecto): se guarda la solicitud y la cuenta se crea
    // cuando la administración la apruebe.
    const conj = await this.findConjunto(conjunto);
    if (requiereAprobacion(conj?.value)) {
      return this.crearSolicitud(conjunto, datos);
    }

    // Entra con su cédula (o correo); si otra persona del conjunto ya usa ese
    // dato, con el usuario generado (la administración lo puede cambiar luego).
    let r = await this.crearPropietario(conjunto, datos, 'Autoregistro');
    if (!r.success && /ya inicia sesión con/.test(String(r.message))) {
      r = await this.crearPropietario(conjunto, datos, 'Autoregistro', undefined, 'usuario');
    }
    if (!r.success) return { success: false, message: r.message };
    const creado = (await this.firebase.db().ref(`${MIRROR_USERS}/${this.safeKey(r.usuario || '')}`).get()).val() || {};
    return {
      success: true,
      usuario: r.usuario,
      acceso: textoAcceso({ ...creado, usuario: r.usuario }),
      password: this.tempPassword,
      conjunto,
      message: 'Tu cuenta fue creada. Ingresa con las credenciales mostradas.',
    };
  }

  /** Crea el propietario (username único, contraseña temporal) y lo deja en auditoría. */
  private async crearPropietario(
    conjunto: string,
    datos: DatosSolicitud,
    accion: string,
    actor?: string,
    loginCon: LoginCon = loginConPorDefecto(datos),
  ): Promise<{ success: boolean; usuario?: string; message?: string }> {
    // Generar username único (igual que onboarding: NFD + sufijo si hace falta).
    const base = this.generarUsuarioBase(datos.nombre);
    if (!base) return { success: false, message: 'El nombre debe contener letras o números.' };
    const usuario = await this.usuarioDisponible(base, conjunto);

    try {
      const result = await this.users.create({
        usuario,
        email: datos.email || '',
        nombre: datos.nombre,
        rol: 'propietario',
        phone: datos.phone || '',
        documentType: datos.documentType || '',
        documentNumber: datos.documentNumber || '',
        conjunto,
        parcela: datos.parcela || '',
        authEmailSintetico: true,
        loginCon,
        // Sin password → el servicio usará AUTH_TEMP_PASSWORD y marcará mustChangePassword.
      });
      if (!result.success) return { success: false, message: result.message };

      this.activity?.log({
        vista: accion === 'Autoregistro' ? 'Se registró por QR' : 'Aprobó registro por QR',
        usuario: actor || usuario,
        conjunto,
        detalle: { accion, recurso: 'Propietario', nombre: datos.nombre, usuario },
      });
      return { success: true, usuario };
    } catch (err: any) {
      this.logger.error(`[invite] crearPropietario: ${err?.message}`);
      return { success: false, message: err?.message || 'No se pudo crear la cuenta.' };
    }
  }

  // ---------------------------------------------------------------------------
  // 1b. Solicitudes de registro (aprobación del administrador)
  // ---------------------------------------------------------------------------

  private solicitudesRef(conjunto: string, id = '') {
    return this.firebase.db().ref(`${SOLICITUDES_PATH}/${this.safeKey(conjunto.toLowerCase())}${id ? `/${id}` : ''}`);
  }

  private async todasSolicitudes(conjunto: string): Promise<SolicitudRegistro[]> {
    const snap = await this.solicitudesRef(conjunto).get();
    const v = snap.exists() ? (snap.val() as Record<string, SolicitudRegistro>) : {};
    return Object.entries(v || {}).map(([id, s]) => ({ ...(s as any), id }));
  }

  private async crearSolicitud(conjunto: string, datos: DatosSolicitud): Promise<{
    success: boolean; pendiente?: boolean; conjunto?: string; message?: string;
  }> {
    if (!this.firebase.isEnabled()) return { success: false, message: 'Servicio no disponible.' };
    try {
      const todas = await this.todasSolicitudes(conjunto);
      const pendientes = todas.filter((s) => s.estado === 'pendiente');
      if (solicitudRepetida(datos, pendientes)) {
        return {
          success: true, pendiente: true, conjunto,
          message: 'Ya tienes una solicitud enviada. La administración la revisará pronto.',
        };
      }
      if (pendientes.length >= MAX_PENDIENTES) {
        return { success: false, message: 'Hay demasiadas solicitudes pendientes. Comunícate con la administración.' };
      }
      const ref = this.solicitudesRef(conjunto).push();
      const solicitud: Omit<SolicitudRegistro, 'id'> = {
        ...datos,
        conjunto,
        estado: 'pendiente',
        creadaEn: new Date().toISOString(),
      };
      await ref.set(solicitud);
      this.activity?.log({
        vista: 'Solicitó registro por QR',
        usuario: datos.nombre,
        conjunto,
        detalle: { accion: 'Solicitud', recurso: 'Propietario', nombre: datos.nombre, unidad: datos.parcela },
      });
      return {
        success: true, pendiente: true, conjunto,
        message: 'Tu solicitud fue enviada. Cuando la administración la apruebe te llegarán tus datos de acceso.',
      };
    } catch (err: any) {
      this.logger.error(`[invite] crearSolicitud: ${err?.message}`);
      return { success: false, message: 'No se pudo enviar tu solicitud. Intenta de nuevo.' };
    }
  }

  /** Solicitudes del conjunto (por defecto solo pendientes) con advertencias para revisar. */
  async listarSolicitudes(conjunto: string, estado: EstadoSolicitud | 'todas' = 'pendiente'): Promise<{
    success: boolean;
    data: Array<SolicitudRegistro & { advertencias: Advertencia[] }>;
    message?: string;
  }> {
    if (!this.firebase.isEnabled()) return { success: false, data: [], message: 'Servicio no disponible.' };
    try {
      const [todas, usuarios] = await Promise.all([this.todasSolicitudes(conjunto), this.users.list(conjunto)]);
      const data = todas
        .filter((s) => estado === 'todas' || s.estado === estado)
        .sort((a, b) => String(b.creadaEn || '').localeCompare(String(a.creadaEn || '')))
        .map((s) => ({ ...s, advertencias: s.estado === 'pendiente' ? advertencias(s, usuarios) : [] }));
      return { success: true, data };
    } catch (err: any) {
      this.logger.error(`[invite] listarSolicitudes: ${err?.message}`);
      return { success: false, data: [], message: err?.message };
    }
  }

  /**
   * Aprueba: crea la cuenta (con los cambios del admin, si los hay) y envía las
   * credenciales por WhatsApp. Sin teléfono (o sin WhatsApp conectado) devuelve
   * un acceso temporal para que el admin lo comunique.
   */
  async aprobarSolicitud(conjunto: string, id: string, cambios: Partial<DatosSolicitud> | undefined, actor: string): Promise<{
    success: boolean;
    usuario?: string;
    enviadoPorWhatsapp?: boolean;
    credenciales?: { usuario: string; password: string; acceso?: { etiqueta: string; valor: string } };
    message?: string;
  }> {
    if (!this.firebase.isEnabled()) return { success: false, message: 'Servicio no disponible.' };
    const ref = this.solicitudesRef(conjunto, this.safeKey(id));
    const snap = await ref.get();
    if (!snap.exists()) return { success: false, message: 'La solicitud no existe.' };
    const s = snap.val() as SolicitudRegistro;
    if (s.estado !== 'pendiente') return { success: false, message: `La solicitud ya fue ${s.estado}.` };

    const datos = limpiarDatos({ ...s, ...(cambios || {}) });
    if (!datos.nombre) return { success: false, message: 'El nombre es obligatorio.' };
    const loginCon = normLoginCon((cambios as any)?.loginCon) || loginConPorDefecto(datos);
    const falta = validarLoginCon(loginCon, datos);
    if (falta) return { success: false, message: falta };

    // Marca primero (evita que dos admins la aprueben a la vez y queden 2 cuentas).
    const tx = await ref.child('estado').transaction((e: any) => (e === 'pendiente' || e === null ? 'aprobando' : undefined));
    if (!tx.committed) return { success: false, message: 'Otra persona ya está resolviendo esta solicitud.' };

    const r = await this.crearPropietario(conjunto, datos, 'Aprobó registro', actor, loginCon);
    if (!r.success || !r.usuario) {
      await ref.update({ estado: 'pendiente' });
      return { success: false, message: r.message || 'No se pudo crear la cuenta.' };
    }
    await ref.update({
      ...datos,
      estado: 'aprobada',
      usuario: r.usuario,
      resueltaPor: actor,
      resueltaEn: new Date().toISOString(),
    });

    let enviado = false;
    if (normTelefono(datos.phone).length >= 7) {
      const env = await this.sendCredentials(r.usuario, conjunto).catch(() => ({ success: false }));
      enviado = !!env.success;
    }
    if (enviado) {
      return { success: true, usuario: r.usuario, enviadoPorWhatsapp: true, message: `Cuenta creada. Le enviamos sus datos de acceso por WhatsApp.` };
    }
    const temp = await this.generateTempAccess(r.usuario);
    return {
      success: true,
      usuario: r.usuario,
      enviadoPorWhatsapp: false,
      credenciales: temp.success && temp.password ? { usuario: r.usuario, password: temp.password, acceso: temp.acceso } : undefined,
      message: 'Cuenta creada. Compártele sus datos de acceso.',
    };
  }

  /** Rechaza la solicitud y, si dejó teléfono, le avisa por WhatsApp. */
  async rechazarSolicitud(conjunto: string, id: string, motivo: string | undefined, actor: string): Promise<{ success: boolean; message?: string }> {
    if (!this.firebase.isEnabled()) return { success: false, message: 'Servicio no disponible.' };
    const ref = this.solicitudesRef(conjunto, this.safeKey(id));
    const snap = await ref.get();
    if (!snap.exists()) return { success: false, message: 'La solicitud no existe.' };
    const s = snap.val() as SolicitudRegistro;
    if (s.estado !== 'pendiente') return { success: false, message: `La solicitud ya fue ${s.estado}.` };
    const m = String(motivo || '').trim().slice(0, 300);
    await ref.update({ estado: 'rechazada', motivo: m, resueltaPor: actor, resueltaEn: new Date().toISOString() });
    this.activity?.log({
      vista: 'Rechazó registro por QR',
      usuario: actor,
      conjunto,
      detalle: { accion: 'Rechazó registro', recurso: 'Propietario', nombre: s.nombre, motivo: m },
    });
    const tel = String(s.phone || '').replace(/\D/g, '');
    if (tel.length >= 7) {
      const texto =
        `Hola ${String(s.nombre || '').split(' ')[0]}, la administración de *${conjunto}* no aprobó tu registro en GoPase` +
        (m ? `:\n\n_${m}_` : '.') +
        `\n\nSi crees que es un error, comunícate con la administración.`;
      await this.whatsapp.sendMessage(tel, texto, conjunto).catch(() => false);
    }
    return { success: true, message: 'Solicitud rechazada.' };
  }

  // --- Configuración: ¿los registros por QR requieren aprobación? ---

  private async findConjunto(conjunto: string): Promise<{ key: string; value: any } | null> {
    const t = String(conjunto || '').trim().toLowerCase();
    if (!t || !this.firebase.isEnabled()) return null;
    const all = (await this.firebase.liveVal<Record<string, any>>(MIRROR_CONJUNTOS)) || {};
    for (const [key, value] of Object.entries(all)) {
      const v = value as any;
      if (String(v?.nombre ?? '').trim().toLowerCase() === t || String(v?.id ?? '').trim().toLowerCase() === t || key.toLowerCase() === t) {
        return { key, value };
      }
    }
    return null;
  }

  async getRegistroConfig(conjunto: string): Promise<{ requiereAprobacion: boolean }> {
    const c = await this.findConjunto(conjunto);
    return { requiereAprobacion: requiereAprobacion(c?.value) };
  }

  async setRegistroConfig(conjunto: string, requiere: boolean): Promise<{ success: boolean; requiereAprobacion?: boolean; message?: string }> {
    const c = await this.findConjunto(conjunto);
    if (!c) return { success: false, message: 'El conjunto no existe.' };
    await this.firebase.db().ref(`${MIRROR_CONJUNTOS}/${c.key}`).update({ registroQr: { requiereAprobacion: !!requiere }, _fbWrite: true });
    return {
      success: true,
      requiereAprobacion: !!requiere,
      message: requiere ? 'Los registros por QR quedarán pendientes de tu aprobación.' : 'Los registros por QR crearán la cuenta de inmediato.',
    };
  }

  // ---------------------------------------------------------------------------
  // 2. Usuarios que nunca han ingresado + envío de credenciales
  // ---------------------------------------------------------------------------

  /**
   * Lista los usuarios del conjunto que nunca han iniciado sesión.
   * Cruza mirror/usuarios con session_summaries del RTDB de auditoría.
   * Si el módulo de auditoría no está activo, devuelve todos como "sin sesión conocida".
   */
  async neverLoggedIn(conjunto: string): Promise<{
    success: boolean;
    data: Array<{ usuario: string; nombre: string; phone: string; email: string; createdAt: string }>;
    message?: string;
  }> {
    if (!this.firebase.isEnabled()) return { success: false, data: [], message: 'Servicio no disponible.' };
    const conjuntoTrim = String(conjunto || '').trim();

    try {
      // Todos los usuarios del conjunto.
      const allUsers = await this.users.list(conjuntoTrim);
      const candidates = allUsers.filter((u: any) =>
        // Solo roles que deben iniciar sesión (excluye superAdmin).
        ['propietario', 'admin', 'vigilante', ''].includes(String(u.rol || u.dato_5 || '').toLowerCase()),
      );

      // Leer session_summaries del RTDB de auditoría (proyecto separado).
      const auditDb = await this.getAuditDb();
      const loggedSet = new Set<string>();
      if (auditDb) {
        const snap = await auditDb.ref('session_summaries').get();
        if (snap.exists()) {
          const all = snap.val() as Record<string, any>;
          for (const key of Object.keys(all)) {
            const s = all[key];
            if ((s.sesionesIniciadas || 0) > 0) {
              // La clave puede ser el username saneado o el username directo.
              loggedSet.add(key.toLowerCase());
              if (s.usuario) loggedSet.add(String(s.usuario).toLowerCase());
            }
          }
        }
      }

      const neverLogged = candidates.filter((u: any) => {
        const usr = String(u.usuario || u.dato_1 || '').toLowerCase();
        return !loggedSet.has(usr) && !loggedSet.has(this.safeKey(usr));
      });

      return {
        success: true,
        data: neverLogged.map((u: any) => ({
          usuario: u.usuario || u.dato_1 || '',
          nombre: u.nombre || u.dato_4 || '',
          phone: u.phone || u.dato_8 || '',
          email: u.email || u.dato_2 || '',
          createdAt: u.createdAt || '',
        })),
      };
    } catch (err: any) {
      this.logger.error(`[invite] neverLoggedIn: ${err?.message}`);
      return { success: false, data: [], message: err?.message };
    }
  }

  /**
   * Genera una contraseña temporal nueva y la envía por WhatsApp al propietario.
   * Siempre hace un reset — nunca expone la contraseña actual.
   * Al recibirla, el propietario la usa para entrar y el modal la obliga a cambiar.
   */
  async sendCredentials(username: string, conjunto: string): Promise<{
    success: boolean;
    message?: string;
  }> {
    if (!this.firebase.isEnabled()) return { success: false, message: 'Servicio no disponible.' };

    const key = this.safeKey(username);
    const snap = await this.firebase.db().ref(`${MIRROR_USERS}/${key}`).get();
    if (!snap.exists()) return { success: false, message: 'Usuario no encontrado.' };

    const user = snap.val();
    const phone = String(user.phone || '').replace(/\D/g, '');
    if (!phone || phone.length < 7) {
      return { success: false, message: 'El usuario no tiene número de teléfono registrado.' };
    }

    // 1. Genera contraseña temporal nueva (reset seguro, no expone la actual).
    const tempResult = await this.generateTempAccess(username);
    if (!tempResult.success || !tempResult.password) {
      return { success: false, message: tempResult.message || 'No se pudo generar la contraseña temporal.' };
    }
    const password = tempResult.password;

    // 2. Envía por WhatsApp con la contraseña recién generada.
    const nombre = String(user.nombre || username);
    const appUrl = this.frontendUrl;
    // Con qué entra (cédula, correo o usuario, según lo que escogió la administración).
    const acceso = textoAcceso({ ...user, usuario: username });
    const mensaje =
      `¡Hola ${nombre}! 👋\n\n` +
      `Te compartimos tus datos de acceso a *GoPase* para el conjunto *${conjunto}*:\n\n` +
      `👤 *${acceso.etiqueta}:* ${acceso.valor}\n` +
      `🔑 *Contraseña temporal:* ${password}\n\n` +
      `Ingresa aquí: ${appUrl}\n\n` +
      `_Al entrar por primera vez se te pedirá crear una contraseña nueva._`;

    const ok = await this.whatsapp.sendMessage(phone, mensaje, conjunto);
    if (ok) {
      this.logger.log(`[invite] credenciales enviadas a ${username} (${phone})`);
      this.activity?.log({
        vista: 'Envió credenciales por WhatsApp',
        usuario: username,
        conjunto,
        detalle: { accion: 'Envió', recurso: 'Credenciales', destinatario: username },
      });
    }
    return {
      success: ok,
      message: ok ? 'Credenciales enviadas por WhatsApp.' : 'WhatsApp no está conectado o el número no es válido.',
    };
  }

  // ---------------------------------------------------------------------------
  // 3. Generar acceso temporal (reset controlado por el admin)
  // ---------------------------------------------------------------------------

  /**
   * El admin solicita un acceso temporal para un propietario sin teléfono
   * (o para cualquier propietario que necesite sus credenciales).
   * Genera una contraseña aleatoria segura, la establece en Firebase Auth
   * y la devuelve UNA SOLA VEZ al admin. El propietario debe cambiarla al entrar.
   *
   * NO expone la contraseña actual del usuario — siempre es un reset.
   * Solo aplica a propietarios del mismo conjunto del admin (el backend
   * no verifica esto; es responsabilidad del caller respetar la restricción
   * ya que el endpoint está protegido por JWT del admin).
   */
  async generateTempAccess(username: string): Promise<{
    success: boolean;
    usuario?: string;
    password?: string;
    /** Con qué debe entrar: { etiqueta: 'Cédula', valor: '1020304' }. */
    acceso?: { etiqueta: string; valor: string };
    message?: string;
  }> {
    if (!this.firebase.isEnabled()) return { success: false, message: 'Servicio no disponible.' };
    const key = this.safeKey(username);

    // Verificar que el usuario existe.
    const snap = await this.firebase.db().ref(`${MIRROR_USERS}/${key}`).get();
    if (!snap.exists()) return { success: false, message: 'Usuario no encontrado.' };

    // Generar contraseña aleatoria segura (12 chars: letras + números + símbolo).
    const password = this.generateSecurePassword();

    try {
      const auth = this.firebase.auth();
      await auth.updateUser(key, { password });
      // Forzar cambio de contraseña en el primer ingreso.
      const record = await auth.getUser(key);
      await auth.setCustomUserClaims(key, {
        ...(record.customClaims || {}),
        mustChangePassword: true,
      });

      this.logger.log(`[invite] acceso temporal generado para ${username} por el admin.`);
      this.activity?.log({
        vista: 'Generó acceso temporal',
        usuario: username,
        detalle: { accion: 'Reseteo', recurso: 'Contraseña temporal', porAdmin: true },
      });

      return { success: true, usuario: username, password, acceso: textoAcceso({ ...snap.val(), usuario: username }) };
    } catch (err: any) {
      this.logger.error(`[invite] generateTempAccess ${key}: ${err?.message}`);
      return { success: false, message: err?.message || 'No se pudo generar el acceso.' };
    }
  }

  /**
   * Genera una contraseña aleatoria de 12 caracteres.
   * Formato: Xxxxxx00! (mayúscula + minúsculas + números + símbolo) para cumplir políticas.
   */
  private generateSecurePassword(): string {
    const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    const lower = 'abcdefghjkmnpqrstuvwxyz';
    const digits = '23456789';
    const symbols = '!@#$%&*';
    const all = upper + lower + digits + symbols;
    const rand = (chars: string) => chars[Math.floor(Math.random() * chars.length)];
    // Garantiza al menos uno de cada tipo.
    const parts = [rand(upper), rand(lower), rand(lower), rand(lower), rand(digits), rand(digits), rand(symbols)];
    // Rellena hasta 12 con caracteres aleatorios del conjunto completo.
    while (parts.length < 12) parts.push(rand(all));
    // Mezcla para que los tipos no queden en posición fija.
    return parts.sort(() => Math.random() - 0.5).join('');
  }

  private generarUsuarioBase(nombre: string): string {
    return String(nombre || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');
  }

  private async usuarioDisponible(base: string, conjunto: string): Promise<string> {
    const allUsers = await this.users.list(conjunto).catch(() => [] as any[]);
    const existentes = new Set(
      allUsers.map((u: any) => String(u.usuario || u.dato_1 || '').toLowerCase()),
    );
    if (!existentes.has(base)) return base;
    for (let i = 2; i <= 99; i++) {
      const candidate = `${base}${i}`;
      if (!existentes.has(candidate)) return candidate;
    }
    return `${base}${Date.now()}`;
  }

  /** Obtiene la instancia de Database del proyecto de auditoría (proyecto Firebase separado). */
  private async getAuditDb() {
    try {
      const { resolveAuditApp, auditDatabase } = await import(
        '../activity-audit/adapters/rtdb/audit-firebase.provider'
      );
      const serviceAccountJson = this.config.get<string>('AUDIT_FIREBASE_SERVICE_ACCOUNT');
      const databaseURL = this.config.get<string>('AUDIT_FIREBASE_DATABASE_URL');
      if (!databaseURL) return null;
      const app = resolveAuditApp({
        serviceAccountJson,
        projectId: this.config.get('AUDIT_FIREBASE_PROJECT_ID'),
        clientEmail: this.config.get('AUDIT_FIREBASE_CLIENT_EMAIL'),
        privateKey: this.config.get('AUDIT_FIREBASE_PRIVATE_KEY'),
        databaseURL,
      });
      return auditDatabase(app);
    } catch {
      return null;
    }
  }
}
