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
        this.logger.debug(`Login fallido para ${user}: ${code}`);
        return { success: false, message: 'Credenciales incorrectas' };
      }
      uid = data.localId;
    } catch (err: any) {
      this.logger.error(`Error validando login de ${user}: ${err?.message}`);
      return { success: false, message: 'Error de conexión con el servicio de autenticación.' };
    }

    // 2. Leer perfil y claims con firebase-admin (uid = username).
    try {
      const record = await this.firebase.auth().getUser(uid);
      const claims = (record.customClaims || {}) as Record<string, any>;
      return {
        success: true,
        user: {
          username: uid,
          uid,
          email: record.email || email,
          nombre: record.displayName || '',
          rol: claims.rol || '',
          conjuntoId: claims.conjuntoId || '',
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
