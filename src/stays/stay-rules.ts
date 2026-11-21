/**
 * Reglas de las ESTADÍAS CORTAS (alquiler por días). Funciones puras, sin
 * Firebase, para probarlas y reutilizarlas.
 *
 * El huésped NO tiene cuenta: recibe por WhatsApp un enlace temporal
 * (/estadia?token=...) con su QR y un código corto para el vigilante. El enlace
 * solo sirve entre la llegada y la salida de una estadía aprobada.
 *
 * Cada conjunto decide (administrador) si las permite y cómo:
 *   estadiasCortas: { permitidas, requiereAprobacion, maxNoches, maxAcompanantes, reglas }
 * Por defecto NO están permitidas: el admin debe habilitarlas.
 *
 * Registro en mirror/estadias/{id}:
 *   id, codigo, conjunto, propietario, propietarioNombre, parcela,
 *   huesped { nombre, documentType, documentNumber, phone, placa },
 *   acompanantes, llegada, salida ('YYYY-MM-DD', inclusivas), nota,
 *   estado ('pendiente'|'aprobada'|'rechazada'|'cancelada'), motivo,
 *   aprobadoPor, aprobadoEn, entrada { en, por }, salidaReal { en, por },
 *   tokenHash (sha-256 del enlace), creadoPor, creadoEn
 */

import { hoyISO, normFecha } from '../tenants/tenant-rules';

export interface ConfigEstadias {
  permitidas: boolean;
  requiereAprobacion: boolean;
  maxNoches: number;
  maxAcompanantes: number;
  reglas: string;
}

export const CONFIG_DEFAULT: ConfigEstadias = {
  permitidas: false,
  requiereAprobacion: true,
  maxNoches: 30,
  maxAcompanantes: 6,
  reglas: '',
};

const entero = (raw: unknown, min: number, max: number, def: number) => {
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};

/** Configuración del conjunto con valores por defecto y límites razonables. */
export function normConfig(raw: any): ConfigEstadias {
  const c = raw && typeof raw === 'object' ? raw : {};
  return {
    permitidas: c.permitidas === true,
    requiereAprobacion: c.requiereAprobacion !== false,
    maxNoches: entero(c.maxNoches, 1, 90, CONFIG_DEFAULT.maxNoches),
    maxAcompanantes: entero(c.maxAcompanantes, 0, 20, CONFIG_DEFAULT.maxAcompanantes),
    reglas: String(c.reglas ?? '').trim().slice(0, 2000),
  };
}

/** Noches entre llegada y salida (salida el mismo día = 0 noches). */
export function noches(llegada: string, salida: string): number {
  const a = normFecha(llegada);
  const b = normFecha(salida);
  if (!a || !b) return 0;
  const [ya, ma, da] = a.split('-').map(Number);
  const [yb, mb, db] = b.split('-').map(Number);
  return Math.round((Date.UTC(yb, mb - 1, db) - Date.UTC(ya, ma - 1, da)) / 86400000);
}

export interface SolicitudEstadia {
  nombre?: unknown;
  documentType?: unknown;
  documentNumber?: unknown;
  phone?: unknown;
  placa?: unknown;
  acompanantes?: unknown;
  llegada?: unknown;
  salida?: unknown;
  nota?: unknown;
}

/** Valida la solicitud del propietario contra la configuración del conjunto. */
export function validarSolicitud(
  input: SolicitudEstadia,
  config: ConfigEstadias,
  hoy: string = hoyISO(),
):
  | { error: string }
  | {
      datos: {
        huesped: { nombre: string; documentType: string; documentNumber: string; phone: string; placa: string };
        acompanantes: number;
        llegada: string;
        salida: string;
        nota: string;
      };
    } {
  if (!config.permitidas) return { error: 'El conjunto no tiene habilitadas las estadías cortas. Habla con la administración.' };
  const nombre = String(input.nombre ?? '').trim();
  if (nombre.length < 3) return { error: 'Escribe el nombre completo del huésped.' };
  const phone = String(input.phone ?? '').trim();
  if (phone.replace(/\D/g, '').length < 7) return { error: 'Escribe el celular del huésped: por ahí le llega su acceso.' };
  const llegada = normFecha(input.llegada);
  const salida = normFecha(input.salida);
  if (!llegada || !salida) return { error: 'Indica las fechas de llegada y salida.' };
  if (llegada < hoy) return { error: 'La llegada no puede ser en el pasado.' };
  if (salida < llegada) return { error: 'La salida no puede ser antes de la llegada.' };
  const n = noches(llegada, salida);
  if (n > config.maxNoches) {
    return { error: `El conjunto permite estadías de máximo ${config.maxNoches} noches.` };
  }
  const acompanantes = Math.max(0, Math.floor(Number(input.acompanantes) || 0));
  if (acompanantes > config.maxAcompanantes) {
    return { error: `El conjunto permite máximo ${config.maxAcompanantes} acompañantes por estadía.` };
  }
  return {
    datos: {
      huesped: {
        nombre,
        documentType: String(input.documentType ?? 'CC').trim() || 'CC',
        documentNumber: String(input.documentNumber ?? '').replace(/\D/g, ''),
        phone,
        placa: String(input.placa ?? '').trim().toUpperCase().slice(0, 8),
      },
      acompanantes,
      llegada,
      salida,
      nota: String(input.nota ?? '').trim().slice(0, 500),
    },
  };
}

export type EstadoEstadia =
  | 'pendiente'
  | 'rechazada'
  | 'cancelada'
  | 'programada'
  | 'por_llegar'
  | 'en_curso'
  | 'finalizada';

/** Estado efectivo HOY (el guardado solo dice si fue aprobada/rechazada/cancelada). */
export function estadoEstadia(e: any, hoy: string = hoyISO()): EstadoEstadia {
  const base = String(e?.estado || 'pendiente');
  if (base === 'pendiente' || base === 'rechazada' || base === 'cancelada') return base;
  if (e?.salidaReal?.en) return 'finalizada';
  const llegada = normFecha(e?.llegada);
  const salida = normFecha(e?.salida);
  if (salida && hoy > salida) return 'finalizada';
  if (llegada && hoy < llegada) return 'programada';
  return e?.entrada?.en ? 'en_curso' : 'por_llegar';
}

/** ¿El enlace y el QR del huésped sirven hoy? Solo durante la estadía aprobada. */
export function accesoVigente(e: any, hoy: string = hoyISO()): boolean {
  const s = estadoEstadia(e, hoy);
  return s === 'por_llegar' || s === 'en_curso';
}

const fechaTexto = (iso: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : String(iso || '');
};

/** Mensaje para el huésped cuando su enlace no sirve hoy (null si sirve). */
export function mensajeAcceso(e: any, hoy: string = hoyISO()): string | null {
  switch (estadoEstadia(e, hoy)) {
    case 'por_llegar':
    case 'en_curso':
      return null;
    case 'programada':
      return `Tu estadía empieza el ${fechaTexto(e?.llegada)}. Ese día tu QR quedará activo.`;
    case 'pendiente':
      return 'Tu estadía está pendiente de aprobación por la administración del conjunto.';
    case 'rechazada':
      return 'La administración del conjunto no aprobó esta estadía. Habla con el propietario.';
    case 'cancelada':
      return 'Esta estadía fue cancelada. Habla con el propietario.';
    default:
      return `Tu estadía terminó el ${fechaTexto(e?.salida)}. ¡Gracias por tu visita!`;
  }
}

/** Código corto para el vigilante (sin 0/O/1/I para no confundir). */
export function generarCodigo(rand: () => number = Math.random): string {
  const alfabeto = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c = '';
  for (let i = 0; i < 6; i++) c += alfabeto[Math.floor(rand() * alfabeto.length)];
  return c;
}

/** Normaliza lo que digita o escanea el vigilante ("est-ab c12" -> "ABC12"). */
export function normCodigo(raw: unknown): string {
  const s = String(raw ?? '').toUpperCase();
  const m = /ESTADIA=([A-Z0-9]+)/.exec(s);
  return (m ? m[1] : s).replace(/[^A-Z0-9]/g, '').slice(-6);
}

/** Texto del WhatsApp con el enlace para el huésped. */
export function mensajeWhatsappHuesped(e: any, enlace: string): string {
  const primer = String(e?.huesped?.nombre || '').split(/\s+/)[0] || '';
  return (
    `¡Hola ${primer}! 👋\n\n` +
    `${e?.propietarioNombre || 'El propietario'} registró tu estadía en *${e?.conjunto}*` +
    `${e?.parcela ? ` (unidad ${e.parcela})` : ''} del *${fechaTexto(e?.llegada)}* al *${fechaTexto(e?.salida)}*.\n\n` +
    `🔑 Tu acceso: ${enlace}\n` +
    `🔢 Código para portería: *${e?.codigo}*\n\n` +
    `_Al llegar, muéstrale el QR del enlace al vigilante. El enlace solo funciona durante tu estadía._`
  );
}
