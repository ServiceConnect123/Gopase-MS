import { Injectable, Logger } from '@nestjs/common';
import { FirebaseService } from '../firebase/firebase.service';
import {
  BANCOS, MetodoRecaudo, TIPOS_LLAVE, listaMetodos, listaTarifas, llaveCompat, metodosAObjeto,
  num, opCambiarMetodo, opEliminarMetodo, opGuardarMetodo, resumenTarifas, tarifaDeUsuario, validarTarifa,
} from './cuota.rules';

const MIRROR_CONJUNTOS = 'mirror/conjuntos';
const MIRROR_USERS = 'mirror/usuarios';

type Res<T = Record<string, never>> = ({ success: true } & T) | { success: false; message: string };

/**
 * Cuota de administración: tarifa base (la cuota que ya tenía el conjunto),
 * tarifas diferenciales asignables por unidad y métodos de recaudo (llaves
 * Bre-B y cuentas bancarias). Las reglas puras están en cuota.rules.ts.
 */
@Injectable()
export class CuotaService {
  private readonly logger = new Logger(CuotaService.name);

  constructor(private readonly firebase: FirebaseService) {}

  private norm(s: unknown) {
    return String(s ?? '').trim().toLowerCase();
  }

  private safeKey(k: string) {
    return String(k || '').replace(/[.#$/[\]]/g, '_');
  }

  async findConjunto(conjunto: string): Promise<{ key: string; value: any } | null> {
    const t = this.norm(conjunto);
    if (!t || !this.firebase.isEnabled()) return null;
    const all = (await this.firebase.liveVal<Record<string, any>>(MIRROR_CONJUNTOS)) || {};
    for (const [key, v] of Object.entries(all)) {
      if (this.norm((v as any)?.nombre) === t || this.norm((v as any)?.id) === t || this.norm(key) === t) return { key, value: v };
    }
    return null;
  }

  private async usuariosDe(conj: any): Promise<Array<any>> {
    const all = (await this.firebase.liveVal<Record<string, any>>(MIRROR_USERS)) || {};
    const nombre = this.norm(conj?.nombre);
    const id = this.norm(conj?.id);
    return Object.entries(all)
      .map(([k, u]) => ({ ...(u as any), usuario: (u as any)?.usuario ?? k, _key: k }))
      .filter((u) => {
        const c = this.norm(u.conjunto);
        return (nombre && c === nombre) || (id && (c === id || this.norm(u.conjuntoId) === id));
      });
  }

  // ---------------------------------------------------------------------------
  // Lectura
  // ---------------------------------------------------------------------------

  async getConfig(conjunto: string): Promise<Res<{ data: any }>> {
    const found = await this.findConjunto(conjunto);
    if (!found) return { success: false, message: 'El conjunto no existe.' };
    const c = found.value;
    const usuarios = await this.usuariosDe(c);
    return {
      success: true,
      data: {
        conjunto: c.nombre ?? '',
        moneda: c.moneda || 'COP',
        diasGraciaPropietario: Number(c.diasGraciaPropietario ?? 10),
        ...resumenTarifas(c, usuarios),
        metodos: listaMetodos(c),
        bancos: Object.entries(BANCOS).map(([id, nombre]) => ({ id, nombre })),
        tiposLlave: TIPOS_LLAVE,
      },
    };
  }

  /** Tarifa que paga un usuario (para pagos y el home). Inquilino que paga administración → la de su propietario. */
  async tarifaDe(usuario: string): Promise<{ id: string | null; nombre: string; valor: number; esBase: boolean } | null> {
    const all = (await this.firebase.liveVal<Record<string, any>>(MIRROR_USERS)) || {};
    let u = all[this.safeKey(usuario)] || Object.values(all).find((x: any) => this.norm(x?.usuario) === this.norm(usuario));
    if (!u) return null;
    const prop = String(u?.inquilino?.propietario || u?.propietarioUsuario || '').trim();
    if (this.norm(u?.rol).startsWith('inquilino') && prop) u = all[this.safeKey(prop)] || u;
    const found = await this.findConjunto(u.conjunto || u.conjuntoId || '');
    if (!found) return null;
    return tarifaDeUsuario(found.value, u);
  }

  // ---------------------------------------------------------------------------
  // Tarifa base y tarifas
  // ---------------------------------------------------------------------------

  async setBase(conjunto: string, valor: unknown): Promise<Res<{ valor: number }>> {
    const v = num(valor);
    if (!v || v <= 0) return { success: false, message: 'La tarifa base debe ser mayor que 0.' };
    const found = await this.findConjunto(conjunto);
    if (!found) return { success: false, message: 'El conjunto no existe.' };
    await this.firebase.db().ref(`${MIRROR_CONJUNTOS}/${found.key}`).update({ cuotaMonto: String(v), _fbWrite: true });
    return { success: true, valor: v };
  }

  async guardarTarifa(conjunto: string, dto: any, id?: string): Promise<Res<{ id: string; liberadas?: number }>> {
    const found = await this.findConjunto(conjunto);
    if (!found) return { success: false, message: 'El conjunto no existe.' };
    const existentes = listaTarifas(found.value);
    const previa = id ? existentes.find((t) => t.id === id) : undefined;
    if (id && !previa) return { success: false, message: 'La tarifa no existe.' };
    const v = validarTarifa({ ...(previa || {}), ...dto }, existentes, id);
    if (!v.ok) return { success: false, message: v.message };

    const ref = this.firebase.db().ref(`${MIRROR_CONJUNTOS}/${found.key}`);
    const tid = id || `t${Date.now().toString(36)}`;
    await ref.update({
      [`tarifas/${tid}`]: { ...v.tarifa, creadaEn: previa?.creadaEn || new Date().toISOString() },
      _fbWrite: true,
    });

    // Desactivarla: sus unidades vuelven a la tarifa base.
    let liberadas = 0;
    if (previa && previa.activo && !v.tarifa.activo) liberadas = await this.liberarUnidades(found.value, tid);
    return { success: true, id: tid, liberadas };
  }

  private async liberarUnidades(conj: any, tarifaId: string): Promise<number> {
    const usuarios = await this.usuariosDe(conj);
    const updates: Record<string, any> = {};
    usuarios.filter((u) => u.tarifaId === tarifaId).forEach((u) => { updates[`${u._key}/tarifaId`] = null; });
    const n = Object.keys(updates).length;
    if (n) await this.firebase.db().ref(MIRROR_USERS).update(updates);
    return n;
  }

  /** Asigna (o quita, con tarifaId vacío) la tarifa de una unidad/propietario. */
  async asignar(conjunto: string, usuario: string, tarifaId: string | null | undefined): Promise<Res<{ tarifa: any }>> {
    const found = await this.findConjunto(conjunto);
    if (!found) return { success: false, message: 'El conjunto no existe.' };
    const usuarios = await this.usuariosDe(found.value);
    const u = usuarios.find((x) => this.norm(x.usuario) === this.norm(usuario));
    if (!u) return { success: false, message: 'El usuario no pertenece a este conjunto.' };
    const id = String(tarifaId || '').trim();
    if (id) {
      const t = listaTarifas(found.value).find((x) => x.id === id);
      if (!t) return { success: false, message: 'La tarifa no existe.' };
      if (!t.activo) return { success: false, message: 'Esa tarifa está inactiva. Actívala en Configuración o escoge otra.' };
    }
    await this.firebase.db().ref(`${MIRROR_USERS}/${u._key}`).update({ tarifaId: id || null });
    return { success: true, tarifa: tarifaDeUsuario(found.value, { ...u, tarifaId: id || null }) };
  }

  // ---------------------------------------------------------------------------
  // Métodos de recaudo
  // ---------------------------------------------------------------------------

  private async guardarMetodos(key: string, lista: MetodoRecaudo[]) {
    await this.firebase.db().ref(`${MIRROR_CONJUNTOS}/${key}`).update({
      metodosRecaudo: metodosAObjeto(lista),
      llaveBreB: llaveCompat(lista),
      _fbWrite: true,
    });
  }

  /** Crea o edita un método. `principal: true` lo vuelve el principal. */
  async guardarMetodo(conjunto: string, dto: any, id?: string): Promise<Res<{ id: string; metodos: MetodoRecaudo[] }>> {
    const found = await this.findConjunto(conjunto);
    if (!found) return { success: false, message: 'El conjunto no existe.' };
    const r = opGuardarMetodo(listaMetodos(found.value), dto, id);
    if (!r.ok) return { success: false, message: r.message };
    await this.guardarMetodos(found.key, r.lista);
    return { success: true, id: r.id, metodos: r.lista };
  }

  /** Activa/desactiva o marca como principal. */
  async cambiarMetodo(conjunto: string, id: string, patch: { activo?: boolean; principal?: boolean }): Promise<Res<{ metodos: MetodoRecaudo[]; aviso?: string }>> {
    const found = await this.findConjunto(conjunto);
    if (!found) return { success: false, message: 'El conjunto no existe.' };
    const r = opCambiarMetodo(listaMetodos(found.value), id, patch);
    if (!r.ok) return { success: false, message: r.message };
    await this.guardarMetodos(found.key, r.lista);
    return { success: true, metodos: r.lista, aviso: r.aviso };
  }

  async eliminarMetodo(conjunto: string, id: string): Promise<Res<{ metodos: MetodoRecaudo[] }>> {
    const found = await this.findConjunto(conjunto);
    if (!found) return { success: false, message: 'El conjunto no existe.' };
    const r = opEliminarMetodo(listaMetodos(found.value), id);
    if (!r.ok) return { success: false, message: r.message };
    await this.guardarMetodos(found.key, r.lista);
    return { success: true, metodos: r.lista };
  }
}
