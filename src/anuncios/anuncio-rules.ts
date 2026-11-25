/**
 * Reglas puras de los anuncios de GoPase (sin Firebase), para poder probarlas.
 *
 * Un anuncio es publicidad de la propia plataforma (redes sociales, novedades)
 * que el superAdmin crea y que cada usuario ve UNA sola vez, en un modal al
 * entrar a la app. Cada vista queda registrada para medir el alcance.
 */

export const ROLES_AUDIENCIA = ['admin', 'propietario', 'inquilino', 'vigilante'] as const;

export interface Anuncio {
  id: string;
  titulo: string;
  mensaje: string;
  imagenUrl: string;
  /** Texto del botón principal (p. ej. «Seguir en TikTok»). Vacío = sin botón. */
  ctaTexto: string;
  ctaUrl: string;
  activo: boolean;
  /** Roles que lo ven (en minúscula). Vacío = todos. */
  roles: string[];
  /** Conjuntos que lo ven (por nombre). Vacío = todos. */
  conjuntos: string[];
  /** Fechas ISO (YYYY-MM-DD) opcionales de vigencia, inclusivas. */
  desde: string;
  hasta: string;
  /** Mayor prioridad se muestra primero cuando hay varios pendientes. */
  prioridad: number;
  creadoPor: string;
  creadoEn: string;
  actualizadoEn: string;
}

export interface VistaAnuncio {
  usuario: string;
  nombre: string;
  rol: string;
  conjunto: string;
  /** Primera vez que se mostró (ISO). */
  vistoEn: string;
  /** Si tocó el botón del anuncio. */
  clic: boolean;
  clicEn: string;
}

export const norm = (s: unknown) => String(s ?? '').trim().toLowerCase();
export const safeKey = (raw: unknown) => String(raw ?? '').trim().replace(/[.#$/\[\]]/g, '_');

const URL_OK = /^https?:\/\/[^\s]+$/i;
const FECHA_OK = /^\d{4}-\d{2}-\d{2}$/;

function lista(raw: unknown, normalizar: (s: string) => string): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of raw) {
    const s = normalizar(String(v ?? '').trim());
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

/** Limpia y valida lo que envía el superAdmin. Devuelve el anuncio o un error legible. */
export function validarAnuncio(dto: any, previo?: Partial<Anuncio>): { ok: true; anuncio: Omit<Anuncio, 'id' | 'creadoPor' | 'creadoEn' | 'actualizadoEn'> } | { ok: false; error: string } {
  const titulo = String(dto?.titulo ?? previo?.titulo ?? '').trim().slice(0, 80);
  const mensaje = String(dto?.mensaje ?? previo?.mensaje ?? '').trim().slice(0, 500);
  const imagenUrl = String(dto?.imagenUrl ?? previo?.imagenUrl ?? '').trim();
  const ctaTexto = String(dto?.ctaTexto ?? previo?.ctaTexto ?? '').trim().slice(0, 40);
  const ctaUrl = String(dto?.ctaUrl ?? previo?.ctaUrl ?? '').trim();
  const desde = String(dto?.desde ?? previo?.desde ?? '').trim();
  const hasta = String(dto?.hasta ?? previo?.hasta ?? '').trim();

  if (!titulo) return { ok: false, error: 'El título es requerido.' };
  if (!mensaje && !imagenUrl) return { ok: false, error: 'Escribe un mensaje o agrega una imagen.' };
  if (imagenUrl && !URL_OK.test(imagenUrl)) return { ok: false, error: 'La URL de la imagen debe empezar por http:// o https://.' };
  if (ctaTexto && !ctaUrl) return { ok: false, error: 'El botón necesita un enlace.' };
  if (ctaUrl && !URL_OK.test(ctaUrl)) return { ok: false, error: 'El enlace del botón debe empezar por http:// o https://.' };
  if (desde && !FECHA_OK.test(desde)) return { ok: false, error: 'La fecha «desde» debe tener formato AAAA-MM-DD.' };
  if (hasta && !FECHA_OK.test(hasta)) return { ok: false, error: 'La fecha «hasta» debe tener formato AAAA-MM-DD.' };
  if (desde && hasta && desde > hasta) return { ok: false, error: 'La fecha «desde» no puede ser posterior a «hasta».' };

  const roles = lista(dto?.roles ?? previo?.roles, norm).filter((r) => (ROLES_AUDIENCIA as readonly string[]).includes(r));
  const conjuntos = lista(dto?.conjuntos ?? previo?.conjuntos, (s) => s);
  const prioridadRaw = Number(dto?.prioridad ?? previo?.prioridad ?? 0);
  const prioridad = Number.isFinite(prioridadRaw) ? Math.max(0, Math.min(100, Math.round(prioridadRaw))) : 0;
  const activo = dto?.activo !== undefined ? dto.activo === true : previo?.activo !== false;

  return {
    ok: true,
    anuncio: {
      titulo, mensaje, imagenUrl,
      ctaTexto: ctaUrl ? ctaTexto || 'Ver más' : '',
      ctaUrl,
      activo, roles, conjuntos, desde, hasta, prioridad,
    },
  };
}

/** Fecha de hoy en Colombia (YYYY-MM-DD), para comparar vigencias. */
export function hoyColombia(ahora = new Date()): string {
  return new Date(ahora.getTime() - 5 * 3600 * 1000).toISOString().slice(0, 10);
}

/** ¿Este anuncio aplica a este usuario hoy? (no mira si ya lo vio). */
export function aplicaA(a: Partial<Anuncio>, rol: string, conjunto: string, hoy: string): boolean {
  if (!a || a.activo === false) return false;
  const r = norm(rol);
  if (r === 'superadmin') return false; // el superAdmin no es audiencia
  if (a.desde && hoy < a.desde) return false;
  if (a.hasta && hoy > a.hasta) return false;
  const roles = Array.isArray(a.roles) ? a.roles.map(norm) : [];
  if (roles.length && !roles.includes(r)) return false;
  const conjs = Array.isArray(a.conjuntos) ? a.conjuntos.map(norm) : [];
  if (conjs.length && !conjs.includes(norm(conjunto))) return false;
  return true;
}

/**
 * El anuncio que le toca ver al usuario: el de mayor prioridad (y el más
 * reciente en empate) que le aplica y que todavía no ha visto. null si ninguno.
 */
export function anuncioPendiente(
  anuncios: Partial<Anuncio>[],
  vistosPorAnuncio: Record<string, Record<string, unknown> | undefined>,
  usuario: string,
  rol: string,
  conjunto: string,
  hoy: string,
): Partial<Anuncio> | null {
  const key = safeKey(usuario);
  if (!key) return null;
  const candidatos = anuncios
    .filter((a) => a?.id && aplicaA(a, rol, conjunto, hoy))
    .filter((a) => !vistosPorAnuncio[safeKey(a.id)]?.[key])
    .sort((x, y) => (Number(y.prioridad) || 0) - (Number(x.prioridad) || 0) || String(y.creadoEn || '').localeCompare(String(x.creadoEn || '')));
  return candidatos[0] || null;
}

export interface MetricasAnuncio {
  vistas: number;
  clics: number;
  /** clics / vistas, 0..1 */
  tasaClic: number;
  porRol: Record<string, number>;
  porConjunto: Record<string, number>;
  /** Vistas por día (YYYY-MM-DD en hora Colombia). */
  porDia: Record<string, number>;
  ultimaVista: string;
}

export function metricas(vistas: Partial<VistaAnuncio>[]): MetricasAnuncio {
  const porRol: Record<string, number> = {};
  const porConjunto: Record<string, number> = {};
  const porDia: Record<string, number> = {};
  let clics = 0;
  let ultimaVista = '';
  for (const v of vistas) {
    const rol = norm(v.rol) || 'sin rol';
    const conj = String(v.conjunto || '').trim() || 'Sin conjunto';
    porRol[rol] = (porRol[rol] || 0) + 1;
    porConjunto[conj] = (porConjunto[conj] || 0) + 1;
    if (v.vistoEn) {
      const dia = hoyColombia(new Date(v.vistoEn));
      porDia[dia] = (porDia[dia] || 0) + 1;
      if (v.vistoEn > ultimaVista) ultimaVista = v.vistoEn;
    }
    if (v.clic) clics++;
  }
  const total = vistas.length;
  return { vistas: total, clics, tasaClic: total ? clics / total : 0, porRol, porConjunto, porDia, ultimaVista };
}
