import { ForbiddenException } from '@nestjs/common';
import type { FirebaseService } from '../firebase/firebase.service';
import { conjuntoPropioDelRequest } from './conjunto-scope';
import { Actor, Objetivo, puedeAsignar, puedeGestionar } from './user-admin.rules';

const safeKey = (raw: unknown) => String(raw ?? '').trim().replace(/[.#$/\[\]]/g, '_');

/** Actor del request, o null si el guard JWT está apagado (modo legado, no restringe). */
export async function actorDelRequest(req: any, firebase: FirebaseService): Promise<Actor | null> {
  const user = req?.user;
  if (!user) return null;
  const conjunto = String((await conjuntoPropioDelRequest(req, firebase)) ?? '');
  return { uid: String(user.sub ?? user.usuario ?? ''), rol: String(user.rol ?? ''), conjunto };
}

/** Datos del usuario objetivo leídos de la caché en vivo de mirror/usuarios. */
export async function objetivoDe(username: string, firebase: FirebaseService): Promise<Objetivo> {
  const uid = String(username ?? '').trim();
  let perfil: any = null;
  if (uid && firebase.isEnabled()) {
    const usuarios = (await firebase.liveVal<Record<string, any>>('mirror/usuarios')) || {};
    perfil = usuarios[safeKey(uid)] ?? null;
  }
  return {
    uid,
    existe: !!perfil,
    rol: String(perfil?.rol ?? ''),
    conjunto: String(perfil?.conjunto ?? perfil?.conjuntoId ?? ''),
  };
}

/**
 * Lanza 403 si el usuario del token no puede gestionar a `username`.
 * Con el guard JWT apagado (sin req.user) no restringe, como el resto de guards.
 */
export async function assertPuedeGestionar(
  req: any,
  firebase: FirebaseService,
  username: string,
  opts: { permitirPropio: boolean; nuevoRol?: string; nuevoConjunto?: string },
): Promise<void> {
  const actor = await actorDelRequest(req, firebase);
  if (!actor) return;
  const objetivo = await objetivoDe(username, firebase);
  const d = puedeGestionar(actor, objetivo, opts.permitirPropio);
  if (!d.ok) throw new ForbiddenException(d.motivo);
  if (opts.nuevoRol !== undefined || opts.nuevoConjunto !== undefined) {
    const a = puedeAsignar(actor, objetivo, opts.nuevoRol, opts.nuevoConjunto);
    if (!a.ok) throw new ForbiddenException(a.motivo);
  }
}
