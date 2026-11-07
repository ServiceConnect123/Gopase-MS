// ==========================================
// AppConfigService — configuración global de la aplicación
// ==========================================
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FirebaseService } from '../firebase/firebase.service';

const RTDB_PATH = 'mirror/appConfig';

export interface EpaycoConfig {
  publicKey: string;
  privateKey: string;
  /** Customer ID de ePayco (dashboard → Integración → Customer ID). Necesario para validar firma del webhook. */
  customerId: string;
  /** P_KEY de ePayco (dashboard → Integración → P_KEY). Necesario para validar firma del webhook. */
  pKey: string;
  test: boolean;
  webhookBase: string;
}

@Injectable()
export class AppConfigService {
  private readonly logger = new Logger(AppConfigService.name);
  private cache: { epayco?: EpaycoConfig; loadedAt?: number } = {};
  private readonly CACHE_TTL_MS = 60_000;

  constructor(
    private readonly firebase: FirebaseService,
    private readonly config: ConfigService,
  ) {}

  async getEpaycoConfig(): Promise<EpaycoConfig> {
    const now = Date.now();
    if (this.cache.epayco && this.cache.loadedAt && now - this.cache.loadedAt < this.CACHE_TTL_MS) {
      return this.cache.epayco;
    }
    const fromRtdb = await this.readEpaycoFromRtdb();
    const cfg: EpaycoConfig = {
      publicKey:   fromRtdb?.publicKey   || this.config.get<string>('EPAYCO_PUBLIC_KEY', ''),
      privateKey:  fromRtdb?.privateKey  || this.config.get<string>('EPAYCO_PRIVATE_KEY', ''),
      customerId:  fromRtdb?.customerId  || this.config.get<string>('EPAYCO_CUSTOMER_ID', ''),
      pKey:        fromRtdb?.pKey        || this.config.get<string>('EPAYCO_P_KEY', ''),
      test:        fromRtdb?.test        ?? this.config.get<string>('EPAYCO_TEST', 'true') !== 'false',
      webhookBase: fromRtdb?.webhookBase || this.trimSlash(this.config.get<string>('EPAYCO_WEBHOOK_BASE', '')),
    };
    this.cache = { epayco: cfg, loadedAt: now };
    return cfg;
  }

  async saveEpaycoConfig(dto: Partial<EpaycoConfig>): Promise<{ success: boolean; message?: string }> {
    if (!this.firebase.isEnabled()) return { success: false, message: 'Firebase no disponible.' };
    try {
      const current = await this.readEpaycoFromRtdb() ?? {};
      const updated = {
        publicKey:   dto.publicKey   !== undefined ? String(dto.publicKey).trim()  : (current.publicKey  ?? ''),
        privateKey:  dto.privateKey  ? String(dto.privateKey).trim()               : (current.privateKey ?? ''),
        customerId:  dto.customerId  !== undefined ? String(dto.customerId).trim() : (current.customerId ?? ''),
        pKey:        dto.pKey        ? String(dto.pKey).trim()                     : (current.pKey       ?? ''),
        test:        dto.test        ?? current.test ?? true,
        webhookBase: this.trimSlash(dto.webhookBase ?? current.webhookBase ?? ''),
        updatedAt:   new Date().toISOString(),
      };
      await this.firebase.db().ref(`${RTDB_PATH}/epayco`).set(updated);
      this.cache = {};
      this.logger.log('[appConfig] config ePayco actualizada.');
      return { success: true };
    } catch (err: any) {
      this.logger.error(`[appConfig] saveEpaycoConfig: ${err?.message}`);
      return { success: false, message: err?.message || 'No se pudo guardar.' };
    }
  }

  async getEpaycoConfigForUI(): Promise<{
    publicKey: string;
    privateKeyMasked: string;
    customerId: string;
    pKeyMasked: string;
    test: boolean;
    webhookBase: string;
    configured: boolean;
  }> {
    const cfg = await this.getEpaycoConfig();
    const mask = (s: string) => s ? `${'*'.repeat(Math.min(s.length, 8))}…` : '';
    return {
      publicKey:        cfg.publicKey,
      privateKeyMasked: mask(cfg.privateKey),
      customerId:       cfg.customerId,
      pKeyMasked:       mask(cfg.pKey),
      test:             cfg.test,
      webhookBase:      cfg.webhookBase,
      configured:       !!(cfg.publicKey && cfg.privateKey),
    };
  }

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
