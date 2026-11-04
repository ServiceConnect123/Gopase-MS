// ==========================================
// billing · fechas de cobro de un conjunto
// ==========================================
// Única fuente de verdad de "cuándo debe pagar" y "cuándo se corta el acceso".
// La usan BillingService (para bloquear) y PropertiesService (para mostrar), de
// modo que lo que ve el superAdmin y el administrador es exactamente lo que se aplica.
//
// Regla:
//   pagadoHasta  = último día cubierto por el pago (o por la prueba gratis).
//   fechaPago    = pagadoHasta + 1 día  (el día en que le toca pagar).
//   vencimiento  = fechaPago + DIAS_GRACIA días (último día con acceso).
//   Pasado el vencimiento se corta el acceso.
//
// Fases:
//   al_dia  -> hoy <= pagadoHasta
//   gracia  -> pagadoHasta < hoy <= vencimiento  (debe pagar, aún tiene acceso)
//   vencido -> hoy > vencimiento                 (acceso cortado)

/** Días que se le dejan al conjunto para pagar después de la fecha de pago. */
export const DIAS_GRACIA = 10;

export type FaseCobro = 'al_dia' | 'gracia' | 'vencido';

export interface Cobro {
  fase: FaseCobro;
  /** YYYY-MM-DD: día en que le toca pagar (pagadoHasta + 1). */
  fechaPago: string;
  /** YYYY-MM-DD: último día con acceso (fechaPago + DIAS_GRACIA). */
  vencimiento: string;
  /** Días calendario de hoy a la fecha de pago (negativo si ya pasó). */
  diasParaPago: number;
  /** Días calendario de hoy al vencimiento (0 = vence hoy, negativo = ya venció). */
  diasParaVencimiento: number;
}

export function toISODate(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/** Medianoche local del día de `d`. */
export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

/** Días calendario de `desde` a `hasta` (redondeado: inmune al cambio de hora). */
export function diasEntre(desde: Date, hasta: Date): number {
  return Math.round((startOfDay(hasta).getTime() - startOfDay(desde).getTime()) / 86_400_000);
}

/** 'YYYY-MM-DD' (o ISO) -> Date a medianoche local; null si no es válida. */
export function parseDia(raw: unknown): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(raw ?? ''));
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Calcula fase y fechas de cobro a partir del último día pagado/cubierto.
 * Se compara por DÍA calendario: todo el día de `pagadoHasta` y todo el día del
 * vencimiento siguen contando como vigentes.
 */
export function calcCobro(pagadoHasta: Date, hoy: Date, diasGracia: number = DIAS_GRACIA): Cobro {
  const fechaPago = addDays(startOfDay(pagadoHasta), 1);
  const vencimiento = addDays(fechaPago, diasGracia);
  const diasParaPago = diasEntre(hoy, fechaPago);
  const diasParaVencimiento = diasEntre(hoy, vencimiento);
  const fase: FaseCobro = diasParaPago > 0 ? 'al_dia' : diasParaVencimiento >= 0 ? 'gracia' : 'vencido';
  return {
    fase,
    fechaPago: toISODate(fechaPago),
    vencimiento: toISODate(vencimiento),
    diasParaPago,
    diasParaVencimiento,
  };
}

/**
 * Último día cubierto de un conjunto: durante la prueba gratis es `trialHasta`;
 * en cualquier otro caso, `pagadoHasta`. null si no tiene ninguno todavía.
 */
export function baseDeCobro(c: any): Date | null {
  if (c?.trial === true) return parseDia(c?.trialHasta) ?? parseDia(c?.pagadoHasta);
  return parseDia(c?.pagadoHasta);
}

/** Cobro de un conjunto (nodo de mirror/conjuntos) o null si aún no tiene fechas. */
export function cobroDeConjunto(c: any, hoy: Date = new Date()): Cobro | null {
  const base = baseDeCobro(c);
  return base ? calcCobro(base, hoy) : null;
}
