/**
 * Reglas de los ARRENDATARIOS (rol "inquilino"). Funciones puras, sin Firebase,
 * para poder probarlas y usarlas desde login, guards, pagos y la API.
 *
 * Un inquilino es un usuario normal (mirror/usuarios) con rol "inquilino" y
 * un bloque `inquilino` con su arriendo:
 *   propietario        username del propietario que lo creó (dueño de la unidad)
 *   propietarioNombre  nombre del propietario (para mostrar)
 *   tipo               'arriendo' (largo plazo). Las estadías cortas vienen después.
 *   inicio, fin        'YYYY-MM-DD'. `fin` vacío = sin fecha de fin (hasta que se retire).
 *   pagaAdministracion el propietario le delega pagar la administración de la unidad
 *   puedeReservar      puede reservar zonas comunes
 *   revocado           el propietario (o el admin) le retiró el acceso
 *
 * El inquilino usa la MISMA unidad (parcela) y conjunto del propietario. No
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
 * superAdmin, el vigilante ni el inquilino (paga, si acaso, la del propietario).
 */
export function tieneCartera(rol: unknown): boolean {
  const r = norm(rol);
  return r !== 'superadmin' && r !== 'vigilante' && r !== ROL_INQUILINO;
}

/**
 * Inquilinos con los datos de su propiedad y de su propietario, tomados del
 * propietario en vivo (si el propietario cambia de unidad o de teléfono, el
 * inquilino lo refleja sin editarlo):
 *   - parcela, conjunto y conjuntoId: los del propietario (si los tiene).
 *   - propietarioUsuario, propietarioNombre, propietarioTelefono, propietarioEmail.
 * Los demás usuarios pasan igual. No modifica los objetos recibidos.
 */
export function conPropietario<T extends Record<string, any>>(usuarios: T[]): T[] {
  const porUsuario = new Map<string, any>();
  for (const u of usuarios) {
    const k = norm(u?.usuario ?? u?.id);
    if (k) porUsuario.set(k, u);
  }
  return usuarios.map((u) => {
    if (!esInquilino(u?.rol)) return u;
    const d = (u.inquilino && typeof u.inquilino === 'object' ? u.inquilino : {}) as DatosInquilino;
    const dueno = porUsuario.get(norm(d.propietario));
    if (!dueno) {
      return { ...u, propietarioUsuario: d.propietario || '', propietarioNombre: d.propietarioNombre || d.propietario || '' };
    }
    const nombre = String(dueno.nombre || d.propietarioNombre || d.propietario || '');
    return {
      ...u,
      parcela: dueno.parcela || u.parcela || '',
      conjunto: dueno.conjunto || u.conjunto || '',
      conjuntoId: dueno.conjuntoId || u.conjuntoId || '',
      propietarioUsuario: String(dueno.usuario || d.propietario || ''),
      propietarioNombre: nombre,
      propietarioTelefono: String(dueno.phone || ''),
      propietarioEmail: String(dueno.email || ''),
      inquilino: { ...d, propietarioNombre: nombre },
    };
  });
}

/** 'YYYY-MM-DD' válido o ''. */
export function normFecha(raw: unknown): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(raw ?? '').trim());
  if (!m) return '';
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (d.getFullYear() !== Number(m[1]) || d.getMonth() !== Number(m[2]) - 1 || d.getDate() !== Number(m[3])) return '';
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/**
 * Zona horaria de los conjuntos (Colombia, UTC-5 todo el año, sin horario de
 * verano). El servidor corre en UTC: sin esto, desde las 7 p. m. hora Colombia
 * "hoy" ya sería mañana (arriendos, estadías e invitados se cerraban antes).
 */
export const ZONA_COLOMBIA = 'America/Bogota';
const OFFSET_COLOMBIA = '-05:00';

/** Fecha de hoy en Colombia, 'YYYY-MM-DD'. */
export function hoyISO(now: Date = new Date()): string {
  // en-CA da el formato AAAA-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone: ZONA_COLOMBIA, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** Hora de Colombia para mostrar: "3:16 p. m.". */
export function horaColombia(now: Date = new Date()): string {
  const partes = new Intl.DateTimeFormat('en-US', { timeZone: ZONA_COLOMBIA, hour: 'numeric', minute: '2-digit', hour12: true }).formatToParts(now);
  const h = partes.find((x) => x.type === 'hour')?.value ?? '';
  const m = partes.find((x) => x.type === 'minute')?.value ?? '';
  const pm = (partes.find((x) => x.type === 'dayPeriod')?.value ?? '').toUpperCase() === 'PM';
  return `${h}:${m} ${pm ? 'p. m.' : 'a. m.'}`;
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

/** Mensaje para el inquilino cuando no puede entrar (null si está activo). */
export function mensajeAccesoInquilino(datos: DatosInquilino | null | undefined, hoy: string = hoyISO()): string | null {
  const estado = estadoInquilino(datos, hoy);
  if (estado === 'activo') return null;
  if (estado === 'programado') {
    return `Tu acceso como inquilino empieza el ${fechaTexto(normFecha(datos?.inicio))}.`;
  }
  if (estado === 'vencido') {
    return `Tu acceso como inquilino venció el ${fechaTexto(normFecha(datos?.fin))}. Pídele al propietario que lo renueve.`;
  }
  return 'Tu acceso como inquilino fue retirado. Si es un error, habla con el propietario de la unidad.';
}

/**
 * Segundos hasta el final del día `fin` (para que el JWT del inquilino no
 * dure más que su arriendo). null si no tiene fin. Mínimo 60 s.
 */
export function segundosHastaFin(fin: unknown, now: Date = new Date()): number | null {
  const f = normFecha(fin);
  if (!f) return null;
  // Fin del día en hora Colombia (no del servidor).
  const finDia = Date.parse(`${f}T23:59:59${OFFSET_COLOMBIA}`);
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
 * ¿Este inquilino (registro de mirror/usuarios) puede pagar hoy la
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
