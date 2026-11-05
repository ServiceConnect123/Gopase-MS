import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { FirebaseService } from '../firebase/firebase.service';
import { recoverPassword } from './password.util';
import { validatePasswordPolicy } from './password-policy.util';
import { SessionTracker } from '../activity-audit/core/session-tracker';
import { ActivityLogger } from '../activity-audit/core/activity-logger';
import { SESSION_TRACKER, ACTIVITY_LOGGER } from '../activity-audit/integrations/nest/activity-audit.tokens';
import { BillingService } from '../billing/billing.service';

/**
 * Login por backend contra Firebase Auth (estrategia A1).
 *
 * El cliente envía { username, passwordEnc } donde passwordEnc está cifrado con
 * el mismo esquema XOR+IV del frontend (encriptarAES). El backend:
 *   1. Descifra la contraseña.
 *   2. Convierte username -> {username}@AUTH_EMAIL_DOMAIN.
 *   3. Valida contra Firebase Auth vía REST identitytoolkit (necesita la Web API Key).
 *   4. Lee los custom claims (rol, conjuntoId, mustChangePassword) con firebase-admin.
 *   5. Devuelve el usuario SIN la contraseña.
 *
 * firebase-admin NO puede verificar contraseñas; por eso se usa la REST API de
 * Firebase Auth (signInWithPassword) con FIREBASE_WEB_API_KEY.
 */
export interface LoginResult {
  success: boolean;
  message?: string;
  user?: {
    username: string;
    uid: string;
    email: string;
    nombre?: string;
    rol?: string;
    conjuntoId?: string;
    /** Nombre del conjunto de este usuario (la app lo usa como "complex"). */
    conjunto?: string;
    /**
     * Conjuntos de la MISMA persona (mismo correo), cada uno con su usuario y rol
     * propios. Para el selector "cambiar de conjunto" (pide la clave de ese
     * usuario). Cualquier rol: puede ser propietario en uno y admin en otro.
     */
    accesos?: Array<{ conjunto: string; usuario: string; rol: string }>;
    mustChangePassword?: boolean;
    /** JWT de sesión que el frontend adjunta como Bearer en las demás llamadas. */
    token?: string;
    /** Estado de suscripción del conjunto del usuario. */
    suscripcion?: {
      alDia: boolean;
      bloqueado: boolean;
      pagadoHasta: string;
      /** Si el conjunto está bloqueado pero el usuario es admin: 'facturacion'. */
      accesoRestringido?: 'facturacion' | '';
      /** Prueba gratis (autoregistro): true mientras no haya un pago confirmado. */
      trial?: boolean;
      trialHasta?: string;
      /** Días que quedan de prueba (0 si no aplica o ya venció). */
      diasRestantes?: number;
      /** Día en que le toca pagar y último día con acceso (después se corta). */
      fechaPago?: string;
      vencimiento?: string;
      /** Debe pagar pero aún conserva el acceso (dentro de los días de gracia). */
      enGracia?: boolean;
    };
  };
}

@Injectable()
export class AuthLoginService {
  private readonly logger = new Logger(AuthLoginService.name);
  private readonly emailDomain: string;
  private readonly webApiKey: string;

  constructor(
    private readonly firebase: FirebaseService,
    private readonly config: ConfigService,
    private readonly jwt: JwtService,
    private readonly billing: BillingService,
    // Opcional: si el módulo de auditoría no estuviera registrado, el login
    // sigue funcionando igual (sin métricas de sesión ni evento de actividad).
    @Optional() @Inject(SESSION_TRACKER) private readonly sessionTracker?: SessionTracker,
    @Optional() @Inject(ACTIVITY_LOGGER) private readonly activity?: ActivityLogger,
  ) {
    this.emailDomain = this.config.get<string>('AUTH_EMAIL_DOMAIN', 'gopase.local');
    this.webApiKey = this.config.get<string>('FIREBASE_WEB_API_KEY', '');
  }

  private usernameToEmail(username: string): string {
    const local = String(username || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]/g, '_');
    return `${local}@${this.emailDomain}`;
  }

  /**
   * Accesos que comparten el correo del usuario: cada conjunto en el que esa
   * MISMA persona tiene una cuenta, con su usuario y rol propios. Es lo que la
   * app usa para el selector "cambiar de conjunto" (al elegir otro, pide la clave
   * de ESE usuario). Aplica a cualquier rol: alguien puede ser propietario en un
   * conjunto y administrador en otro. Sin correo => sin accesos (no se agrupa).
   */
  private async accesosPorCorreo(
    email: string,
  ): Promise<Array<{ conjunto: string; usuario: string; rol: string }>> {
    const correo = String(email || '').trim().toLowerCase();
    if (!correo) return [];
    try {
      const snap = await this.firebase.db().ref('mirror/usuarios').get();
      if (!snap.exists()) return [];
      const all = snap.val() || {};
      const out: Array<{ conjunto: string; usuario: string; rol: string }> = [];
      for (const key of Object.keys(all)) {
        const u = all[key] || {};
        if (
          String(u.email || '').trim().toLowerCase() === correo &&
          String(u.conjunto || '').trim()
        ) {
          out.push({
            conjunto: String(u.conjunto),
            usuario: String(u.usuario || key),
            rol: String(u.rol || ''),
          });
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  /** Correo real del usuario (perfil RTDB). En Auth el email es sintético. */
  private async emailDePerfil(uid: string): Promise<string> {
    try {
      const safe = String(uid || '').trim().replace(/[.#$/\[\]]/g, '_');
      const snap = await this.firebase.db().ref(`mirror/usuarios/${safe}/email`).get();
      return snap.exists() ? String(snap.val() || '') : '';
    } catch {
      return '';
    }
  }

  /**
   * Resuelve el nombre del conjunto a partir de su id, leyendo del espejo
   * mirror/conjuntos del RTDB. Devuelve '' si no se encuentra (best-effort).
   */
  private async resolveConjuntoNombre(conjuntoId: string): Promise<string> {
    if (!conjuntoId) return '';
    try {
      const snap = await this.firebase
        .db()
        .ref(`mirror/conjuntos/${conjuntoId}/nombre`)
        .get();
      return snap.exists() ? String(snap.val() || '') : '';
    } catch {
      return '';
    }
  }

  /**
   * Valida credenciales y devuelve el usuario. `passwordEnc` va cifrado (XOR);
   * si se pasa `password` en claro (no recomendado) también se acepta.
   */
  async login(username: string, passwordEnc?: string, passwordPlain?: string): Promise<LoginResult> {
    const user = (username || '').toString().trim();
    if (!user) return { success: false, message: 'Usuario requerido' };

    const password = passwordPlain
      ? passwordPlain.toString()
      : recoverPassword((passwordEnc || '').toString());
    if (!password) return { success: false, message: 'Contraseña requerida' };

    if (!this.firebase.isEnabled()) {
      return { success: false, message: 'Servicio de autenticación no disponible.' };
    }
    if (!this.webApiKey) {
      this.logger.error('FIREBASE_WEB_API_KEY no configurada: no se puede validar el login.');
      return { success: false, message: 'Servicio de autenticación mal configurado.' };
    }

    const email = this.usernameToEmail(user);

    // 1. Validar la contraseña contra Firebase Auth (REST identitytoolkit).
    let uid: string;
    try {
      const resp = await fetch(
        `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${this.webApiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password, returnSecureToken: false }),
        },
      );
      const data: any = await resp.json();
      if (!resp.ok) {
        // Errores típicos: EMAIL_NOT_FOUND, INVALID_PASSWORD, INVALID_LOGIN_CREDENTIALS.
        const code = data?.error?.message || 'INVALID_CREDENTIALS';
        // Diagnóstico SIN exponer la contraseña: email construido, código de
        // Firebase y longitud de la clave descifrada.
        this.logger.warn(
          `[login] rechazado email=${email} fbCode=${code} passLen=${password.length}`,
        );
        return { success: false, message: 'Credenciales incorrectas' };
      }
      uid = data.localId;
    } catch (err: any) {
      this.logger.error(`Error validando login de ${user}: ${err?.message}`);
      return { success: false, message: 'Error de conexión con el servicio de autenticación.' };
    }

    return this.buildUserResponse(uid, email);
  }

  /**
   * Cambia la contraseña de un usuario directamente (vía firebase-admin, sin
   * correo). Útil porque los emails son sintéticos y el flujo de "recuperar por
   * correo" no aplica. Al cambiarla, limpia el claim mustChangePassword.
   */
  async setPassword(username: string, newPassword: string): Promise<{ success: boolean; message?: string }> {
    const user = (username || '').toString().trim();
    if (!user) return { success: false, message: 'Usuario requerido' };
    const policyError = validatePasswordPolicy(newPassword);
    if (policyError) {
      return { success: false, message: policyError };
    }
    if (!this.firebase.isEnabled()) {
      return { success: false, message: 'Servicio de autenticación no disponible.' };
    }

    try {
      const auth = this.firebase.auth();
      // uid = username. Actualiza la contraseña.
      await auth.updateUser(user, { password: newPassword });
      // Quitar la marca de cambio obligatorio (preservando el resto de claims).
      const record = await auth.getUser(user);
      const claims = { ...(record.customClaims || {}) } as Record<string, any>;
      if (claims.mustChangePassword) {
        delete claims.mustChangePassword;
        await auth.setCustomUserClaims(user, claims);
      }
      return { success: true, message: 'Contraseña actualizada.' };
    } catch (err: any) {
      this.logger.warn(`[set-password] ${user} falló: ${err?.message}`);
      const notFound = /no user record|user-not-found/i.test(err?.message || '');
      return {
        success: false,
        message: notFound ? 'El usuario no existe.' : (err?.message || 'No se pudo actualizar la contraseña.'),
      };
    }
  }

  /** Arma la respuesta de usuario (perfil + claims + nombre del conjunto). */
  private async buildUserResponse(uid: string, email: string): Promise<LoginResult> {
    try {
      const record = await this.firebase.auth().getUser(uid);
      const claims = (record.customClaims || {}) as Record<string, any>;
      const conjuntoId = claims.conjuntoId || '';
      const rol = String(claims.rol || '').trim();
      // Resolver el NOMBRE del conjunto (la app usa el nombre como "complex").
      const conjuntoNombre = await this.resolveConjuntoNombre(conjuntoId);

      // Accesos de la MISMA persona (mismo correo), uno por conjunto donde tiene
      // cuenta, para el selector de "cambiar de conjunto". Cualquier rol (puede
      // ser propietario en uno y admin en otro). El correo real se lee del perfil
      // (en Auth el email es sintético).
      const emailPerfil = await this.emailDePerfil(uid);
      const accesos = await this.accesosPorCorreo(emailPerfil);

      // ----- Control de pago SaaS (suscripción del conjunto) -----
      // El superAdmin nunca se bloquea. Para los demás, si el conjunto está
      // bloqueado por falta de pago:
      //   - admin del conjunto: puede entrar, pero SOLO a Facturación (para pagar).
      //   - propietario/vigilante/otros: login rechazado (suspensión por pago).
      const esSuperAdmin = rol.toLowerCase() === 'superadmin';
      let suscripcion:
        | NonNullable<NonNullable<LoginResult['user']>['suscripcion']>
        | undefined;
      if (!esSuperAdmin && conjuntoNombre) {
        try {
          const est = await this.billing.getEstadoSuscripcion(conjuntoNombre);
          const esAdmin = rol.toLowerCase() === 'admin';
          if (est.bloqueado && !esAdmin) {
            // Propietario/vigilante: no entra mientras el conjunto esté suspendido.
            this.logger.warn(`[login] bloqueado por suscripción: usuario=${uid} conjunto=${conjuntoNombre} rol=${rol}`);
            return {
              success: false,
              message:
                'El conjunto está suspendido por falta de pago. Contacta al administrador para regularizar la suscripción.',
            };
          }
          suscripcion = {
            alDia: est.alDia,
            bloqueado: est.bloqueado,
            pagadoHasta: est.pagadoHasta,
            accesoRestringido: est.bloqueado && esAdmin ? 'facturacion' : '',
            trial: est.trial,
            trialHasta: est.trialHasta,
            diasRestantes: est.diasRestantes,
            fechaPago: est.fechaPago,
            vencimiento: est.vencimiento,
            enGracia: est.enGracia,
          };
        } catch (e: any) {
          // Fail-open: si no se puede evaluar la suscripción, no bloqueamos el login.
          this.logger.warn(`[login] no se pudo evaluar suscripción de ${conjuntoNombre}: ${e?.message}`);
        }
      }

      // Métrica de sesión: login exitoso, con el conjunto ya resuelto.
      // Fire-and-forget: NO bloquea ni rompe el login aunque la auditoría falle.
      this.sessionTracker?.trackLogin(uid, conjuntoNombre || undefined);
      // Evento de actividad "Inició sesión" para que el login también aparezca
      // en la pestaña Actividad del monitoreo (no solo en el conteo de Sesiones).
      this.activity?.log({
        vista: 'Inició sesión',
        usuario: uid,
        conjunto: conjuntoNombre || undefined,
        detalle: { accion: 'Sesión', recurso: 'Inicio de sesión', rol: claims.rol || '' },
      });
      // JWT de sesión: identidad + rol + conjunto (el guard lo verifica).
      // `suspendido`: el conjunto entró sin pagar. El admin puede navegar pero
      // en SOLO LECTURA (el ReadOnlyGuard bloquea sus escrituras). Se calcula
      // aquí para no consultar la suscripción en cada request.
      const suspendido = suscripcion?.bloqueado === true;
      const token = this.jwt.sign({ sub: uid, rol: claims.rol || '', conjuntoId, suspendido });
      return {
        success: true,
        user: {
          username: uid,
          uid,
          email: record.email || email,
          nombre: record.displayName || '',
          rol: claims.rol || '',
          conjuntoId,
          conjunto: conjuntoNombre,
          accesos,
          mustChangePassword: !!claims.mustChangePassword,
          token,
          suscripcion,
        },
      };
    } catch (err: any) {
      this.logger.error(`Login OK pero no se pudo leer el usuario ${uid}: ${err?.message}`);
      // La contraseña era válida: registra el login igual (sin conjunto).
      this.sessionTracker?.trackLogin(uid);
      this.activity?.log({
        vista: 'Inició sesión',
        usuario: uid,
        detalle: { accion: 'Sesión', recurso: 'Inicio de sesión' },
      });
      // devolvemos lo mínimo aunque falle la lectura de claims (token con solo uid).
      const token = this.jwt.sign({ sub: uid });
      return {
        success: true,
        user: { username: uid, uid, email, token },
      };
    }
  }
}
