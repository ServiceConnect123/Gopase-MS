// ==========================================
// Política de contraseñas (servidor)
// ==========================================
// Debe mantenerse alineada con el frontend (src/utils/passwordPolicy.ts):
//   >= 8 caracteres, 1 mayúscula, 1 minúscula, 1 número, 1 carácter especial.
// Se valida también en el backend para que la API rechace contraseñas débiles
// aunque la petición no venga desde la UI.

export const PASSWORD_MIN_LENGTH = 8;

/** Regex monolítico equivalente a todas las reglas de complejidad. */
export const PASSWORD_REGEX =
  /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{8,}$/;

/**
 * Valida una contraseña contra la política. Devuelve un mensaje de error legible
 * si no cumple, o null si es válida.
 */
export function validatePasswordPolicy(password: string): string | null {
  const p = String(password ?? '');
  if (p.length < PASSWORD_MIN_LENGTH) {
    return `La contraseña debe tener al menos ${PASSWORD_MIN_LENGTH} caracteres.`;
  }
  if (!/[A-Z]/.test(p)) return 'La contraseña debe incluir al menos una letra mayúscula.';
  if (!/[a-z]/.test(p)) return 'La contraseña debe incluir al menos una letra minúscula.';
  if (!/[0-9]/.test(p)) return 'La contraseña debe incluir al menos un número.';
  if (!/[^A-Za-z0-9]/.test(p)) return 'La contraseña debe incluir al menos un carácter especial.';
  return null;
}
