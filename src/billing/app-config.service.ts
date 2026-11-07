// ==========================================
// AppConfigService — configuración global de la aplicación
// ==========================================
// Guarda en RTDB (mirror/appConfig) la configuración que el superAdmin puede
// cambiar desde la UI sin necesidad de redesplegar el backend.
//
// Actualmente gestiona:
//   - ePayco: publicKey, privateKey, test, webhookBase
//
// Las env vars actúan como valores por defecto (para no romper despliegues
// existentes). Si existe el valor en RTDB, se usa; si no, cae a la env var.
// Así el superAdmin puede sobrescribir sin tocar Render.
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FirebaseService } from '../firebase/firebase.service';

const RTDB_PATH = 'mirror/appConfig';

export interface EpaycoConfig {
  publicKey: string;
  privateKey: string;
  /** true = modo prueba, false = producción. */
  test: boolean;
  /** URL base del backend expuesta a internet (para el webhook de ePayco). */
  webhookBase: string;
}

@Injectable()
export class AppConfigService {
  private readonly logger = new Logger(AppConfigService.name);
  // Caché en memoria para no ir a RTDB en cada request de pago.
  private cache: { epayco?: EpaycoConfig; loadedAt?: number } = {};
  private readonly CACHE_TTL_MS = 60_000; // 1 minuto

  constructor(
    private readonly firebase: FirebaseService,
    private readonly config: ConfigService,
  ) {}

  // ---------------------------------------------------------------------------
  // ePayco
  // ---------------------------------------------------------------------------

  /** Lee la config de ePayco desde RTDB (con fallback a env vars). Cacheada 1 min. */
  async getEpaycoConfig(): Promise<EpaycoConfig> {
    const now = Date.now();
    if (this.cache.epayco && this.cache.loadedAt && now - this.cache.loadedAt < this.CACHE_TTL_MS) {
      return this.cache.epayco;
    }
    const fromRtdb = await this.readEpaycoFromRtdb();
    const cfg: EpaycoConfig = {
      publicKey:   fromRtdb?.publicKey   || this.config.get<string>('EPAYCO_PUBLIC_KEY', ''),
      privateKey:  fromRtdb?.privateKey  || this.config.get<string>('EPAYCO_PRIVATE_KEY', ''),
      test:        fromRtdb?.test        ?? this.config.get<string>('EPAYCO_TEST', 'true') !== 'false',
      webhookBase: fromRtdb?.webhookBase || this.trimSlash(this.config.get<string>('EPAYCO_WEBHOOK_BASE', '')),
    };
    this.cache = { epayco: cfg, loadedAt: now };
    return cfg;
  }

  /** Guarda la config de ePayco en RTDB y limpia la caché. */
  async saveEpaycoConfig(dto: Partial<EpaycoConfig>): Promise<{ success: boolean; message?: string }> {
    if (!this.firebase.isEnabled()) return { success: false, message: 'Firebase no disponible.' };
    try {
      const current = await this.readEpaycoFromRtdb() ?? {};
      const updated = {
        publicKey:   dto.publicKey   ?? current.publicKey   ?? '',
        // La privateKey NUNCA se lee de vuelta (write-only para no exponerla).
        // Si llega vacía, se conserva la guardada.
        privateKey:  dto.privateKey ? String(dto.privateKey).trim() : (current.privateKey ?? ''),
        test:        dto.test        ?? current.test        ?? true,
        webhookBase: this.trimSlash(dto.webhookBase ?? current.webhookBase ?? ''),
        updatedAt:   new Date().toISOString(),
      };
      await this.firebase.db().ref(`${RTDB_PATH}/epayco`).set(updated);
      // Invalida la caché para que el siguiente request tome los nuevos valores.
      this.cache = {};
      this.logger.log('[appConfig] config ePayco actualizada.');
      return { success: true };
    } catch (err: any) {
      this.logger.error(`[appConfig] saveEpaycoConfig: ${err?.message}`);
      return { success: false, message: err?.message || 'No se pudo guardar.' };
    }
  }

  /**
   * Devuelve la config de ePayco para mostrarla en la UI. La privateKey se
   * enmascara (****) para no exponerla al frontend.
   */
  async getEpaycoConfigForUI(): Promise<{
    publicKey: string;
    privateKeyMasked: string;
    test: boolean;
    webhookBase: string;
    configured: boolean;
  }> {
    const cfg = await this.getEpaycoConfig();
    return {
      publicKey:        cfg.publicKey,
      privateKeyMasked: cfg.privateKey ? `${'*'.repeat(Math.min(cfg.privateKey.length, 8))}…` : '',
      test:             cfg.test,
      webhookBase:      cfg.webhookBase,
      configured:       !!(cfg.publicKey && cfg.privateKey),
    };
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private async readEpaycoFromRtdb(): Promise<Partial<EpaycoConfig & { updatedAt?: string }> | null> {
    if (!this.firebase.isEnabled()) return null;
    try {
      const snap = await this.firebase.db().ref(`${RTDB_PATH}/epayco`).get();
      return snap.exists() ? (snap.val() as any) : null;
    } catch (err: any) {
      this.logger.warn(`[appConfig] readEpaycoFromRtdb: ${err?.message}`);
      return null;
    }
  }

  private trimSlash(url: string): string {
    const s = String(url ?? '').trim();
    return s.endsWith('/') ? s.slice(0, -1) : s;
  }
}
