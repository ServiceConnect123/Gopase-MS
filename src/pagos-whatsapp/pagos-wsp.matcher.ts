import { esInquilino, estadoInquilino, tieneCartera } from '../tenants/tenant-rules';
import { PagoWspParseado, normTelefono } from './pagos-wsp.parser';

/**
 * Identifica a quién corresponde un pago enviado por WhatsApp, dentro del
 * conjunto del número vinculado: por usuario, documento o teléfono escritos en
 * el mensaje o, si no escribió ninguno, por el teléfono que lo envía.
 */

export interface UsuarioWsp {
  usuario: string;
  nombre?: string;
  rol?: string;
  phone?: string;
  telefono?: string;
  docNum?: string;
  documentNumber?: string;
  conjunto?: string;
  parcela?: string;
  inquilino?: any;
}

export type ResultadoMatch =
  | {
      ok: true;
      /** Persona identificada (propietario o inquilino). */
      persona: UsuarioWsp;
      /** Cuenta de cartera donde va el pago (el propietario si es inquilino). */
      cuenta: UsuarioWsp;
      via: 'usuario' | 'documento' | 'telefono' | 'remitente';
      /** El que envía no es el titular identificado. */
      enviadoPorOtro: boolean;
      pagadoPor: { usuario: string; nombre: string; rol: string } | null;
    }
  | { ok: false; motivo: 'sin_identificador' | 'no_encontrado' | 'ambiguo' | 'sin_cartera' | 'inquilino_sin_permiso' };

const n = (s: unknown) => String(s ?? '').trim().toLowerCase();
const doc = (u: UsuarioWsp) => String(u.docNum ?? u.documentNumber ?? '').replace(/\D/g, '');
const tel = (u: UsuarioWsp) => normTelefono(u.phone ?? u.telefono);

function cuentaDe(persona: UsuarioWsp, todos: UsuarioWsp[]):
  | { ok: true; cuenta: UsuarioWsp; pagadoPor: { usuario: string; nombre: string; rol: string } | null }
  | { ok: false; motivo: 'sin_cartera' | 'inquilino_sin_permiso' } {
  if (esInquilino(persona.rol)) {
    const d = persona.inquilino || {};
    const dueno = todos.find((u) => n(u.usuario) === n(d.propietario));
    if (!dueno || d.pagaAdministracion !== true || estadoInquilino(d) !== 'activo') return { ok: false, motivo: 'inquilino_sin_permiso' };
    return { ok: true, cuenta: dueno, pagadoPor: { usuario: persona.usuario, nombre: String(persona.nombre || persona.usuario), rol: 'inquilino' } };
  }
  if (!tieneCartera(persona.rol)) return { ok: false, motivo: 'sin_cartera' };
  return { ok: true, cuenta: persona, pagadoPor: null };
}

export function identificarPagador(params: {
  usuarios: UsuarioWsp[];
  conjunto: string;
  parseado: PagoWspParseado;
  telefonoRemitente?: string;
}): ResultadoMatch {
  const conj = n(params.conjunto);
  const delConjunto = params.usuarios.filter((u) => n(u.conjunto) === conj && n(u.usuario));
  const remitente = normTelefono(params.telefonoRemitente);
  const id = params.parseado.identificador;

  let candidatos: UsuarioWsp[] = [];
  let via: 'usuario' | 'documento' | 'telefono' | 'remitente' = 'remitente';
  if (id) {
    const v = id.valor;
    if (id.tipo === 'usuario') {
      candidatos = delConjunto.filter((u) => n(u.usuario) === n(v));
      via = 'usuario';
    } else if (id.tipo === 'documento') {
      candidatos = delConjunto.filter((u) => doc(u) && doc(u) === v.replace(/\D/g, ''));
      via = 'documento';
    } else if (id.tipo === 'telefono') {
      candidatos = delConjunto.filter((u) => tel(u) && tel(u) === normTelefono(v));
      via = 'telefono';
    } else {
      // Número sin etiqueta: puede ser teléfono o documento.
      const porTel = delConjunto.filter((u) => tel(u) && tel(u) === normTelefono(v));
      const porDoc = delConjunto.filter((u) => doc(u) && doc(u) === v);
      const distintos = new Set([...porTel, ...porDoc].map((u) => n(u.usuario)));
      if (distintos.size > 1) return { ok: false, motivo: 'ambiguo' };
      candidatos = porTel.length ? porTel : porDoc;
      via = porTel.length ? 'telefono' : 'documento';
    }
  } else {
    if (!remitente) return { ok: false, motivo: 'sin_identificador' };
    candidatos = delConjunto.filter((u) => tel(u) && tel(u) === remitente);
  }

  // Varias cuentas con el mismo teléfono (p. ej. dos unidades): preferir las que tienen cartera.
  if (candidatos.length > 1) {
    const conCartera = candidatos.filter((u) => tieneCartera(u.rol));
    if (conCartera.length === 1) candidatos = conCartera;
  }
  if (candidatos.length === 0) return { ok: false, motivo: id ? 'no_encontrado' : 'sin_identificador' };
  if (candidatos.length > 1) return { ok: false, motivo: 'ambiguo' };

  const persona = candidatos[0];
  const c = cuentaDe(persona, params.usuarios);
  if (!c.ok) return c;
  const enviadoPorOtro = !!remitente && tel(persona) !== remitente;
  return { ok: true, persona, cuenta: c.cuenta, via, enviadoPorOtro, pagadoPor: c.pagadoPor };
}

/** Nombre corto para confirmar sin exponer datos: "Alex G." */
export function nombreCorto(nombre: unknown): string {
  const partes = String(nombre ?? '').trim().split(/\s+/).filter(Boolean);
  if (!partes.length) return 'Propietario';
  return partes.length === 1 ? partes[0] : `${partes[0]} ${partes[1][0].toUpperCase()}.`;
}

/** Mensaje para el remitente cuando no se pudo identificar al propietario. */
export const MENSAJE_MATCH: Record<Exclude<ResultadoMatch, { ok: true }>['motivo'], string> = {
  sin_identificador:
    'No pude identificar a quién corresponde el pago. Escribe tu usuario, documento o teléfono, por ejemplo:\n#pago Usuario: tu_usuario',
  no_encontrado: 'No encontré ese usuario, documento o teléfono en el conjunto. Revisa el dato y vuelve a enviar el comprobante.',
  ambiguo: 'Ese número coincide con más de una persona. Usa la etiqueta, por ejemplo:\n#pago Usuario: tu_usuario',
  sin_cartera: 'Esa cuenta no tiene cuotas de administración para pagar.',
  inquilino_sin_permiso: 'Tu propietario no te habilitó para pagar la administración. Pídele que lo active en GoPase.',
};
