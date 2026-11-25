// ==========================================
// AppConfigService — configuración global de la aplicación
// ==========================================
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FirebaseService } from '../firebase/firebase.service';
import {
  BANCOS, MetodoRecaudo, bancoPorNombre, metodosAObjeto, metodosDeObjeto, metodosPublicos,
  normalizarMetodo, opCambiarMetodo, opEliminarMetodo, opGuardarMetodo,
} from '../cuota/cuota.rules';

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

/** Datos de pago del superAdmin para transferencias manuales (Bre-B o cuenta bancaria). */
export interface DatosPagoConfig {
  /** 'breb' = llave Bre-B/Nequi/Daviplata, 'cuenta' = cuenta bancaria tradicional. */
  tipo: 'breb' | 'cuenta';
  /** Llave Bre-B (número de celular, correo o alias). Solo si tipo = 'breb'. */
  llave: string;
  /** Nombre del banco (Bancolombia, Davivienda, etc.). Solo si tipo = 'cuenta'. */
  banco: string;
  /** Número de cuenta. Solo si tipo = 'cuenta'. */
  numeroCuenta: string;
  /** 'ahorro' | 'corriente'. Solo si tipo = 'cuenta'. */
  tipoCuenta: 'ahorro' | 'corriente';
  /** Nombre del titular (para que el admin sepa a quién transferir). */
  titular: string;
}

/** Medios con los que los conjuntos pueden pagar su plan. */
export interface MediosPago {
  tarjeta: boolean;
  pse: boolean;
  nequi: boolean;
  transferencia: boolean;
}
export const MEDIOS_DEFAULT: MediosPago = { tarjeta: true, pse: true, nequi: true, transferencia: true };

/** Normaliza los medios guardados (lo que falte queda habilitado). */
export function normalizarMedios(raw: any): MediosPago {
  const v = (k: keyof MediosPago) => (raw && typeof raw === 'object' && raw[k] === false ? false : true);
  return { tarjeta: v('tarjeta'), pse: v('pse'), nequi: v('nequi'), transferencia: v('transferencia') };
}

/** Cuenta única antigua (datosPago) → método de la lista nueva. */
export function cuentaDeDatosPago(d: any): MetodoRecaudo | null {
  if (!d || typeof d !== 'object') return null;
  if (d.tipo === 'cuenta') {
    if (!d.numeroCuenta) return null;
    return normalizarMetodo({
      id: 'gopase-principal', tipo: 'banco', banco: bancoPorNombre(d.banco), numero: d.numeroCuenta,
      tipoCuenta: d.tipoCuenta === 'corriente' ? 'Corriente' : 'Ahorros', titular: d.titular, nit: d.nit || '',
      activo: true, principal: true,
    });
  }
  if (!d.llave) return null;
  return normalizarMetodo({ id: 'gopase-principal', tipo: 'breb', llave: d.llave, titular: d.titular, activo: true, principal: true });
}

/** Método principal → forma antigua de datosPago (compatibilidad con clientes viejos). */
export function datosPagoDeCuentas(lista: MetodoRecaudo[]): DatosPagoConfig | null {
  const p = lista.find((m) => m.activo && m.principal) || lista.find((m) => m.activo);
  if (!p) return null;
  return p.tipo === 'breb'
    ? { tipo: 'breb', llave: p.llave || '', banco: '', numeroCuenta: '', tipoCuenta: 'ahorro', titular: p.titular }
    : { tipo: 'cuenta', llave: '', banco: BANCOS[p.banco || ''] || '', numeroCuenta: p.numero || '', tipoCuenta: p.tipoCuenta === 'Corriente' ? 'corriente' : 'ahorro', titular: p.titular };
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

  // ---------------------------------------------------------------------------
  // Datos de pago del superAdmin (Bre-B / cuenta bancaria)
  // ---------------------------------------------------------------------------

  /** Lee los datos de pago desde RTDB. Público: los admins lo necesitan al pagar. */
  async getDatosPago(): Promise<DatosPagoConfig | null> {
    if (!this.firebase.isEnabled()) return null;
    try {
      const snap = await this.firebase.db().ref(`${RTDB_PATH}/datosPago`).get();
      if (!snap.exists()) return null;
      return snap.val() as DatosPagoConfig;
    } catch (err: any) {
      this.logger.warn(`[appConfig] getDatosPago: ${err?.message}`);
      return null;
    }
  }

  /** Guarda los datos de pago en RTDB (solo superAdmin). */
  async saveDatosPago(dto: DatosPagoConfig): Promise<{ success: boolean; message?: string }> {
    if (!this.firebase.isEnabled()) return { success: false, message: 'Firebase no disponible.' };
    try {
      const record = {
        tipo:         dto.tipo === 'cuenta' ? 'cuenta' : 'breb',
        llave:        String(dto.llave        ?? '').trim(),
        banco:        String(dto.banco        ?? '').trim(),
        numeroCuenta: String(dto.numeroCuenta ?? '').trim(),
        tipoCuenta:   dto.tipoCuenta === 'corriente' ? 'corriente' : 'ahorro',
        titular:      String(dto.titular      ?? '').trim(),
        updatedAt:    new Date().toISOString(),
      };
      await this.firebase.db().ref(`${RTDB_PATH}/datosPago`).set(record);
      this.logger.log('[appConfig] datosPago actualizado.');
      return { success: true };
    } catch (err: any) {
      this.logger.error(`[appConfig] saveDatosPago: ${err?.message}`);
      return { success: false, message: err?.message || 'No se pudo guardar.' };
    }
  }

  // ---------------------------------------------------------------------------
  // Cobros: cuentas de GoPase para transferencias + medios habilitados
  // ---------------------------------------------------------------------------

  /** Cuentas de GoPase (varias, con principal). Si no hay, usa los datosPago antiguos. */
  async getCuentasGopase(): Promise<MetodoRecaudo[]> {
    if (!this.firebase.isEnabled()) return [];
    try {
      const snap = await this.firebase.db().ref(`${RTDB_PATH}/cuentasGopase`).get();
      const lista = snap.exists() ? metodosDeObjeto(snap.val()) : [];
      if (lista.length) return lista;
      const legado = cuentaDeDatosPago(await this.getDatosPago());
      return legado ? [legado] : [];
    } catch (err: any) {
      this.logger.warn(`[appConfig] getCuentasGopase: ${err?.message}`);
      return [];
    }
  }

  async getMediosPago(): Promise<MediosPago> {
    if (!this.firebase.isEnabled()) return { ...MEDIOS_DEFAULT };
    try {
      const snap = await this.firebase.db().ref(`${RTDB_PATH}/mediosPago`).get();
      return normalizarMedios(snap.exists() ? snap.val() : null);
    } catch {
      return { ...MEDIOS_DEFAULT };
    }
  }

  async saveMediosPago(dto: Partial<MediosPago>): Promise<{ success: boolean; message?: string; medios?: MediosPago }> {
    if (!this.firebase.isEnabled()) return { success: false, message: 'Firebase no disponible.' };
    const medios = normalizarMedios({ ...(await this.getMediosPago()), ...(dto || {}) });
    if (!medios.tarjeta && !medios.pse && !medios.nequi && !medios.transferencia) {
      return { success: false, message: 'Deja al menos un medio habilitado: los conjuntos no podrían pagar su plan.' };
    }
    await this.firebase.db().ref(`${RTDB_PATH}/mediosPago`).set({ ...medios, updatedAt: new Date().toISOString() });
    return { success: true, medios };
  }

  /** Guarda la lista y mantiene datosPago (la principal) para clientes antiguos. */
  private async guardarCuentas(lista: MetodoRecaudo[]) {
    const legado = datosPagoDeCuentas(lista);
    await this.firebase.db().ref(RTDB_PATH).update({
      cuentasGopase: lista.length ? metodosAObjeto(lista) : null,
      datosPago: legado ? { ...legado, updatedAt: new Date().toISOString() } : null,
    });
  }

  async guardarCuentaGopase(dto: any, id?: string) {
    if (!this.firebase.isEnabled()) return { success: false, message: 'Firebase no disponible.' };
    const r = opGuardarMetodo(await this.getCuentasGopase(), dto, id, id ? undefined : `g${Date.now().toString(36)}`);
    if (!r.ok) return { success: false, message: r.message };
    await this.guardarCuentas(r.lista);
    return { success: true, id: r.id, cuentas: r.lista };
  }

  async cambiarCuentaGopase(id: string, patch: { activo?: boolean; principal?: boolean }) {
    if (!this.firebase.isEnabled()) return { success: false, message: 'Firebase no disponible.' };
    const r = opCambiarMetodo(await this.getCuentasGopase(), id, patch, 'los conjuntos');
    if (!r.ok) return { success: false, message: r.message };
    await this.guardarCuentas(r.lista);
    return { success: true, cuentas: r.lista, aviso: r.aviso };
  }

  async eliminarCuentaGopase(id: string) {
    if (!this.firebase.isEnabled()) return { success: false, message: 'Firebase no disponible.' };
    const r = opEliminarMetodo(await this.getCuentasGopase(), id);
    if (!r.ok) return { success: false, message: r.message };
    await this.guardarCuentas(r.lista);
    return { success: true, cuentas: r.lista };
  }

  /** Lo que ven los admins al pagar: cuentas activas + medios + forma antigua. */
  async getInfoPagoPublica() {
    const [cuentas, medios] = await Promise.all([this.getCuentasGopase(), this.getMediosPago()]);
    const legado = datosPagoDeCuentas(cuentas);
    return { ...(legado || {}), cuentas: metodosPublicos(cuentas), medios };
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
