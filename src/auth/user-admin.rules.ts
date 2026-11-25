/**
 * Quién puede leer o modificar la cuenta de otro usuario.
 *
 * Antes, /profile/update y /users/:username aceptaban cualquier usuario objetivo:
 * un propietario podía cambiarle la contraseña o el rol a otro (incluido el
 * superAdmin). Estas reglas son puras (sin Firebase) para poder probarlas.
 *
 *  - superAdmin: todo.
 *  - Uno mismo: puede leer y editar su perfil (no su rol ni su conjunto).
 *  - Personal del conjunto (admin o rol personalizado, p. ej. contador o consejo):
 *    solo usuarios de SU conjunto, nunca a un admin ni a un superAdmin.
 *    Los roles personalizados los crea la administración para su equipo, por eso
 *    cuentan como personal; propietario, inquilino y vigilante no.
 *  - Asignar rol admin: solo superAdmin o admin. Asignar superAdmin: solo superAdmin.
 */

export interface Actor {
  uid: string;
  rol: string;
  conjunto: string;
}

export interface Objetivo {
  uid: string;
  rol?: string;
  conjunto?: string;
  /** false si el usuario objetivo aún no existe (alta). */
  existe: boolean;
}

const norm = (s: unknown) => String(s ?? '').trim().toLowerCase();

/** Roles que NO administran a otros usuarios. */
const ROLES_RESIDENTES = ['propietario', 'inquilino', 'vigilante', ''];

export const esSuperAdmin = (rol: unknown) => norm(rol) === 'superadmin';
export const esAdmin = (rol: unknown) => norm(rol) === 'admin';
/** admin o rol personalizado del conjunto (personal de administración). */
export const esPersonal = (rol: unknown) => !esSuperAdmin(rol) && !ROLES_RESIDENTES.includes(norm(rol));

export type Decision = { ok: true } | { ok: false; motivo: string };

const NO = (motivo: string): Decision => ({ ok: false, motivo });
const SI: Decision = { ok: true };

/**
 * ¿El actor puede leer o editar al objetivo?
 * @param permitirPropio  true para perfil/edición propia; false para acciones que
 *                        solo hace la administración (borrar, resetear clave).
 */
export function puedeGestionar(actor: Actor, objetivo: Objetivo, permitirPropio: boolean): Decision {
  if (esSuperAdmin(actor.rol)) return SI;
  const mismo = norm(actor.uid) !== '' && norm(actor.uid) === norm(objetivo.uid);
  if (mismo) return permitirPropio ? SI : NO('Esta acción la hace la administración.');
  if (!esPersonal(actor.rol)) return NO('No tienes permiso para gestionar a otros usuarios.');
  if (!norm(actor.conjunto)) return NO('Tu usuario no tiene conjunto.');
  if (objetivo.existe) {
    if (esSuperAdmin(objetivo.rol)) return NO('No puedes modificar a un superAdmin.');
    if (esAdmin(objetivo.rol) && !esAdmin(actor.rol)) return NO('No puedes modificar a un administrador.');
    if (esAdmin(objetivo.rol) && esAdmin(actor.rol)) return NO('Un administrador no puede modificar a otro administrador.');
    if (norm(objetivo.conjunto) !== norm(actor.conjunto)) return NO('Ese usuario no es de tu conjunto.');
  }
  return SI;
}

/**
 * ¿El actor puede dejar al objetivo con `nuevoRol` (y en `nuevoConjunto`)?
 * Se llama solo si el body trae rol/conjunto.
 */
export function puedeAsignar(
  actor: Actor,
  objetivo: Objetivo,
  nuevoRol: string | undefined,
  nuevoConjunto: string | undefined,
): Decision {
  if (esSuperAdmin(actor.rol)) return SI;
  const rolActual = norm(objetivo.rol);
  const rolNuevo = nuevoRol === undefined ? undefined : norm(nuevoRol);
  const cambiaRol = rolNuevo !== undefined && rolNuevo !== '' && (!objetivo.existe || rolNuevo !== rolActual);
  if (cambiaRol) {
    if (rolNuevo === 'superadmin') return NO('Solo un superAdmin asigna ese rol.');
    if (rolNuevo === 'admin' && !esAdmin(actor.rol)) return NO('Solo la administración asigna el rol administrador.');
    if (!esPersonal(actor.rol)) return NO('No puedes cambiar tu rol.');
  }
  if (nuevoConjunto !== undefined && norm(nuevoConjunto) !== '' && norm(nuevoConjunto) !== norm(actor.conjunto)) {
    return NO('No puedes mover usuarios a otro conjunto.');
  }
  return SI;
}
