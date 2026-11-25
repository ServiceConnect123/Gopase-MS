/**
 * Inducción de pagos por WhatsApp: cuando alguien envía un comprobante (o
 * escribe sobre un pago) SIN #pago, GoPase le escribe al privado explicando
 * el formato. Se activa por conjunto (config/pagos_wsp/{conj}.induccion).
 *
 * Disparadores (sin descargar ni leer imágenes):
 *  - una foto sin #pago;
 *  - un texto sin #pago que habla de un pago ("ya pagué", "comprobante"...).
 *
 * Para no molestar: se espera un momento por si el #pago llega enseguida, y a
 * cada persona se le escribe como máximo una vez por periodo (24 h).
 *
 * Sin dependencias de Nest/Baileys para poder probarlo aislado.
 */

export const MESES_IND = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

const sinTildes = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');

/** ¿El texto (sin #pago) habla de un pago de administración? */
export function pareceAvisoDePago(texto: string): boolean {
  const t = sinTildes(String(texto || '').toLowerCase());
  if (!t.trim() || /#\s?pago\b/.test(t)) return false;
  return /\bpague\b|\bpagamos\b|\bcomprobante\b|\btransferencia\b|\btransferi\b|\bconsigne\b|\bconsignacion\b|\babono\b|\babone\b|\bpago\s+(de\s+)?(la\s+)?(administracion|admin|cuota)\b|\bnequi\b|\bdaviplata\b/.test(t);
}

/** ¿Toca escribirle? (no se le escribió dentro del periodo de espera). */
export function debeInducir(ultimaIso: string | null | undefined, ahora: number, periodoMs: number): boolean {
  if (!ultimaIso) return true;
  const t = Date.parse(String(ultimaIso));
  return !Number.isFinite(t) || ahora - t >= periodoMs;
}

export interface DatosInduccion {
  /** Qué disparó la inducción. */
  tipo: 'imagen' | 'texto';
  /** Celular del remitente (10 dígitos) si se conoce. */
  telefono?: string;
  /** Mes sugerido (el primero pendiente, o el actual). */
  mes?: string;
  /** Valor sugerido (cuota del residente), si se conoce. */
  valor?: number;
  /** Nombre del grupo si el mensaje llegó por el grupo. */
  grupoNombre?: string;
  /** Nombre corto del residente identificado por su celular. */
  nombre?: string;
}

/** Mes actual en Colombia (para la plantilla cuando no hay uno pendiente). */
export function mesActual(ahora = new Date()): string {
  const bogota = new Date(ahora.getTime() - 5 * 3600_000);
  return MESES_IND[bogota.getUTCMonth()];
}

/** Texto del mensaje privado de inducción. */
export function mensajeInduccion(d: DatosInduccion): string {
  const saludo = d.nombre ? `👋 Hola, ${d.nombre}.` : '👋 Hola.';
  const donde = d.grupoNombre ? ` en el grupo «${d.grupoNombre}»` : '';
  const que = d.tipo === 'imagen' ? `Vi que enviaste un comprobante${donde}` : `Vi tu mensaje sobre un pago${donde}`;
  const tel = d.telefono ? d.telefono : 'tu celular registrado';
  const valor = d.valor && d.valor > 0 ? String(Math.round(d.valor)) : 'el valor que pagaste';
  return [
    `${saludo} ${que}, pero no tiene el formato para registrarlo en GoPase.`,
    '',
    'Envía la *foto del comprobante* con este texto en el pie de foto:',
    '',
    '#pago',
    `Tel: ${tel}`,
    `Mes: ${d.mes || mesActual()}`,
    `Valor: ${valor}`,
    '',
    '💡 Si ya enviaste la foto, no la reenvíes: *responde a la foto* escribiendo ese texto.',
    'La administración revisa el pago antes de confirmarlo.',
  ].join('\n');
}
