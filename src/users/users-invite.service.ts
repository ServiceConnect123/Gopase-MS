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

const MIRROR_USERS = 'mirror/usuarios';
const INVITE_TOKENS_PATH = 'mirror/inviteTokens'; // { conjunto_key: { token, createdAt, conjunto } }

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
    usuario?: string;
    password?: string;
    conjunto?: string;
    message?: string;
  }> {
    // Validar token.
    const validation = await this.validateInviteToken(token);
    if (!validation.valid || !validation.conjunto) {
      return { success: false, message: validation.message || 'Token inválido.' };
    }
    const conjunto = validation.conjunto;
    const nombre = String(data.nombre || '').trim();
    if (!nombre) return { success: false, message: 'El nombre es obligatorio.' };

    // Generar username único (igual que onboarding: NFD + sufijo si hace falta).
    const base = this.generarUsuarioBase(nombre);
    if (!base) return { success: false, message: 'El nombre debe contener letras o números.' };
    const usuario = await this.usuarioDisponible(base, conjunto);

    try {
      const result = await this.users.create({
        usuario,
        email: data.email || '',
        nombre,
        rol: 'propietario',
        phone: data.phone || '',
        documentType: data.documentType || '',
        documentNumber: data.documentNumber || '',
        conjunto,
        parcela: data.parcela || '',
        authEmailSintetico: true,
        // Sin password → el servicio usará AUTH_TEMP_PASSWORD y marcará mustChangePassword.
      });

      if (!result.success) {
        return { success: false, message: result.message };
      }

      this.activity?.log({
        vista: 'Se registró por QR',
        usuario,
        conjunto,
        detalle: { accion: 'Autoregistro', recurso: 'Propietario', nombre },
      });

      return {
        success: true,
        usuario,
        password: this.tempPassword,
        conjunto,
        message: 'Tu cuenta fue creada. Ingresa con las credenciales mostradas.',
      };
    } catch (err: any) {
      this.logger.error(`[invite] selfRegister: ${err?.message}`);
      return { success: false, message: err?.message || 'No se pudo crear la cuenta.' };
    }
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
   * Envía las credenciales de un usuario por WhatsApp.
   * La contraseña que se envía es la temporal (AUTH_TEMP_PASSWORD) porque no
   * podemos leer la contraseña real desde Firebase Auth (irreversible).
   * Si el usuario ya cambió su clave, el admin le puede generar una nueva desde
   * el menú "Cambiar contraseña" de owners.tsx antes de llamar a este endpoint.
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

    const nombre = String(user.nombre || username);
    const appUrl = this.frontendUrl;
    const mensaje =
      `¡Hola ${nombre}! 👋\n\n` +
      `Te compartimos tus datos de acceso a *GoPase* para el conjunto *${conjunto}*:\n\n` +
      `👤 *Usuario:* ${username}\n` +
      `🔑 *Contraseña:* ${this.tempPassword}\n\n` +
      `Ingresa aquí: ${appUrl}\n\n` +
      `_Por seguridad, te recomendamos cambiar tu contraseña al ingresar por primera vez._`;

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
  // Internals
  // ---------------------------------------------------------------------------

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
