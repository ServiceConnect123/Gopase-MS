import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SheetsService } from '../sheets/sheets.service';
import { FirebaseService } from '../firebase/firebase.service';
import { recoverPassword } from './password.util';

/**
 * Migración de usuarios de Google Sheets a Firebase Auth (estrategia A1).
 *
 * - uid    = username (dato_1), estable, así el perfil en RTDB se referencia directo.
 * - email  = `${username}@${AUTH_EMAIL_DOMAIN}` (sintético; no se envían correos).
 * - password = la contraseña actual descifrada de la hoja (XOR reversible).
 * - custom claims = { rol, conjuntoId } para las reglas de seguridad del RTDB.
 *
 * Idempotente: si el usuario ya existe en Auth, se actualiza (email/password/claims).
 * Unidireccional: nunca escribe en Sheets.
 */
export interface MigrateUserResult {
  username: string;
  uid?: string;
  action: 'created' | 'updated' | 'skipped' | 'failed';
  message?: string;
}

export interface MigrateSummary {
  total: number;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  results: MigrateUserResult[];
}

@Injectable()
export class AuthMigrationService {
  private readonly logger = new Logger(AuthMigrationService.name);
  private readonly emailDomain: string;

  constructor(
    private readonly sheets: SheetsService,
    private readonly firebase: FirebaseService,
    private readonly config: ConfigService,
  ) {
    // Dominio del email sintético. Configurable; por defecto gopase.local.
    this.emailDomain = this.config.get<string>('AUTH_EMAIL_DOMAIN', 'gopase.local');
  }

  /** username -> email sintético (minúsculas, saneado). */
  usernameToEmail(username: string): string {
    const local = String(username || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]/g, '_'); // solo caracteres válidos en el local-part
    return `${local}@${this.emailDomain}`;
  }

  /** Índice conjunto (id o nombre) -> conjuntoId, para el custom claim. */
  private buildConjuntoIndex(conjuntos: Array<{ id: string; nombre: string }>) {
    const byKey = new Map<string, string>();
    const norm = (s: unknown) => String(s ?? '').trim().toLowerCase();
    for (const c of conjuntos) {
      if (c.id) byKey.set(norm(c.id), c.id);
      if (c.nombre) byKey.set(norm(c.nombre), c.id);
    }
    return (raw: unknown) => byKey.get(norm(raw)) ?? '';
  }

  /**
   * Migra todos los usuarios de la hoja a Firebase Auth.
   * @param dryRun si es true, no escribe en Auth: solo reporta qué haría.
   */
  async migrateAll(dryRun = false): Promise<MigrateSummary> {
    const summary: MigrateSummary = {
      total: 0, created: 0, updated: 0, skipped: 0, failed: 0, results: [],
    };

    if (!this.firebase.isEnabled()) {
      throw new Error('Firebase no está habilitado (revisa las env de Firebase).');
    }

    const auth = this.firebase.auth();

    // Leer usuarios y conjuntos (para resolver el conjuntoId del claim).
    const [userRows, conjRows] = await Promise.all([
      this.sheets.read('usuarios'),
      this.sheets.read('propiedades'),
    ]);

    const conjuntos = conjRows.map((r: any) => ({
      id: String(r.dato_1 ?? ''),
      nombre: String(r.dato_2 ?? ''),
    }));
    const resolveConjunto = this.buildConjuntoIndex(conjuntos);

    for (const row of userRows) {
      const username = String((row as any).dato_1 ?? '').trim();
      if (!username) {
        summary.skipped++;
        summary.results.push({ username: '(vacío)', action: 'skipped', message: 'Sin username' });
        continue;
      }
      summary.total++;

      const storedRaw = String((row as any).dato_3 ?? '');
      const password = recoverPassword(storedRaw);
      const nombre = String((row as any).dato_4 ?? '').trim();
      const rol = String((row as any).dato_5 ?? '').trim();
      const conjuntoId = resolveConjunto((row as any).dato_9);
      const email = this.usernameToEmail(username);

      // Firebase exige password de al menos 6 caracteres.
      if (!password || password.length < 6) {
        summary.skipped++;
        // Diagnóstico SIN exponer la contraseña: forma del valor guardado y del
        // resultado del descifrado, para entender por qué se omitió.
        const diag =
          `storedLen=${storedRaw.length} tieneDosPuntos=${storedRaw.includes(':')} ` +
          `descifradoLen=${password.length}`;
        summary.results.push({
          username,
          action: 'skipped',
          message: `Contraseña ausente o menor a 6 caracteres (Firebase la rechaza). [${diag}]`,
        });
        continue;
      }

      if (dryRun) {
        summary.results.push({ username, uid: username, action: 'skipped', message: 'dry-run' });
        continue;
      }

      try {
        // ¿Existe ya? (uid = username)
        let exists = false;
        try {
          await auth.getUser(username);
          exists = true;
        } catch {
          exists = false;
        }

        const claims = { rol, conjuntoId };

        if (exists) {
          await auth.updateUser(username, { email, password, displayName: nombre });
          await auth.setCustomUserClaims(username, claims);
          summary.updated++;
          summary.results.push({ username, uid: username, action: 'updated' });
        } else {
          await auth.createUser({ uid: username, email, password, displayName: nombre });
          await auth.setCustomUserClaims(username, claims);
          summary.created++;
          summary.results.push({ username, uid: username, action: 'created' });
        }
      } catch (err: any) {
        summary.failed++;
        summary.results.push({
          username,
          action: 'failed',
          message: err?.message || 'Error al crear/actualizar en Auth',
        });
        this.logger.warn(`[auth-migrate] ${username} falló: ${err?.message}`);
      }
    }

    this.logger.log(
      `[auth-migrate] total=${summary.total} creados=${summary.created} ` +
        `actualizados=${summary.updated} omitidos=${summary.skipped} fallidos=${summary.failed}`,
    );
    return summary;
  }
}
