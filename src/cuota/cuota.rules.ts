// ==========================================
// Cuota de administración: tarifas y métodos de recaudo — reglas puras
// ==========================================
// Datos en mirror/conjuntos/{key}:
//   cuotaMonto         la TARIFA BASE (la cuota que el conjunto ya tenía; por eso
//                      no hay migración: lo que existía pasa a ser la base).
//   tarifas            { [id]: { nombre, valor, desc, activo, creadaEn } }
//   metodosRecaudo     { [id]: { tipo: 'breb'|'banco', ..., activo, principal } }
//   llaveBreB          se mantiene sincronizada con la llave Bre-B principal
//                      activa, para las pantallas y validaciones que la leen.
// Cada unidad (perfil en mirror/usuarios) puede tener `tarifaId`; sin ella, o si
// la tarifa está inactiva, paga la base.

import { tieneCartera } from '../tenants/tenant-rules';

export interface Tarifa {
  id: string;
  nombre: string;
  valor: number;
  desc: string;
  activo: boolean;
  creadaEn?: string;
}

export type TipoMetodo = 'breb' | 'banco';

export interface MetodoRecaudo {
  id: string;
  tipo: TipoMetodo;
  // Bre-B
  tipoLlave?: string;
  llave?: string;
  // Banco
  banco?: string;
  tipoCuenta?: 'Ahorros' | 'Corriente';
  numero?: string;
  nit?: string;
  titular: string;
  activo: boolean;
  principal: boolean;
}

/** Bancos y billeteras admitidos (ids estables; el front pone los logos). */
export const BANCOS: Record<string, string> = {
  bancolombia: 'Bancolombia',
  bogota: 'Banco de Bogotá',
  davivienda: 'Davivienda',
  bbva: 'BBVA',
  occidente: 'Banco de Occidente',
  popular: 'Banco Popular',
  avvillas: 'Banco AV Villas',
  cajasocial: 'Banco Caja Social',
  colpatria: 'Scotiabank Colpatria',
  itau: 'Itaú',
  agrario: 'Banco Agrario',
  falabella: 'Banco Falabella',
  pichincha: 'Banco Pichincha',
  nequi: 'Nequi',
  daviplata: 'Daviplata',
  nu: 'Nu Colombia',
  lulo: 'Lulo Bank',
};

export const TIPOS_LLAVE = ['Celular', 'Cédula / NIT', 'Correo', 'Alfanumérica'];

const txt = (v: unknown, max = 120) => String(v ?? '').trim().slice(0, max);
const digitos = (v: unknown) => String(v ?? '').replace(/\D/g, '');
export const num = (v: unknown) => Number(String(v ?? '').replace(/[^\d]/g, '')) || 0;
const sinTildes = (s: unknown) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

/** Tarifas del registro del conjunto como lista ordenada por nombre. */
export function listaTarifas(conj: any): Tarifa[] {
  const raw = conj?.tarifas && typeof conj.tarifas === 'object' ? conj.tarifas : {};
  return Object.entries(raw)
    .map(([id, t]: [string, any]) => ({
      id,
      nombre: txt(t?.nombre, 60),
      valor: num(t?.valor),
      desc: txt(t?.desc, 300),
      activo: t?.activo !== false,
      creadaEn: t?.creadaEn ? String(t.creadaEn) : undefined,
    }))
    .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
}

/** Valida y limpia una tarifa. Error en español si no sirve. */
export function validarTarifa(
  dto: any,
  existentes: Tarifa[],
  id?: string,
): { ok: true; tarifa: Omit<Tarifa, 'id'> } | { ok: false; message: string } {
  const nombre = txt(dto?.nombre, 60);
  const valor = num(dto?.valor);
  if (!nombre) return { ok: false, message: 'Escribe un nombre para identificar la tarifa.' };
  if (sinTildes(nombre) === 'tarifa base') return { ok: false, message: '«Tarifa base» es el nombre de la tarifa predeterminada.' };
  if (existentes.some((t) => t.id !== id && sinTildes(t.nombre) === sinTildes(nombre))) {
    return { ok: false, message: 'Ya existe una tarifa con ese nombre.' };
  }
  if (!valor || valor <= 0) return { ok: false, message: 'El valor mensual debe ser mayor que 0.' };
  if (valor > 100_000_000) return { ok: false, message: 'El valor mensual es demasiado alto.' };
  return { ok: true, tarifa: { nombre, valor, desc: txt(dto?.desc, 300), activo: dto?.activo !== false } };
}

/** Métodos del conjunto. Si no hay lista pero sí `llaveBreB`, esa llave es el primero (principal). */
export function listaMetodos(conj: any): MetodoRecaudo[] {
  const raw = conj?.metodosRecaudo && typeof conj.metodosRecaudo === 'object' ? conj.metodosRecaudo : null;
  if (!raw || !Object.keys(raw).length) {
    const llave = txt(conj?.llaveBreB, 80);
    if (!llave) return [];
    return [{
      id: 'breb-principal', tipo: 'breb', tipoLlave: tipoLlaveDe(llave), llave,
      titular: txt(conj?.nombre, 120), activo: true, principal: true,
    }];
  }
  return metodosDeObjeto(raw);
}

function tipoLlaveDe(llave: string): string {
  if (llave.includes('@') && !llave.startsWith('@')) return 'Correo';
  if (llave.startsWith('@')) return 'Alfanumérica';
  const d = digitos(llave);
  if (d.length === 10 && d.startsWith('3')) return 'Celular';
  if (d.length >= 5 && d.length === llave.replace(/[\s.-]/g, '').length) return 'Cédula / NIT';
  return 'Alfanumérica';
}

export function normalizarMetodo(m: any): MetodoRecaudo {
  const tipo: TipoMetodo = m?.tipo === 'banco' ? 'banco' : 'breb';
  const base = { id: String(m?.id || ''), tipo, titular: txt(m?.titular, 120), activo: m?.activo !== false, principal: m?.principal === true };
  if (tipo === 'breb') {
    const tl = TIPOS_LLAVE.includes(m?.tipoLlave) ? m.tipoLlave : tipoLlaveDe(txt(m?.llave, 80));
    return { ...base, tipoLlave: tl, llave: txt(m?.llave, 80) };
  }
  return {
    ...base,
    banco: BANCOS[m?.banco] ? m.banco : '',
    tipoCuenta: m?.tipoCuenta === 'Corriente' ? 'Corriente' : 'Ahorros',
    numero: digitos(m?.numero).slice(0, 20),
    nit: txt(m?.nit, 20),
  };
}

export function validarMetodo(m: MetodoRecaudo): string | null {
  if (!m.titular) return 'Escribe el titular.';
  if (m.tipo === 'breb') {
    if (!m.llave) return 'Escribe la llave Bre-B.';
    return null;
  }
  if (!m.banco) return 'Selecciona el banco.';
  if ((m.numero || '').length < 6) return 'Escribe el número de cuenta (mínimo 6 dígitos).';
  if (digitos(m.nit).length < 5) return 'Escribe el NIT o la cédula del titular.';
  return null;
}

/**
 * Garantiza las reglas de la lista: siempre hay exactamente un principal y está
 * activo (si hay algún activo). Devuelve la lista corregida.
 */
export function ajustarPrincipal(lista: MetodoRecaudo[], preferido?: string): MetodoRecaudo[] {
  const activos = lista.filter((m) => m.activo);
  if (!activos.length) return lista.map((m) => ({ ...m, principal: false }));
  const elegido =
    (preferido && activos.find((m) => m.id === preferido)) ||
    activos.find((m) => m.principal) ||
    activos[0];
  return lista.map((m) => ({ ...m, principal: m.id === elegido.id }));
}

/** Llave Bre-B a guardar en `llaveBreB` (compatibilidad): la principal, o la primera Bre-B activa. */
export function llaveCompat(lista: MetodoRecaudo[]): string {
  const brebs = lista.filter((m) => m.activo && m.tipo === 'breb' && m.llave);
  const p = brebs.find((m) => m.principal) || brebs[0];
  return p?.llave || '';
}

/** Texto corto de un método para mostrar o para la IA ("Bancolombia ahorros 2093…"). */
export function describirMetodo(m: MetodoRecaudo): string {
  if (m.tipo === 'breb') return `Llave Bre-B ${m.llave}`;
  return `${BANCOS[m.banco || ''] || 'Banco'} ${String(m.tipoCuenta || '').toLowerCase()} ${m.numero}`;
}

/** Cuentas/llaves a las que un comprobante válido pudo haber sido enviado. */
export function destinosValidos(lista: MetodoRecaudo[]): string[] {
  return lista.filter((m) => m.activo).map((m) => (m.tipo === 'breb' ? String(m.llave) : String(m.numero))).filter(Boolean);
}

/** Lo que ve un propietario: solo activos, número completo (lo necesita para transferir). */
export function metodosPublicos(lista: MetodoRecaudo[]) {
  return lista
    .filter((m) => m.activo)
    .map((m) => ({
      id: m.id, tipo: m.tipo, principal: m.principal, titular: m.titular,
      ...(m.tipo === 'breb'
        ? { tipoLlave: m.tipoLlave, llave: m.llave }
        : { banco: m.banco, bancoNombre: BANCOS[m.banco || ''] || '', tipoCuenta: m.tipoCuenta, numero: m.numero, nit: m.nit }),
    }));
}

// ---------------------------------------------------------------------------
// Operaciones sobre una lista de métodos (puras). Las usan los métodos de
// recaudo del conjunto y las cuentas de GoPase (cobro de suscripciones).
// ---------------------------------------------------------------------------

type Op<T = {}> = ({ ok: true; lista: MetodoRecaudo[] } & T) | { ok: false; message: string };
const normLlave = (s: unknown) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, '');

/** Crea (sin id) o edita un método. `dto.principal === true` lo vuelve el principal. */
export function opGuardarMetodo(lista: MetodoRecaudo[], dto: any, id?: string, nuevoId?: string): Op<{ id: string }> {
  const previo = id ? lista.find((m) => m.id === id) : undefined;
  if (id && !previo) return { ok: false, message: 'El método no existe.' };
  const mid = id || nuevoId || `m${Date.now().toString(36)}`;
  const m = normalizarMetodo({ ...(previo || {}), ...dto, id: mid, activo: previo ? previo.activo : true, principal: previo?.principal });
  const err = validarMetodo(m);
  if (err) return { ok: false, message: err };
  const dup = lista.find((x) => x.id !== mid && x.tipo === m.tipo && (m.tipo === 'breb' ? normLlave(x.llave) === normLlave(m.llave) : x.banco === m.banco && x.numero === m.numero));
  if (dup) return { ok: false, message: 'Ese método ya está registrado.' };
  let nueva = previo ? lista.map((x) => (x.id === mid ? m : x)) : lista.concat([m]);
  nueva = ajustarPrincipal(nueva, dto?.principal === true ? mid : undefined);
  return { ok: true, lista: nueva, id: mid };
}

/** Activa/desactiva o marca como principal. `quien` nombra a los que pagan (para el mensaje). */
export function opCambiarMetodo(lista: MetodoRecaudo[], id: string, patch: { activo?: boolean; principal?: boolean }, quien = 'los propietarios'): Op<{ aviso?: string }> {
  const m = lista.find((x) => x.id === id);
  if (!m) return { ok: false, message: 'El método no existe.' };
  let nueva = lista;
  let aviso: string | undefined;
  if (patch.activo === false && m.activo) {
    if (!nueva.some((x) => x.id !== id && x.activo)) {
      return { ok: false, message: `No puedes desactivar el único método activo: ${quien} no tendrían a dónde pagar.` };
    }
    nueva = nueva.map((x) => (x.id === id ? { ...x, activo: false, principal: false } : x));
    if (m.principal) {
      nueva = ajustarPrincipal(nueva);
      const p = nueva.find((x) => x.principal);
      aviso = `${p?.tipo === 'breb' ? 'La llave Bre-B' : BANCOS[p?.banco || ''] || 'Otro método'} es ahora el método principal.`;
    }
  } else if (patch.activo === true && !m.activo) {
    nueva = ajustarPrincipal(nueva.map((x) => (x.id === id ? { ...x, activo: true } : x)));
  }
  if (patch.principal === true) {
    if (!nueva.find((x) => x.id === id)!.activo) return { ok: false, message: 'Activa el método antes de hacerlo principal.' };
    nueva = ajustarPrincipal(nueva, id);
  }
  return { ok: true, lista: nueva, aviso };
}

export function opEliminarMetodo(lista: MetodoRecaudo[], id: string): Op {
  const m = lista.find((x) => x.id === id);
  if (!m) return { ok: false, message: 'El método no existe.' };
  if (m.activo && !lista.some((x) => x.id !== id && x.activo)) return { ok: false, message: 'No puedes eliminar el único método activo.' };
  return { ok: true, lista: ajustarPrincipal(lista.filter((x) => x.id !== id)) };
}

/** Lista → objeto para RTDB (clave = id, sin campos undefined). */
export function metodosAObjeto(lista: MetodoRecaudo[]): Record<string, any> {
  const obj: Record<string, any> = {};
  lista.forEach(({ id, ...rest }) => { obj[id] = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)); });
  return obj;
}

/** Objeto de RTDB → lista ordenada (principal, activos, inactivos). */
export function metodosDeObjeto(raw: any): MetodoRecaudo[] {
  if (!raw || typeof raw !== 'object') return [];
  return Object.entries(raw)
    .map(([id, m]: [string, any]) => normalizarMetodo({ ...m, id }))
    .sort((a, b) => Number(b.principal) - Number(a.principal) || Number(b.activo) - Number(a.activo));
}

/** Id de banco a partir de un nombre libre ("Bancolombia", "banco de bogotá"…). */
export function bancoPorNombre(nombre: unknown): string {
  const n = String(nombre ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/^banco\s+(de\s+)?/, '').trim();
  if (!n) return '';
  if (BANCOS[n]) return n;
  const hit = Object.entries(BANCOS).find(([, v]) => {
    const vv = v.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/^banco\s+(de\s+)?/, '');
    return vv === n || vv.includes(n) || n.includes(vv);
  });
  return hit ? hit[0] : '';
}

/**
 * Tarifa que paga un usuario: la asignada si existe y está activa; si no, la base.
 * Un inquilino que paga la administración usa la de la unidad (su propietario):
 * eso lo resuelve quien llama pasando el perfil del propietario.
 */
export function tarifaDeUsuario(conj: any, usuario: any): { id: string | null; nombre: string; valor: number; esBase: boolean } {
  const base = num(conj?.cuotaMonto);
  const id = String(usuario?.tarifaId || '').trim();
  if (id) {
    const t = listaTarifas(conj).find((x) => x.id === id);
    if (t && t.activo) return { id: t.id, nombre: t.nombre, valor: t.valor, esBase: false };
  }
  return { id: null, nombre: 'Tarifa base', valor: base, esBase: true };
}

/** Unidades por tarifa (propietarios activos del conjunto) y recaudo esperado al mes. */
export function resumenTarifas(conj: any, usuarios: any[]) {
  const tarifas = listaTarifas(conj);
  // Pagan cuota: propietarios, y otros roles con cartera que tengan unidad (p. ej. un admin residente).
  const propietarios = (usuarios || []).filter((u) => {
    const r = sinTildes(u?.rol);
    if (r === 'desactivado' || !tieneCartera(r)) return false;
    return r === 'propietario' || !!String(u?.parcela ?? u?.dato_10 ?? '').trim();
  });
  const porTarifa: Record<string, number> = {};
  let base = 0;
  let esperado = 0;
  for (const u of propietarios) {
    const t = tarifaDeUsuario(conj, u);
    if (t.esBase) base++;
    else porTarifa[t.id as string] = (porTarifa[t.id as string] || 0) + 1;
    esperado += t.valor;
  }
  return {
    base: { valor: num(conj?.cuotaMonto), unidades: base },
    tarifas: tarifas.map((t) => ({ ...t, unidades: porTarifa[t.id] || 0 })),
    unidades: propietarios.length,
    esperado,
  };
}
