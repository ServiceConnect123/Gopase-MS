/**
 * Precio de un plan según el tamaño del conjunto (número de unidades:
 * apartamentos o casas). Funciones puras, sin acceso a Firebase, para poder
 * probarlas y reutilizarlas (catálogo, plan del conjunto, cobro con ePayco).
 *
 * Cada plan base tiene una tabla `rangos` ordenada de menor a mayor:
 *   [{ hasta: 50, precioMensual: 99000 }, { hasta: 150, ... }, { hasta: 300, ... }]
 * Un conjunto paga el precio del primer rango cuyo `hasta` sea >= sus unidades.
 * Si tiene más unidades que el último rango, el plan es "a la medida": no tiene
 * precio público y el superAdmin le crea un plan especial.
 *
 * Los planes especiales (y los que no tienen rangos) cobran su precioMensual fijo.
 */

export interface RangoPrecio {
  /** Máximo de unidades del rango (inclusive). */
  hasta: number;
  /** Precio mensual en la moneda del plan (COP). */
  precioMensual: number;
}

export interface PrecioCalculado {
  /** Precio mensual que le corresponde al conjunto (0 si es a la medida). */
  precioMensual: number;
  /** true si el conjunto supera el último rango: precio a la medida. */
  aLaMedida: boolean;
  /** Rango aplicado (desde..hasta unidades). null si no aplica (especial / sin unidades / a la medida). */
  rango: { desde: number; hasta: number } | null;
}

/** Tope razonable de unidades para un conjunto (evita valores absurdos). */
export const UNIDADES_MAX = 10000;

/** Tabla de precios por defecto de los planes base (COP/mes). */
export const RANGOS_DEFAULT: Record<string, RangoPrecio[]> = {
  basico: [
    { hasta: 50, precioMensual: 99000 },
    { hasta: 150, precioMensual: 130000 },
    { hasta: 300, precioMensual: 180000 },
  ],
  medio: [
    { hasta: 50, precioMensual: 150000 },
    { hasta: 150, precioMensual: 200000 },
    { hasta: 300, precioMensual: 280000 },
  ],
  premium: [
    { hasta: 50, precioMensual: 270000 },
    { hasta: 150, precioMensual: 360000 },
    { hasta: 300, precioMensual: 500000 },
  ],
};

/** Número entero de unidades válido (1..UNIDADES_MAX) o 0 si no es válido / no se informó. */
export function normUnidades(raw: unknown): number {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n < 1 || n > UNIDADES_MAX) return 0;
  return n;
}

/**
 * Limpia una tabla de rangos: descarta filas inválidas, ordena por `hasta` y
 * quita `hasta` repetidos (se queda con la primera). Devuelve [] si no hay
 * filas válidas. RTDB puede devolver los arrays como objetos {0:..,1:..}.
 */
export function normRangos(raw: unknown): RangoPrecio[] {
  const lista: any[] = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object'
      ? Object.values(raw as Record<string, unknown>)
      : [];
  const vistos = new Set<number>();
  return lista
    .map((r) => ({
      hasta: Math.floor(Number(r?.hasta)),
      precioMensual: Math.round(Number(r?.precioMensual)),
    }))
    .filter((r) => Number.isFinite(r.hasta) && r.hasta >= 1 && r.hasta <= UNIDADES_MAX)
    .filter((r) => Number.isFinite(r.precioMensual) && r.precioMensual > 0)
    .sort((a, b) => a.hasta - b.hasta)
    .filter((r) => (vistos.has(r.hasta) ? false : (vistos.add(r.hasta), true)));
}

/**
 * Valida una tabla de rangos enviada por el superAdmin. Devuelve un mensaje de
 * error o null si es válida. Exige al menos un rango, sin filas inválidas.
 */
export function validarRangos(raw: unknown): string | null {
  if (!Array.isArray(raw) || raw.length === 0) return 'Debes enviar al menos un rango de precios.';
  const limpios = normRangos(raw);
  if (limpios.length !== raw.length) {
    return 'Cada rango necesita un máximo de unidades distinto (1 a 10.000) y un precio mayor a 0.';
  }
  return null;
}

/**
 * Precio que le corresponde a un conjunto con `unidades` en el plan dado.
 * - Plan especial o sin rangos: su precioMensual fijo.
 * - Conjunto sin unidades registradas (conjuntos antiguos): precioMensual de referencia del plan.
 * - Más unidades que el último rango: a la medida (precio 0).
 */
export function precioPara(
  plan: { precioMensual?: unknown; rangos?: unknown; esEspecial?: unknown },
  unidadesRaw: unknown,
): PrecioCalculado {
  const fijo = Number(plan?.precioMensual) || 0;
  const rangos = normRangos(plan?.rangos);
  if (plan?.esEspecial === true || rangos.length === 0) {
    return { precioMensual: fijo, aLaMedida: false, rango: null };
  }
  const unidades = normUnidades(unidadesRaw);
  if (!unidades) return { precioMensual: fijo, aLaMedida: false, rango: null };

  let desde = 1;
  for (const r of rangos) {
    if (unidades <= r.hasta) {
      return { precioMensual: r.precioMensual, aLaMedida: false, rango: { desde, hasta: r.hasta } };
    }
    desde = r.hasta + 1;
  }
  return { precioMensual: 0, aLaMedida: true, rango: null };
}

/** Monto a cobrar según el ciclo: anual = 12 meses con el descuento del plan. */
export function montoPorCiclo(precioMensual: number, ciclo: string, descuentoAnual: unknown): number {
  const d = Number(descuentoAnual);
  const desc = Number.isFinite(d) && d >= 0 && d < 1 ? d : 0.1;
  return ciclo === 'anual' ? Math.round(precioMensual * 12 * (1 - desc)) : Math.round(precioMensual);
}

// ---------------------------------------------------------------------------
// Unidades REALES del conjunto (las que usa), para no depender solo de las
// declaradas al registrarse. El precio se calcula con el MAYOR de los dos.
// ---------------------------------------------------------------------------

/**
 * Clave normalizada de una unidad a partir de la `parcela` del propietario
 * (casa/apartamento/torre). Ignora mayúsculas, tildes, signos y palabras como
 * "casa", "apto" o "torre", para que "Casa 5", "casa #5" y "5" cuenten igual.
 * Devuelve '' si no hay nada que identifique la unidad.
 */
export function claveUnidad(raw: unknown): string {
  return String(raw ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\b(casa|casas|apto|apt|apartamento|torre|lote|parcela|unidad|interior|int|bloque|manzana|mz|no|numero|nro|num)\b\.?/g, ' ')
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Cuenta las unidades distintas que ocupan los PROPIETARIOS de un conjunto.
 * Varios propietarios con la misma parcela (familia, copropietarios) cuentan
 * como una unidad. Un propietario sin parcela cuenta como una unidad propia,
 * para que dejar el campo vacío no reduzca el conteo.
 */
export function contarUnidades(usuarios: Array<{ rol?: unknown; parcela?: unknown }>): number {
  const claves = new Set<string>();
  let sinParcela = 0;
  for (const u of usuarios || []) {
    if (String(u?.rol ?? '').trim().toLowerCase() !== 'propietario') continue;
    const k = claveUnidad(u?.parcela);
    if (k) claves.add(k);
    else sinParcela++;
  }
  return claves.size + sinParcela;
}

export interface UnidadesInfo {
  /** Las que el conjunto declaró (registro o superAdmin). 0 si no hay. */
  declaradas: number;
  /** Las que tiene en uso según sus propietarios. */
  reales: number;
  /** Con las que se cobra: el mayor de los dos. */
  efectivas: number;
}

export function unidadesInfo(declaradasRaw: unknown, reales: number): UnidadesInfo {
  const declaradas = normUnidades(declaradasRaw);
  const r = Math.max(0, Math.floor(Number(reales) || 0));
  return { declaradas, reales: r, efectivas: Math.max(declaradas, Math.min(r, UNIDADES_MAX)) };
}
