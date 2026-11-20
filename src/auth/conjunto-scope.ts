import type { FirebaseService } from '../firebase/firebase.service';

/**
 * Conjunto al que se debe limitar un LISTADO cuando el request no indica uno.
 *
 * Sin esto, `GET /users` o `GET /events` sin `?conjunto=` devolvían los datos
 * de TODOS los conjuntos (teléfonos, emails, documentos...) a cualquier usuario
 * autenticado: el ConjuntoMembershipGuard solo valida cuando el request trae un
 * conjunto.
 *
 * Devuelve:
 *   - `null`  => sin restricción (superAdmin, o guard JWT apagado: sin req.user).
 *   - string  => nombre del conjunto propio (o su id si no hay nombre). Cadena
 *                vacía si el usuario no tiene conjunto registrado: el caller
 *                debe responder lista vacía en ese caso.
 *
 * Se resuelve desde la caché en vivo de mirror/usuarios (sin ir a la red).
 */
export async function conjuntoPropioDelRequest(
  req: any,
  firebase: FirebaseService,
): Promise<string | null> {
  const user = req?.user;
  if (!user) return null;
  if (String(user.rol || '').toLowerCase() === 'superadmin') return null;

  const key = String(user.sub ?? '').trim().replace(/[.#$/\[\]]/g, '_');
  if (key && firebase.isEnabled()) {
    try {
      const usuarios = (await firebase.liveVal<Record<string, any>>('mirror/usuarios')) || {};
      const perfil = usuarios[key];
      const nombre = String(perfil?.conjunto ?? '').trim();
      if (nombre) return nombre;
      const id = String(perfil?.conjuntoId ?? '').trim();
      if (id) return id;
    } catch {
      // cae al conjuntoId del token
    }
  }
  return String(user.conjuntoId ?? '').trim();
}
