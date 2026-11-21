import { Injectable, Logger } from '@nestjs/common';
import { FirebaseService } from '../firebase/firebase.service';
import { RANGOS_DEFAULT, contarUnidades, normRangos, normUnidades, precioPara, unidadesInfo, validarRangos } from './pricing';
import type { UnidadesInfo } from './pricing';

/**
 * Planes SaaS de goPase y su catálogo de módulos habilitados. Cada conjunto
 * tiene un plan asignado (campo planId en mirror/conjuntos/{id}); sin plan se
 * considera 'basico'. El acceso a los módulos de la app se deriva del plan.
 *
 * Catálogo en RTDB mirror/planes/{id}. Se siembran 3 planes base (no borrables):
 *   basico, medio, premium. El superAdmin puede crear planes ESPECIALES
 *   (clonando uno base con un precio custom).
 *
 * Campos de un plan:
 *   id, nombre, descripcion, precioMensual (COP), moneda,
 *   descuentoAnual (0..1), modulos (string[] rutas /app/*),
 *   esBase (bool), esEspecial (bool), baseId (plan del que se clonó),
 *   rangos ([{ hasta, precioMensual }], solo planes base): precio según el
 *   número de unidades del conjunto (ver ./pricing). En los planes base,
 *   precioMensual es solo el precio de referencia (rango 51–150 unidades).
 *
 * Cuando se consulta con un conjunto (catálogo del conjunto o su plan), cada
 * plan sale con el precio YA calculado para ese conjunto en precioMensual, más
 * precioReferencia, aLaMedida, rango y unidades.
 *
 * Unidades con las que se cobra: el MAYOR entre las declaradas por el conjunto
 * y las reales (unidades distintas de sus propietarios). Así un conjunto que
 * declara 40 y registra 63 propietarios paga el rango de 63, sin bloquearle la
 * creación de usuarios. Ver contarUnidades en ./pricing.
 */
const MIRROR_PLANES = 'mirror/planes';
const MIRROR_CONJUNTOS = 'mirror/conjuntos';
const MIRROR_USUARIOS = 'mirror/usuarios';

// Módulos (rutas) que SIEMPRE están disponibles, no dependen del plan.
export const MODULOS_SIEMPRE = ['/app/home', '/app/profile', '/app/settings'];

// Catálogo de módulos por plan (rutas del sidebar). Acumulativo: medio incluye
// lo de básico, premium incluye todo.
const MODULOS_BASICO = [
  '/app/noticias',
  '/app/pqrs',
  '/app/reports',
  '/app/reservations',
  '/app/zones',
  '/app/owners',
  '/app/agreements',
];
const MODULOS_MEDIO = [
  ...MODULOS_BASICO,
  '/app/guests',
  '/app/surveillance',
  '/app/events',
];
const MODULOS_PREMIUM = [
  ...MODULOS_MEDIO,
  '/app/payments',
  '/app/expenses',
  '/app/bulk-finance',
  '/app/kpi',
  '/app/roles',
];

/** Planes base sembrados. Precios en COP/mes; descuento 10% si paga el año. */
const PLANES_BASE = [
  {
    id: 'basico',
    nombre: 'Básico',
    descripcion:
      'Comunicación con residentes: noticias y cartelera digital, PQRS, reportes de la comunidad, reserva de zonas comunes, directorio de propietarios y acuerdos.',
    precioMensual: 130000,
    moneda: 'COP',
    descuentoAnual: 0.1,
    modulos: MODULOS_BASICO,
    rangos: RANGOS_DEFAULT.basico,
    esBase: true,
    esEspecial: false,
    baseId: '',
  },
  {
    id: 'medio',
    nombre: 'Portería y Citofonía',
    descripcion:
      'Todo lo del plan Básico más control de acceso para vigilantes, registro de invitados y eventos/asambleas del conjunto.',
    precioMensual: 200000,
    moneda: 'COP',
    descuentoAnual: 0.1,
    modulos: MODULOS_MEDIO,
    rangos: RANGOS_DEFAULT.medio,
    esBase: true,
    esEspecial: false,
    baseId: '',
  },
  {
    id: 'premium',
    nombre: 'Premium',
    descripcion:
      'Todo lo anterior más gestión de pagos y recaudo, gastos e ingresos, carga masiva, finanzas y reportes de cartera, y administración de roles.',
    precioMensual: 360000,
    moneda: 'COP',
    descuentoAnual: 0.1,
    modulos: MODULOS_PREMIUM,
    rangos: RANGOS_DEFAULT.premium,
    esBase: true,
    esEspecial: false,
    baseId: '',
  },
];

@Injectable()
export class PlansService {
  private readonly logger = new Logger(PlansService.name);

  constructor(private readonly firebase: FirebaseService) {}

  private safeKey(raw: unknown): string {
    return String(raw ?? '').trim().replace(/[.#$/\[\]]/g, '_');
  }

  private normList(raw: any): string[] {
    if (!Array.isArray(raw)) return [];
    return Array.from(new Set(raw.map((v) => String(v ?? '').trim()).filter(Boolean)));
  }

  private buildRecord(dto: any): Record<string, any> {
    return {
      id: String(dto.id),
      nombre: String(dto.nombre ?? ''),
      descripcion: String(dto.descripcion ?? ''),
      precioMensual: Number(dto.precioMensual) || 0,
      moneda: String(dto.moneda ?? 'COP'),
      descuentoAnual: Number(dto.descuentoAnual) >= 0 ? Number(dto.descuentoAnual) : 0.1,
      modulos: this.normList(dto.modulos),
      // Precio por número de unidades (solo planes base; los especiales tienen precio fijo).
      rangos: dto.esEspecial === true ? [] : normRangos(dto.rangos),
      esBase: dto.esBase === true,
      esEspecial: dto.esEspecial === true,
      baseId: String(dto.baseId ?? ''),
      // Conjunto dueño de un plan ESPECIAL. Los planes base no tienen conjunto
      // (visibles para todos). Un especial solo es visible para su conjunto.
      conjunto: String(dto.conjunto ?? ''),
      _fbWrite: true,
    };
  }

  private strip(p: any): any {
    const { _fbWrite, ...rest } = p;
    return {
      ...rest,
      precioMensual: Number(rest.precioMensual) || 0,
      descuentoAnual: Number(rest.descuentoAnual) || 0,
      modulos: this.normList(rest.modulos),
      rangos: rest.esEspecial === true ? [] : normRangos(rest.rangos),
      esBase: rest.esBase === true,
      esEspecial: rest.esEspecial === true,
      conjunto: String(rest.conjunto ?? ''),
    };
  }

  /**
   * Devuelve el plan con el precio calculado para un conjunto de `unidades`:
   * precioMensual pasa a ser lo que paga ESE conjunto (0 si es a la medida) y
   * se conserva el original en precioReferencia.
   */
  private conPrecio(plan: any, info: UnidadesInfo): any {
    const calc = precioPara(plan, info.efectivas);
    // ¿Las unidades reales lo movieron a un rango (o precio) distinto al declarado?
    const segunDeclaradas = precioPara(plan, info.declaradas);
    return {
      ...plan,
      precioReferencia: Number(plan.precioMensual) || 0,
      precioMensual: calc.precioMensual,
      aLaMedida: calc.aLaMedida,
      rango: calc.rango,
      unidades: info.efectivas,
      unidadesDeclaradas: info.declaradas,
      unidadesReales: info.reales,
      excedeUnidades: info.reales > info.declaradas,
      cambioDeRango:
        info.reales > info.declaradas &&
        (segunDeclaradas.aLaMedida !== calc.aLaMedida || segunDeclaradas.precioMensual !== calc.precioMensual),
    };
  }

  /** Siembra los planes base si faltan (idempotente). */
  private async ensureBase(): Promise<void> {
    const ref = this.firebase.db().ref(MIRROR_PLANES);
    const snap = await ref.get();
    const existentes = snap.exists() ? (snap.val() || {}) : {};
    for (const base of PLANES_BASE) {
      const key = this.safeKey(base.id);
      if (!existentes[key]) {
        try {
          await ref.child(key).set(this.buildRecord(base));
        } catch (e: any) {
          this.logger.warn(`[plans] no se pudo sembrar '${base.id}': ${e?.message}`);
        }
      } else if (normRangos(existentes[key].rangos).length === 0) {
        // Plan base creado antes de los precios por unidades: se le agrega la
        // tabla por defecto sin tocar el resto de sus datos.
        try {
          await ref.child(key).update({ rangos: base.rangos, _fbWrite: true });
        } catch (e: any) {
          this.logger.warn(`[plans] no se pudieron agregar rangos a '${base.id}': ${e?.message}`);
        }
      }
    }
  }

  /**
   * Lista el catálogo de planes (siembra los base si faltan).
   * - Sin `conjunto`: devuelve TODOS (uso del superAdmin en vista global).
   * - Con `conjunto`: devuelve los base + solo los ESPECIALES de ese conjunto
   *   (un plan especial solo es visible para el conjunto al que se creó).
   */
  async list(conjunto?: string): Promise<any[]> {
    if (!this.firebase.isEnabled()) throw new Error('Servicio no disponible.');
    await this.ensureBase();
    const snap = await this.firebase.db().ref(MIRROR_PLANES).get();
    let all = snap.exists() ? (Object.values(snap.val() || {}) as any[]) : [];
    const norm = (s: unknown) => String(s ?? '').trim().toLowerCase();
    const target = norm(conjunto);
    if (target) {
      all = all.filter((p) => p.esBase === true || norm(p.conjunto) === target);
    }
    let planes = all.map((p) => this.strip(p));
    if (target) {
      // Catálogo de un conjunto: cada plan con el precio para su tamaño.
      const info = await this.unidadesDe(String(conjunto));
      planes = planes.map((p) => this.conPrecio(p, info));
    }
    const orden = (p: any) => Number(p.precioReferencia ?? p.precioMensual) || 0;
    return planes.sort((a, b) => {
      // Base primero (por precio), luego los especiales.
      if (a.esBase !== b.esBase) return a.esBase ? -1 : 1;
      return orden(a) - orden(b);
    });
  }

  /**
   * Catálogo PÚBLICO para la landing (sin sesión): solo planes base, con su
   * tabla de precios por unidades. No incluye especiales ni datos de conjuntos.
   */
  async catalogoPublico(): Promise<any[]> {
    if (!this.firebase.isEnabled()) throw new Error('Servicio no disponible.');
    await this.ensureBase();
    const snap = await this.firebase.db().ref(MIRROR_PLANES).get();
    const all = snap.exists() ? (Object.values(snap.val() || {}) as any[]) : [];
    return all
      .map((p) => this.strip(p))
      .filter((p) => p.esBase === true)
      .sort((a, b) => (a.precioMensual || 0) - (b.precioMensual || 0))
      .map((p) => ({
        id: p.id,
        nombre: p.nombre,
        descripcion: p.descripcion,
        precioMensual: p.precioMensual,
        moneda: p.moneda,
        descuentoAnual: p.descuentoAnual,
        rangos: p.rangos,
        modulos: p.modulos,
      }));
  }

  /** Unidades declaradas, reales y efectivas (con las que se cobra) de un conjunto. */
  async unidadesDe(conjunto: string): Promise<UnidadesInfo> {
    if (!String(conjunto ?? '').trim()) return unidadesInfo(0, 0);
    const found = await this.findConjunto(conjunto);
    const reales = await this.unidadesReales(conjunto, found?.value?.nombre);
    return unidadesInfo(found?.value?.unidades, reales);
  }

  /** Unidades distintas ocupadas por los propietarios del conjunto (por nombre). */
  private async unidadesReales(conjunto: string, nombre?: unknown): Promise<number> {
    const norm = (s: unknown) => String(s ?? '').trim().toLowerCase();
    const objetivos = new Set([norm(conjunto), norm(nombre)].filter(Boolean));
    try {
      const usuarios = await this.firebase.liveValues<any>(MIRROR_USUARIOS);
      return contarUnidades(usuarios.filter((u) => objetivos.has(norm(u?.conjunto))));
    } catch (e: any) {
      // Si no se pueden leer los usuarios, se cobra con las declaradas.
      this.logger.warn(`[plans] no se pudieron contar las unidades de '${conjunto}': ${e?.message}`);
      return 0;
    }
  }

  /**
   * Precio que debe pagar un conjunto por un plan (lo usa el cobro con ePayco).
   * Solo acepta planes base o especiales del mismo conjunto.
   */
  async precioDeConjunto(conjunto: string, planId: string): Promise<{
    plan: any | null;
    precioMensual: number;
    aLaMedida: boolean;
  }> {
    const planes = await this.list(conjunto);
    const plan = planes.find((p: any) => p.id === planId) || null;
    return {
      plan,
      precioMensual: plan ? Number(plan.precioMensual) || 0 : 0,
      aLaMedida: plan?.aLaMedida === true,
    };
  }

  /** Guarda el número de unidades de un conjunto (superAdmin). */
  async setUnidades(conjunto: string, unidadesRaw: unknown): Promise<{ success: boolean; message?: string; unidades?: number }> {
    if (!this.firebase.isEnabled()) return { success: false, message: 'Servicio no disponible.' };
    const unidades = normUnidades(unidadesRaw);
    if (!unidades) return { success: false, message: 'El número de unidades debe ser un entero entre 1 y 10.000.' };
    const found = await this.findConjunto(conjunto);
    if (!found) return { success: false, message: 'El conjunto no existe.' };
    try {
      await this.firebase.db().ref(`${MIRROR_CONJUNTOS}/${found.key}`).update({ unidades, _fbWrite: true });
      return { success: true, unidades, message: 'Unidades actualizadas.' };
    } catch (err: any) {
      this.logger.error(`[plans] setUnidades ${conjunto} falló: ${err?.message}`);
      return { success: false, message: err?.message || 'No se pudieron guardar las unidades.' };
    }
  }

  /** Crea un plan ESPECIAL a partir de un plan base (clona módulos + precio custom). */
  async createEspecial(dto: {
    nombre: string; baseId: string; precioMensual: number; conjunto?: string; moneda?: string; descripcion?: string; descuentoAnual?: number;
  }): Promise<{ success: boolean; message?: string; id?: string }> {
    if (!this.firebase.isEnabled()) return { success: false, message: 'Servicio no disponible.' };
    if (!String(dto?.nombre ?? '').trim()) return { success: false, message: 'El nombre es requerido.' };
    if (!(Number(dto?.precioMensual) > 0)) return { success: false, message: 'El precio debe ser mayor a 0.' };

    await this.ensureBase();
    const base = PLANES_BASE.find((b) => b.id === dto.baseId)
      || (await this.getById(dto.baseId));
    const modulos = base?.modulos || MODULOS_BASICO;

    const id = `especial_${Date.now()}`;
    const record = this.buildRecord({
      id,
      nombre: dto.nombre,
      descripcion: dto.descripcion || `Plan especial basado en ${base?.nombre || dto.baseId}.`,
      precioMensual: dto.precioMensual,
      moneda: dto.moneda || 'COP',
      descuentoAnual: dto.descuentoAnual != null ? dto.descuentoAnual : 0.1,
      modulos,
      esBase: false,
      esEspecial: true,
      baseId: dto.baseId || '',
      // Dueño del plan especial: solo este conjunto lo verá en su catálogo.
      conjunto: dto.conjunto || '',
    });
    try {
      await this.firebase.db().ref(`${MIRROR_PLANES}/${this.safeKey(id)}`).set(record);
      return { success: true, id, message: 'Plan especial creado.' };
    } catch (err: any) {
      this.logger.error(`[plans] createEspecial falló: ${err?.message}`);
      return { success: false, message: err?.message || 'No se pudo crear el plan.' };
    }
  }

  private async getById(id: string): Promise<any | null> {
    const snap = await this.firebase.db().ref(`${MIRROR_PLANES}/${this.safeKey(id)}`).get();
    return snap.exists() ? this.strip(snap.val()) : null;
  }

  /**
   * Edita un plan. Los planes base no permiten cambiar sus módulos (solo
   * precio, descripción y su tabla de precios por unidades).
   */
  async update(id: string, dto: any): Promise<{ success: boolean; message?: string }> {
    if (!this.firebase.isEnabled()) return { success: false, message: 'Servicio no disponible.' };
    const key = this.safeKey(id);
    const ref = this.firebase.db().ref(`${MIRROR_PLANES}/${key}`);
    const snap = await ref.get();
    if (!snap.exists()) return { success: false, message: 'El plan no existe.' };
    const prev = snap.val() || {};
    if (dto.rangos !== undefined) {
      if (prev.esEspecial === true) {
        return { success: false, message: 'Los planes especiales tienen precio fijo; no usan rangos.' };
      }
      const err = validarRangos(dto.rangos);
      if (err) return { success: false, message: err };
    }
    try {
      const patch: Record<string, any> = { _fbWrite: true };
      if (dto.rangos !== undefined) patch.rangos = normRangos(dto.rangos);
      if (dto.nombre !== undefined) patch.nombre = String(dto.nombre);
      if (dto.descripcion !== undefined) patch.descripcion = String(dto.descripcion);
      if (dto.precioMensual !== undefined) patch.precioMensual = Number(dto.precioMensual) || 0;
      if (dto.moneda !== undefined) patch.moneda = String(dto.moneda);
      if (dto.descuentoAnual !== undefined) patch.descuentoAnual = Number(dto.descuentoAnual) || 0;
      // Los módulos solo se pueden cambiar en planes NO base (especiales).
      if (dto.modulos !== undefined && prev.esBase !== true) patch.modulos = this.normList(dto.modulos);
      await ref.update(patch);
      return { success: true, message: 'Plan actualizado.' };
    } catch (err: any) {
      this.logger.error(`[plans] update ${key} falló: ${err?.message}`);
      return { success: false, message: err?.message || 'No se pudo actualizar.' };
    }
  }

  /** Elimina un plan. Los planes base no se pueden eliminar. */
  async remove(id: string): Promise<{ success: boolean; message?: string }> {
    if (!this.firebase.isEnabled()) return { success: false, message: 'Servicio no disponible.' };
    const key = this.safeKey(id);
    const ref = this.firebase.db().ref(`${MIRROR_PLANES}/${key}`);
    const snap = await ref.get();
    if (!snap.exists()) return { success: true, message: 'El plan no existe.' };
    if ((snap.val() || {}).esBase === true) {
      return { success: false, message: 'Los planes base no se pueden eliminar.' };
    }
    try {
      await ref.remove();
      return { success: true, message: 'Plan eliminado.' };
    } catch (err: any) {
      this.logger.error(`[plans] delete ${key} falló: ${err?.message}`);
      return { success: false, message: err?.message || 'No se pudo eliminar.' };
    }
  }

  /** Busca el nodo del conjunto (por id o nombre). */
  private async findConjunto(conjunto: string): Promise<{ key: string; value: any } | null> {
    const snap = await this.firebase.db().ref(MIRROR_CONJUNTOS).get();
    if (!snap.exists()) return null;
    const norm = (s: unknown) => String(s ?? '').trim().toLowerCase();
    const target = norm(conjunto);
    const all = snap.val() || {};
    for (const k of Object.keys(all)) {
      const v = all[k];
      if (norm(v.id) === target || norm(v.nombre) === target) return { key: k, value: v };
    }
    return null;
  }

  /**
   * Plan BASE (no especial) por id, o null. Lo usa el autoregistro: un conjunto
   * nuevo solo puede elegir entre los planes del catálogo público.
   */
  async getBasePlan(planId: string): Promise<any | null> {
    if (!this.firebase.isEnabled() || !String(planId ?? '').trim()) return null;
    await this.ensureBase();
    const plan = await this.getById(planId);
    return plan && plan.esEspecial !== true ? plan : null;
  }

  /** Asigna un plan a un conjunto (guarda planId en su nodo). */
  async assign(conjunto: string, planId: string): Promise<{ success: boolean; message?: string }> {
    if (!this.firebase.isEnabled()) return { success: false, message: 'Servicio no disponible.' };
    if (!String(conjunto ?? '').trim()) return { success: false, message: 'Conjunto requerido.' };
    const plan = await this.getById(planId);
    if (!plan) return { success: false, message: 'El plan no existe.' };
    const found = await this.findConjunto(conjunto);
    if (!found) return { success: false, message: 'El conjunto no existe.' };
    try {
      await this.firebase.db().ref(`${MIRROR_CONJUNTOS}/${found.key}`).update({ planId, _fbWrite: true });
      return { success: true, message: 'Plan asignado al conjunto.' };
    } catch (err: any) {
      this.logger.error(`[plans] assign ${conjunto} falló: ${err?.message}`);
      return { success: false, message: err?.message || 'No se pudo asignar el plan.' };
    }
  }

  /**
   * Devuelve el plan efectivo de un conjunto. Si no tiene planId o el plan no
   * existe, devuelve el plan 'basico' (default), sembrándolo si hace falta.
   */
  async getPlanDeConjunto(conjunto: string): Promise<any> {
    await this.ensureBase();
    const basico = (await this.getById('basico')) || this.strip(this.buildRecord(PLANES_BASE[0]));
    const found = await this.findConjunto(conjunto);
    const info = unidadesInfo(found?.value?.unidades, await this.unidadesReales(conjunto, found?.value?.nombre));
    const planId = found?.value?.planId ? String(found.value.planId) : '';
    const plan = (planId && (await this.getById(planId))) || basico;
    return this.conPrecio(plan, info);
  }
}
