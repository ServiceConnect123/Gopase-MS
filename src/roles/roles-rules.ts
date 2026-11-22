/**
 * Reglas de roles y permisos (diseño "GoPase · Roles y permisos").
 *
 *  - Roles del sistema: admin, vigilante, propietario, inquilino y superAdmin.
 *    Solo el superAdmin los edita; no se eliminan.
 *  - Roles personalizados: siempre de un conjunto. Los crea el superAdmin (eligiendo
 *    el conjunto) o el admin (solo para su conjunto).
 *  - Permisos: solo las vistas asignables. Las vistas exclusivas del superAdmin
 *    (Roles, Conjuntos, Monitoreo, Facturación) y las que todos ven (Inicio,
 *    Perfil, Configuración) no se guardan en un rol.
 */
export const ROLES_SISTEMA = ['superadmin', 'admin', 'vigilante', 'propietario', 'inquilino'];

export const VISTAS_ASIGNABLES = [
  '/app/payments', '/app/expenses', '/app/bulk-finance', '/app/kpi', '/app/reports',
  '/app/noticias', '/app/avisos', '/app/owners', '/app/inquilinos', '/app/zones', '/app/reservations',
  '/app/guests', '/app/events', '/app/pqrs', '/app/agreements',
  '/app/surveillance',
];

/** Versión del formato de permisos: con v2 los permisos del rol mandan en el menú. */
export const VERSION_PERMISOS = 2;

const norm = (s: unknown) => String(s ?? '').trim().toLowerCase();

export const esRolSistema = (idOrName: unknown) => ROLES_SISTEMA.includes(norm(idOrName));

/** El rol (registro) es del sistema por su id o por su nombre. */
export const rolEsDelSistema = (r: { id?: unknown; name?: unknown; nombre?: unknown }) =>
  esRolSistema(r?.id) || esRolSistema(r?.name ?? r?.nombre);

/**
 * Normaliza la lista de permisos a [{ path, name, status }] solo con vistas
 * asignables (sin duplicados). Acepta strings o objetos.
 */
export function limpiarPermisos(raw: any): Array<{ path: string; name: string; status: boolean }> {
  const lista = Array.isArray(raw) ? raw : [];
  const vistos = new Set<string>();
  const out: Array<{ path: string; name: string; status: boolean }> = [];
  for (const p of lista) {
    const path = String(typeof p === 'string' ? p : p?.path ?? '').trim();
    if (!VISTAS_ASIGNABLES.includes(path) || vistos.has(path)) continue;
    vistos.add(path);
    const status = typeof p === 'string' ? true : p?.status === true;
    out.push({ path, name: String(typeof p === 'string' ? '' : p?.name ?? '').slice(0, 60), status });
  }
  return out;
}
