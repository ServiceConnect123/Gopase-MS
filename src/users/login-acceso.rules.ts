// ==========================================
// ¿Con qué inicia sesión cada usuario? — reglas puras (sin Firebase)
// ==========================================
// La cuenta siempre está amarrada al usuario que genera la app (uid). Además, el
// administrador escoge con qué dato se le dice a la persona que entre:
//   - documento: su cédula (o el número de documento que tenga)
//   - correo:    su correo
//   - usuario:   el usuario generado (como siempre)
// El usuario generado SIEMPRE sigue funcionando como respaldo.

export type LoginCon = 'documento' | 'correo' | 'usuario';

export const LOGIN_CON: LoginCon[] = ['documento', 'correo', 'usuario'];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const sinTildes = (s: unknown) =>
  String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const digitos = (s: unknown) => String(s ?? '').replace(/\D/g, '');

/** Acepta variantes ("Cédula", "CC", "email", "user"...). null si no se reconoce o viene vacío. */
export function normLoginCon(v: unknown): LoginCon | null {
  const t = sinTildes(v).replace(/[^a-z]/g, '');
  if (!t) return null;
  if (['documento', 'cedula', 'cc', 'doc', 'identificacion', 'numerodedocumento'].includes(t)) return 'documento';
  if (['correo', 'email', 'mail', 'correoelectronico', 'emailcorreo'].includes(t)) return 'correo';
  if (['usuario', 'user', 'username', 'usuariodelaapp', 'usuarioapp'].includes(t)) return 'usuario';
  return null;
}

/** Documento usable para entrar: solo dígitos y al menos 5. */
export const documentoLogin = (doc: unknown) => {
  const d = digitos(doc);
  return d.length >= 5 ? d : '';
};

export const correoLogin = (email: unknown) => {
  const e = String(email ?? '').trim().toLowerCase();
  return EMAIL_RE.test(e) ? e : '';
};

/** Por defecto: cédula; si no hay, correo; si tampoco, el usuario. */
export function loginConPorDefecto(d: { docNum?: unknown; documentNumber?: unknown; email?: unknown }): LoginCon {
  if (documentoLogin(d.docNum ?? d.documentNumber)) return 'documento';
  if (correoLogin(d.email)) return 'correo';
  return 'usuario';
}

/** Error si el método escogido no tiene el dato que necesita. */
export function validarLoginCon(
  loginCon: LoginCon,
  d: { docNum?: unknown; documentNumber?: unknown; email?: unknown },
): string | null {
  if (loginCon === 'documento' && !documentoLogin(d.docNum ?? d.documentNumber)) {
    return 'Para iniciar sesión con la cédula, registra el número de documento (mínimo 5 dígitos).';
  }
  if (loginCon === 'correo' && !correoLogin(d.email)) {
    return 'Para iniciar sesión con el correo, registra un correo válido.';
  }
  return null;
}

/** Valor con el que entra (para mostrarlo y para buscarlo al iniciar sesión). */
export function identificadorLogin(u: any): { tipo: LoginCon; valor: string } {
  const tipo = normLoginCon(u?.loginCon) || 'usuario';
  if (tipo === 'documento') {
    const v = documentoLogin(u?.docNum ?? u?.documentNumber);
    if (v) return { tipo, valor: v };
  }
  if (tipo === 'correo') {
    const v = correoLogin(u?.email);
    if (v) return { tipo, valor: v };
  }
  return { tipo: 'usuario', valor: String(u?.usuario ?? u?.id ?? '') };
}

/** Texto para mensajes: "tu cédula *1020304*". */
export function textoAcceso(u: any): { etiqueta: string; valor: string } {
  const { tipo, valor } = identificadorLogin(u);
  const etiqueta = tipo === 'documento' ? 'Cédula' : tipo === 'correo' ? 'Correo' : 'Usuario';
  return { etiqueta, valor };
}

const activo = (u: any) => sinTildes(u?.rol) !== 'desactivado';
const mismoConjunto = (a: unknown, b: unknown) => sinTildes(a) === sinTildes(b);

/**
 * ¿Otra persona del MISMO conjunto ya entra con ese dato? Dos cuentas no pueden
 * compartir cédula ni correo de acceso dentro de un conjunto (no sabríamos a cuál
 * entrar). Entre conjuntos sí: suele ser la misma persona y la contraseña decide.
 */
export function conflictoLogin(
  usuarios: any[],
  c: { usuario: string; conjunto: unknown; loginCon: LoginCon; docNum?: unknown; documentNumber?: unknown; email?: unknown },
): string | null {
  if (c.loginCon === 'usuario') return null;
  const propio = identificadorLogin({ ...c, loginCon: c.loginCon });
  if (propio.tipo === 'usuario') return null;
  const yo = sinTildes(c.usuario);
  const otro = (usuarios || []).find((u) => {
    if (!u || !activo(u) || sinTildes(u.usuario ?? u.id) === yo) return false;
    if (!mismoConjunto(u.conjunto, c.conjunto)) return false;
    const id = identificadorLogin(u);
    return id.tipo === propio.tipo && id.valor === propio.valor;
  });
  if (!otro) return null;
  const quien = String(otro.nombre || otro.usuario || '').trim();
  return propio.tipo === 'documento'
    ? `${quien} ya inicia sesión con la cédula ${propio.valor} en este conjunto.`
    : `${quien} ya inicia sesión con el correo ${propio.valor} en este conjunto.`;
}

/**
 * Cuentas que coinciden con lo que escribió la persona en el login (cédula o
 * correo), solo entre las que escogieron ese método. Devuelve los uid (claves).
 */
export function candidatosLogin(usuarios: Record<string, any>, ingresado: string, max = 10): string[] {
  const t = String(ingresado || '').trim();
  if (!t) return [];
  const out: string[] = [];
  const esCorreo = t.includes('@');
  const doc = esCorreo ? '' : /^[\d.\s-]+$/.test(t) ? documentoLogin(t) : '';
  const correo = esCorreo ? correoLogin(t) : '';
  if (!doc && !correo) return [];
  for (const [key, u] of Object.entries(usuarios || {})) {
    if (!u || !activo(u)) continue;
    const id = identificadorLogin({ ...u, usuario: u.usuario ?? key });
    if ((doc && id.tipo === 'documento' && id.valor === doc) || (correo && id.tipo === 'correo' && id.valor === correo)) {
      out.push(key);
      if (out.length >= max) break;
    }
  }
  return out;
}
