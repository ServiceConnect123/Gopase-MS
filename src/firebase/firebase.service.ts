import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  cert,
  applicationDefault,
  getApps,
  getApp,
  initializeApp,
  type App,
  type Credential,
  type ServiceAccount,
} from 'firebase-admin/app';
import { getDatabase, type Database } from 'firebase-admin/database';
import { getAuth, type Auth } from 'firebase-admin/auth';

/**
 * Inicializa firebase-admin y expone el Realtime Database del backend.
 *
 * Credenciales (NUNCA en el repo): se leen de variables de entorno. Soporta,
 * en orden de preferencia:
 *   1. FIREBASE_SERVICE_ACCOUNT      -> JSON completo de la service account (string)
 *   2. FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY
 *   3. GOOGLE_APPLICATION_CREDENTIALS -> ruta a archivo (admin lo toma solo)
 *
 * Requiere además:
 *   FIREBASE_DATABASE_URL -> URL del Realtime Database del proyecto (QA o PRD).
 *
 * En QA/PRD basta con configurar estas env en el servicio de Render
 * correspondiente; el mismo código apunta al proyecto que le indiquen.
 */
@Injectable()
export class FirebaseService implements OnModuleInit {
  private readonly logger = new Logger(FirebaseService.name);
  private app: App | null = null;
  private enabled = false;

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    if (getApps().length) {
      this.app = getApp();
      this.enabled = true;
      return;
    }

    const databaseURL = this.config.get<string>('FIREBASE_DATABASE_URL', '');
    if (!databaseURL) {
      this.logger.warn(
        'FIREBASE_DATABASE_URL no configurada: la sincronización a RTDB queda deshabilitada.',
      );
      return;
    }

    try {
      const credential = this.resolveCredential();
      if (!credential) {
        this.logger.warn(
          'Sin credenciales de Firebase: la sincronización a RTDB queda deshabilitada.',
        );
        return;
      }

      this.app = initializeApp({ credential, databaseURL });
      this.enabled = true;
      this.logger.log(`Firebase Admin inicializado (RTDB: ${databaseURL}).`);
    } catch (err: any) {
      this.logger.error(`No se pudo inicializar Firebase Admin: ${err?.message || err}`);
    }
  }

  /** Resuelve la credencial desde las distintas fuentes soportadas. */
  private resolveCredential(): Credential | null {
    // 1. JSON completo de la service account en una sola env var.
    const saJson = this.config.get<string>('FIREBASE_SERVICE_ACCOUNT', '');
    if (saJson) {
      try {
        const parsed = JSON.parse(saJson);
        if (parsed.private_key) {
          parsed.private_key = String(parsed.private_key).replace(/\\n/g, '\n');
        }
        return cert(parsed as ServiceAccount);
      } catch (e: any) {
        this.logger.error(`FIREBASE_SERVICE_ACCOUNT no es un JSON válido: ${e?.message}`);
      }
    }

    // 2. Campos sueltos.
    const projectId = this.config.get<string>('FIREBASE_PROJECT_ID', '');
    const clientEmail = this.config.get<string>('FIREBASE_CLIENT_EMAIL', '');
    let privateKey = this.config.get<string>('FIREBASE_PRIVATE_KEY', '');
    if (projectId && clientEmail && privateKey) {
      // Las env suelen escapar los saltos de línea de la private key.
      privateKey = privateKey.replace(/\\n/g, '\n');
      return cert({ projectId, clientEmail, privateKey });
    }

    // 3. GOOGLE_APPLICATION_CREDENTIALS (ruta a archivo) -> applicationDefault.
    if (this.config.get<string>('GOOGLE_APPLICATION_CREDENTIALS', '')) {
      return applicationDefault();
    }

    return null;
  }

  /** Indica si Firebase quedó inicializado y utilizable. */
  isEnabled(): boolean {
    return this.enabled && this.app != null;
  }

  /** Referencia al Realtime Database. Lanza si Firebase no está inicializado. */
  db(): Database {
    if (!this.app) {
      throw new Error('Firebase Admin no inicializado (revisa las env de Firebase).');
    }
    return getDatabase(this.app);
  }

  /** Referencia a Firebase Auth. Lanza si Firebase no está inicializado. */
  auth(): Auth {
    if (!this.app) {
      throw new Error('Firebase Admin no inicializado (revisa las env de Firebase).');
    }
    return getAuth(this.app);
  }
}
