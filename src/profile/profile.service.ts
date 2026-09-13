import { Injectable, Logger } from '@nestjs/common';
import { FirebaseService } from '../firebase/firebase.service';

/**
 * Perfil de usuario: LEE y ESCRIBE en Firebase (RTDB + Auth). NO usa Sheets.
 *
 * - Lectura: mirror/usuarios/{username} en el Realtime Database.
 * - Escritura: actualiza el perfil en RTDB, el displayName en Firebase Auth y,
 *   si viene contraseña nueva, la cambia en Auth (limpiando mustChangePassword).
 *
 * Los campos editables por el perfil (nombre, email, phone, docType, docNum,
 * parcela, placa1, placa2) son la fuente de verdad en Firebase; la sync
 * Sheets->RTDB los preserva (ver writeMirrorUsuarios en SyncService).
 */
export interface ProfileData {
  username: string;
  nombre?: string;
  email?: string;
  phone?: string;
  docType?: string;
  docNum?: string;
  rol?: string;
  conjunto?: string;
  conjuntoId?: string;
  parcela?: string;
  placa1?: string;
  placa2?: string;
}

const MIRROR_USERS = 'mirror/usuarios';

// Campos que el perfil puede modificar.
const EDITABLE_FIELDS = ['nombre', 'email', 'phone', 'docType', 'docNum', 'parcela', 'placa1', 'placa2'] as const;

@Injectable()
export class ProfileService {
  private readonly logger = new Logger(ProfileService.name);

  constructor(private readonly firebase: FirebaseService) {}

  private safeKey(username: string): string {
    return String(username || '').trim().replace(/[.#$/\[\]]/g, '_');
  }

  /** Lee el perfil desde el RTDB. Devuelve null si no existe. */
  async getProfile(username: string): Promise<ProfileData | null> {
    if (!this.firebase.isEnabled()) throw new Error('Servicio no disponible.');
    const key = this.safeKey(username);
    if (!key) return null;
    const snap = await this.firebase.db().ref(`${MIRROR_USERS}/${key}`).get();
    if (!snap.exists()) return null;
    const u = snap.val();
    return {
      username: u.usuario || u.id || username,
      nombre: u.nombre || '',
      email: u.email || '',
      phone: u.phone || '',
      docType: u.docType || '',
      docNum: u.docNum || '',
      rol: u.rol || '',
      conjunto: u.conjunto || '',
      conjuntoId: u.conjuntoId || '',
      parcela: u.parcela || '',
      placa1: u.placa1 || '',
      placa2: u.placa2 || '',
    };
  }

  /**
   * Actualiza el perfil en RTDB + Auth. Solo toca campos editables.
   * Si viene `newPassword` (>=6), la cambia en Auth y limpia mustChangePassword.
   */
  async updateProfile(
    username: string,
    changes: Partial<Record<(typeof EDITABLE_FIELDS)[number], string>>,
    newPassword?: string,
  ): Promise<{ success: boolean; message?: string; profile?: ProfileData | null }> {
    if (!this.firebase.isEnabled()) return { success: false, message: 'Servicio no disponible.' };
    const key = this.safeKey(username);
    if (!key) return { success: false, message: 'Usuario requerido' };

    try {
      const db = this.firebase.db();
      const ref = db.ref(`${MIRROR_USERS}/${key}`);
      const snap = await ref.get();
      if (!snap.exists()) return { success: false, message: 'El usuario no existe.' };

      // Solo persistir los campos editables presentes en `changes`.
      const patch: Record<string, string> = {};
      for (const f of EDITABLE_FIELDS) {
        const v = changes[f];
        if (v !== undefined) patch[f] = String(v);
      }
      if (Object.keys(patch).length > 0) {
        await ref.update(patch);
      }

      // Sincronizar Auth: displayName (nombre) y password si aplica.
      const auth = this.firebase.auth();
      if (patch.nombre !== undefined) {
        try {
          await auth.updateUser(key, { displayName: patch.nombre });
        } catch (e: any) {
          this.logger.warn(`[profile] no se pudo actualizar displayName de ${key}: ${e?.message}`);
        }
      }

      if (newPassword) {
        if (newPassword.length < 6) {
          return { success: false, message: 'La contraseña debe tener al menos 6 caracteres.' };
        }
        await auth.updateUser(key, { password: newPassword });
        const record = await auth.getUser(key);
        const claims = { ...(record.customClaims || {}) } as Record<string, any>;
        if (claims.mustChangePassword) {
          delete claims.mustChangePassword;
          await auth.setCustomUserClaims(key, claims);
        }
      }

      const profile = await this.getProfile(username);
      return { success: true, message: 'Perfil actualizado.', profile };
    } catch (err: any) {
      this.logger.error(`[profile] update ${key} falló: ${err?.message}`);
      return { success: false, message: err?.message || 'No se pudo actualizar el perfil.' };
    }
  }
}
