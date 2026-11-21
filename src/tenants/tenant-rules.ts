/**
 * Reglas de los ARRENDATARIOS (rol "inquilino"). Funciones puras, sin Firebase,
 * para poder probarlas y usarlas desde login, guards, pagos y la API.
 *
 * Un arrendatario es un usuario normal (mirror/usuarios) con rol "inquilino" y
 * un bloque `inquilino` con su arriendo:
 *   propietario        username del propietario que lo creó (dueño de la unidad)
 *   propietarioNombre  nombre del propietario (para mostrar)
 *   tipo               'arriendo' (largo plazo). Las estadías cortas vienen después.
 *   inicio, fin        'YYYY-MM-DD'. `fin` vacío = sin fecha de fin (hasta que se retire).
 *   pagaAdministracion el propietario le delega pagar la administración de la unidad
 *   puedeReservar      puede reservar zonas comunes
 *   revocado           el propietario (o el admin) le retiró el acceso
 *
 * El arrendatario usa la MISMA unidad (parcela) y conjunto del propietario. No
 * tiene cartera propia: los pagos son de la unidad (cuenta del propietario) y
 * no cuenta como unidad para el precio del plan.
 */

export const ROL_INQUILINO = 'inquilino';

export type EstadoInquilino = 'activo' | 'programado' | 'vencido' | 'revocado';

export interface DatosInquilino {
  propietario?: string;
  propietarioNombre?: string;
  tipo?: string;
  inicio?: string;
  fin?: string;
  pagaAdministracion?: boolean;
  puedeReservar?: boolean;
  revocado?: boolean;
  creadoPor?: string;
  creadoEn?: string;
}

const norm = (s: unknown) => String(s ?? '').trim().toLowerCase();

export function esInquilino(rol: unknown): boolean {
  return norm(rol) === ROL_INQUILINO;
}

/**
 * ¿El rol tiene cartera propia (cuotas de administración)? No la tienen el
 * superAdmin, el vigilante ni el arrendatario (paga, si acaso, la del propietario).
 */
export function tieneCartera(rol: unknown): boolean {
  const r = norm(rol);
  return r !== 'superadmin' && r !== 'vigilante' && r !== ROL_INQUILINO;
}

/** 'YYYY-MM-DD' válido o ''. */
export function normFecha(raw: unknown): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(raw ?? '').trim());
  if (!m) return '';
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (d.getFullYear() !== Number(m[1]) || d.getMonth() !== Number(m[2]) - 1 || d.getDate() !== Number(m[3])) return '';
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/** Fecha local de hoy en 'YYYY-MM-DD'. */
export function hoyISO(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/** Estado del arriendo hoy. Las fechas son inclusivas (el día `fin` aún tiene acceso). */
export function estadoInquilino(datos: DatosInquilino | null | undefined, hoy: string = hoyISO()): EstadoInquilino {
  if (!datos || datos.revocado === true) return 'revocado';
  const inicio = normFecha(datos.inicio);
  const fin = normFecha(datos.fin);
  if (inicio && hoy < inicio) return 'programado';
  if (fin && hoy > fin) return 'vencido';
  return 'activo';
}

/** dd/mm/aaaa para mensajes. */
function fechaTexto(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}

/** Mensaje para el arrendatario cuando no puede entrar (null si está activo). */
export function mensajeAccesoInquilino(datos: DatosInquilino | null | undefined, hoy: string = hoyISO()): string | null {
  const estado = estadoInquilino(datos, hoy);
  if (estado === 'activo') return null;
  if (estado === 'programado') {
    return `Tu acceso como arrendatario empieza el ${fechaTexto(normFecha(datos?.inicio))}.`;
  }
  if (estado === 'vencido') {
    return `Tu acceso como arrendatario venció el ${fechaTexto(normFecha(datos?.fin))}. Pídele al propietario que lo renueve.`;
  }
  return 'Tu acceso como arrendatario fue retirado. Si es un error, habla con el propietario de la unidad.';
}

/**
 * Segundos hasta el final del día `fin` (para que el JWT del arrendatario no
 * dure más que su arriendo). null si no tiene fin. Mínimo 60 s.
 */
export function segundosHastaFin(fin: unknown, now: Date = new Date()): number | null {
  const f = normFecha(fin);
  if (!f) return null;
  const [y, m, d] = f.split('-').map(Number);
  const finDia = new Date(y, m - 1, d, 23, 59, 59).getTime();
  return Math.max(60, Math.floor((finDia - now.getTime()) / 1000));
}

/**
 * Valida y normaliza el arriendo que envía el propietario. Devuelve el error
 * o los datos limpios.
 */
export function validarArriendo(input: {
  inicio?: unknown;
  fin?: unknown;
  pagaAdministracion?: unknown;
  puedeReservar?: unknown;
}): { error: string } | { datos: Required<Pick<DatosInquilino, 'inicio' | 'fin' | 'pagaAdministracion' | 'puedeReservar'>> } {
  const inicio = normFecha(input.inicio);
  if (!inicio) return { error: 'Indica la fecha de inicio del arriendo.' };
  const finRaw = String(input.fin ?? '').trim();
  const fin = normFecha(finRaw);
  if (finRaw && !fin) return { error: 'La fecha de fin no es válida.' };
  if (fin && fin < inicio) return { error: 'La fecha de fin no puede ser anterior a la de inicio.' };
  return {
    datos: {
      inicio,
      fin,
      pagaAdministracion: input.pagaAdministracion === true,
      puedeReservar: input.puedeReservar === true,
    },
  };
}

/** Lo que la app necesita saber del arriendo de quien inició sesión. */
export function resumenParaSesion(usuario: any): {
  propietario: string;
  propietarioNombre: string;
  parcela: string;
  inicio: string;
  fin: string;
  estado: EstadoInquilino;
  pagaAdministracion: boolean;
  puedeReservar: boolean;
} {
  const d: DatosInquilino = usuario?.inquilino || {};
  return {
    propietario: String(d.propietario || ''),
    propietarioNombre: String(d.propietarioNombre || d.propietario || ''),
    parcela: String(usuario?.parcela || ''),
    inicio: normFecha(d.inicio),
    fin: normFecha(d.fin),
    estado: estadoInquilino(d),
    pagaAdministracion: d.pagaAdministracion === true,
    puedeReservar: d.puedeReservar === true,
  };
}

/**
 * ¿Este arrendatario (registro de mirror/usuarios) puede pagar hoy la
 * administración de la cuenta `cuenta`? Solo si el arriendo está vigente, el
 * propietario se lo delegó y `cuenta` es la de ese propietario.
 */
export function puedePagarPorCuenta(usuario: any, cuenta: unknown, hoy: string = hoyISO()): boolean {
  if (!usuario || !esInquilino(usuario.rol)) return false;
  const d: DatosInquilino = usuario.inquilino || {};
  return (
    estadoInquilino(d, hoy) === 'activo' &&
    d.pagaAdministracion === true &&
    norm(d.propietario) !== '' &&
    norm(d.propietario) === norm(cuenta)
  );
}
