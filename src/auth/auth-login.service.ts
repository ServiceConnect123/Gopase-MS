import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FirebaseService } from '../firebase/firebase.service';
import { recoverPassword } from './password.util';

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
    /** Nombre del conjunto (la app lo usa como "complex"). */
    conjunto?: string;
    mustChangePassword?: boolean;
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
    if (!newPassword || newPassword.length < 6) {
      return { success: false, message: 'La contraseña debe tener al menos 6 caracteres.' };
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
      // Resolver el NOMBRE del conjunto (la app usa el nombre como "complex").
      const conjuntoNombre = await this.resolveConjuntoNombre(conjuntoId);
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
          mustChangePassword: !!claims.mustChangePassword,
        },
      };
    } catch (err: any) {
      this.logger.error(`Login OK pero no se pudo leer el usuario ${uid}: ${err?.message}`);
      // La contraseña era válida; devolvemos lo mínimo aunque falle la lectura de claims.
      return {
        success: true,
        user: { username: uid, uid, email },
      };
    }
  }
}
