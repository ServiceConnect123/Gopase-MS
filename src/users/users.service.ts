import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FirebaseService } from '../firebase/firebase.service';
import { recoverPassword } from '../auth/password.util';

/**
 * CRUD de usuarios contra Firebase (RTDB mirror/usuarios + Firebase Auth).
 * Reemplaza las escrituras del frontend a Google Sheets (addUser/updateUser/
 * deleteUser/getUsuarios). No usa Sheets.
 *
 * - RTDB mirror/usuarios/{username}: perfil (sin contraseña).
 * - Firebase Auth (uid=username): credenciales + custom claims (rol, conjuntoId).
 * - Registros escritos aquí se marcan con `_fbWrite: true` para que la sync
 *   Sheets->RTDB no los pise (ver writeMirrorUsuarios en SyncService).
 *
 * La contraseña llega cifrada (XOR, igual que el frontend) y se descifra con
 * recoverPassword antes de guardarla en Auth.
 */
export interface UserDTO {
  usuario?: string;
  originalUsername?: string;
  email?: string;
  password?: string; // cifrada (XOR) o vacía
  passwordModified?: boolean;
  nombre?: string;
  name?: string;
  rol?: string;
  role?: string;
  documentType?: string;
  docType?: string;
  documentNumber?: string;
  docNum?: string;
  phone?: string;
  conjunto?: string;
  complex?: string;
  parcela?: string;
  tower?: string;
  placa1?: string;
  placa2?: string;
  fechaIngreso?: string;
  conjuntoId?: string;
}

const MIRROR_USERS = 'mirror/usuarios';
const MIRROR_CONJUNTOS = 'mirror/conjuntos';

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);
  private readonly emailDomain: string;
  private readonly tempPassword: string;

  constructor(
    private readonly firebase: FirebaseService,
    private readonly config: ConfigService,
  ) {
    this.emailDomain = this.config.get<string>('AUTH_EMAIL_DOMAIN', 'gopase.local');
    this.tempPassword = this.config.get<string>('AUTH_TEMP_PASSWORD', 'Gopase2025*');
  }

  private safeKey(username: string): string {
    return String(username || '').trim().replace(/[.#$/\[\]]/g, '_');
  }

  /** username -> email sintético (igual que la migración de Auth). */
  private usernameToEmail(username: string): string {
    const local = String(username || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]/g, '_');
    return `${local}@${this.emailDomain}`;
  }

  /** Resuelve conjuntoId a partir del valor crudo (id o nombre) usando mirror/conjuntos. */
  private async resolveConjuntoId(rawConjunto: string): Promise<string> {
    const raw = String(rawConjunto || '').trim();
    if (!raw) return '';
    try {
      const snap = await this.firebase.db().ref(MIRROR_CONJUNTOS).get();
      if (!snap.exists()) return '';
      const norm = (s: unknown) => String(s ?? '').trim().toLowerCase();
      const conjuntos = Object.values(snap.val() || {}) as Array<{ id?: string; nombre?: string }>;
      for (const c of conjuntos) {
        if (norm(c.id) === norm(raw) || norm(c.nombre) === norm(raw)) return String(c.id ?? '');
      }
    } catch {
      // sin índice, se deja vacío
    }
    return '';
  }

  /** Lista de usuarios. Si se pasa conjunto, filtra por él (id o nombre crudo). */
  async list(conjunto?: string): Promise<any[]> {
    if (!this.firebase.isEnabled()) throw new Error('Servicio no disponible.');
    const snap = await this.firebase.db().ref(MIRROR_USERS).get();
    if (!snap.exists()) return [];
    let users = Object.values(snap.val() || {}) as any[];
    if (conjunto) {
      const norm = (s: unknown) => String(s ?? '').trim().toLowerCase();
      users = users.filter((u) => norm(u.conjunto) === norm(conjunto));
    }
    // No exponer marcas internas.
    return users.map((u) => {
      const { _fbWrite, ...rest } = u;
      return rest;
    });
  }

  /** Construye el objeto de perfil (RTDB) a partir del DTO. */
  private buildProfile(dto: UserDTO, conjuntoId: string): Record<string, any> {
    const usuario = String(dto.usuario || '').trim();
    return {
      id: usuario,
      usuario,
      email: dto.email || '',
      nombre: dto.nombre || dto.name || '',
      rol: dto.rol || dto.role || '',
      docType: dto.documentType || dto.docType || '',
      docNum: dto.documentNumber || dto.docNum || '',
      phone: dto.phone || '',
      conjunto: dto.conjunto || dto.complex || '',
      conjuntoId,
      parcela: dto.tower || dto.parcela || '',
      placa1: dto.placa1 || '',
      placa2: dto.placa2 || '',
      fechaIngreso: dto.fechaIngreso || '',
      _fbWrite: true,
    };
  }

  /**
   * Crea un usuario: perfil en RTDB + cuenta en Firebase Auth.
   * La contraseña llega cifrada; si no sirve (<6), se usa la temporal y se marca
   * mustChangePassword.
   */
  async create(dto: UserDTO): Promise<{ success: boolean; message?: string; tempPassword?: boolean }> {
    if (!this.firebase.isEnabled()) return { success: false, message: 'Servicio no disponible.' };
    const usuario = String(dto.usuario || '').trim();
    if (!usuario) return { success: false, message: 'El usuario (username) es obligatorio.' };
    const key = this.safeKey(usuario);

    const db = this.firebase.db();
    const ref = db.ref(`${MIRROR_USERS}/${key}`);
    const existing = await ref.get();
    if (existing.exists()) return { success: false, message: 'El usuario ya existe.' };

    const conjuntoId = await this.resolveConjuntoId(dto.conjunto || dto.complex || '');
    const profile = this.buildProfile(dto, conjuntoId);

    // Contraseña: descifrar la que llega (XOR). Si no sirve, temporal.
    const recovered = recoverPassword(String(dto.password || ''));
    const usaTemp = !recovered || recovered.length < 6;
    const password = usaTemp ? this.tempPassword : recovered;
    const email = dto.email || this.usernameToEmail(usuario);

    try {
      const auth = this.firebase.auth();
      const claims: Record<string, unknown> = { rol: profile.rol, conjuntoId };
      if (usaTemp) claims.mustChangePassword = true;

      // Crear/actualizar en Auth (idempotente por si el uid ya existía en Auth).
      let authExists = false;
      try { await auth.getUser(key); authExists = true; } catch { authExists = false; }
      if (authExists) {
        await auth.updateUser(key, { email, password, displayName: profile.nombre });
      } else {
        await auth.createUser({ uid: key, email, password, displayName: profile.nombre });
      }
      await auth.setCustomUserClaims(key, claims);

      // Perfil en RTDB.
      await ref.set(profile);
      return { success: true, message: 'Usuario creado.', tempPassword: usaTemp };
    } catch (err: any) {
      this.logger.error(`[users] create ${key} falló: ${err?.message}`);
      return { success: false, message: err?.message || 'No se pudo crear el usuario.' };
    }
  }

  /**
   * Actualiza un usuario. `username` en la ruta identifica el registro.
   * Actualiza perfil (RTDB), displayName/claims (Auth) y password si viene y fue
   * modificada (passwordModified + valor cifrado). No permite renombrar el uid.
   */
  async update(username: string, dto: UserDTO): Promise<{ success: boolean; message?: string }> {
    if (!this.firebase.isEnabled()) return { success: false, message: 'Servicio no disponible.' };
    const key = this.safeKey(username);
    if (!key) return { success: false, message: 'Usuario requerido.' };

    const db = this.firebase.db();
    const ref = db.ref(`${MIRROR_USERS}/${key}`);
    const snap = await ref.get();
    if (!snap.exists()) return { success: false, message: 'El usuario no existe.' };

    try {
      const prev = snap.val();
      const conjuntoRaw = dto.conjunto || dto.complex;
      const conjuntoId =
        conjuntoRaw !== undefined ? await this.resolveConjuntoId(conjuntoRaw) : prev.conjuntoId || '';

      // Merge por campo (solo los presentes en el DTO).
      const patch: Record<string, any> = { _fbWrite: true };
      const setIf = (field: string, value: any) => {
        if (value !== undefined) patch[field] = value;
      };
      setIf('email', dto.email);
      setIf('nombre', dto.nombre ?? dto.name);
      setIf('rol', dto.rol ?? dto.role);
      setIf('docType', dto.documentType ?? dto.docType);
      setIf('docNum', dto.documentNumber ?? dto.docNum);
      setIf('phone', dto.phone);
      if (conjuntoRaw !== undefined) {
        patch.conjunto = conjuntoRaw;
        patch.conjuntoId = conjuntoId;
      }
      setIf('parcela', dto.tower ?? dto.parcela);
      setIf('placa1', dto.placa1);
      setIf('placa2', dto.placa2);
      setIf('fechaIngreso', dto.fechaIngreso);

      await ref.update(patch);

      // Auth: displayName, claims (rol/conjuntoId) y password si aplica.
      const auth = this.firebase.auth();
      try {
        if (patch.nombre !== undefined) await auth.updateUser(key, { displayName: patch.nombre });
        const record = await auth.getUser(key);
        const claims = { ...(record.customClaims || {}) } as Record<string, any>;
        if (patch.rol !== undefined) claims.rol = patch.rol;
        if (conjuntoRaw !== undefined) claims.conjuntoId = conjuntoId;
        await auth.setCustomUserClaims(key, claims);
      } catch (e: any) {
        this.logger.warn(`[users] update Auth de ${key}: ${e?.message}`);
      }

      // Password solo si fue modificada explícitamente y viene valor.
      if (dto.passwordModified && dto.password) {
        const recovered = recoverPassword(String(dto.password));
        if (recovered && recovered.length >= 6) {
          await auth.updateUser(key, { password: recovered });
        }
      }

      return { success: true, message: 'Usuario actualizado.' };
    } catch (err: any) {
      this.logger.error(`[users] update ${key} falló: ${err?.message}`);
      return { success: false, message: err?.message || 'No se pudo actualizar el usuario.' };
    }
  }

  /** Elimina un usuario del RTDB y de Firebase Auth. */
  async remove(username: string): Promise<{ success: boolean; message?: string }> {
    if (!this.firebase.isEnabled()) return { success: false, message: 'Servicio no disponible.' };
    const key = this.safeKey(username);
    if (!key) return { success: false, message: 'Usuario requerido.' };

    try {
      await this.firebase.db().ref(`${MIRROR_USERS}/${key}`).remove();
      try {
        await this.firebase.auth().deleteUser(key);
      } catch (e: any) {
        // Si no existía en Auth, seguimos: el objetivo (que no exista) se cumple.
        this.logger.warn(`[users] delete Auth de ${key}: ${e?.message}`);
      }
      return { success: true, message: 'Usuario eliminado.' };
    } catch (err: any) {
      this.logger.error(`[users] delete ${key} falló: ${err?.message}`);
      return { success: false, message: err?.message || 'No se pudo eliminar el usuario.' };
    }
  }
}
