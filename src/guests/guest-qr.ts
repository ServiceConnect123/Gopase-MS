/**
 * QR de acceso de INVITADOS. Funciones puras (sin Firebase) para probarlas.
 *
 * Al registrar un invitado (o después, desde "Compartir QR") se le asigna:
 *   qr: { codigo, creadoEn, anulado, usadoEn }
 * - `codigo`: 6 caracteres sin 0/O/1/I. Va impreso bajo el QR para digitarlo.
 * - La imagen QR lleva `${FRONTEND}/app/guests?codigo=XXXXXX`: el vigilante la
 *   lee con el escáner de la app o con la cámara del celular (abre la app).
 * - El enlace que recibe el invitado por WhatsApp es /invitado?c=CODIGO&s=FIRMA.
 *   La firma (HMAC con el secreto del servidor) evita que alguien vea datos de
 *   invitados probando códigos; se puede reconstruir, así que no se guarda.
 *
 * El QR vale SOLO el día de la visita (hora Colombia) y UNA vez: al registrar
 * la entrada queda usado. El residente puede anularlo.
 */

import { createHmac, timingSafeEqual } from 'crypto';
import { hoyISO, normFecha } from '../tenants/tenant-rules';

export { generarCodigo } from '../stays/stay-rules';

/** Código desde lo que digita o escanea el vigilante ("…?codigo=ab3cd9" -> "AB3CD9"). */
export function normCodigoInvitado(raw: unknown): string {
  const s = String(raw ?? '').toUpperCase();
  const m = /CODIGO=([A-Z0-9]+)/.exec(s) || /[?&]C=([A-Z0-9]+)/.exec(s);
  return (m ? m[1] : s).replace(/[^A-Z0-9]/g, '').slice(-6);
}

/** Firma corta del enlace público del invitado. */
export function firmaEnlace(secreto: string, id: string, codigo: string): string {
  return createHmac('sha256', secreto).update(`invitado:${id}:${codigo}`).digest('base64url').slice(0, 22);
}

export function firmaValida(secreto: string, id: string, codigo: string, firma: unknown): boolean {
  const esperada = Buffer.from(firmaEnlace(secreto, id, codigo));
  const dada = Buffer.from(String(firma ?? ''));
  return esperada.length === dada.length && timingSafeEqual(esperada, dada);
}

export type MotivoQr = 'valido' | 'sin_qr' | 'anulado' | 'usado' | 'vencido' | 'futuro';

const fechaTexto = (iso: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12));
  const dia = new Intl.DateTimeFormat('es-CO', { weekday: 'long', timeZone: 'UTC' }).format(d);
  const mes = new Intl.DateTimeFormat('es-CO', { month: 'short', timeZone: 'UTC' }).format(d).replace('.', '');
  return `${dia} ${Number(m[3])} ${mes}`;
};

/**
 * ¿El QR del invitado sirve hoy? Devuelve el motivo y el mensaje para portería.
 * Orden: anulado > ya usado > fecha (otro día) > válido.
 */
export function validezQr(inv: any, hoy: string = hoyISO()): { valido: boolean; motivo: MotivoQr; mensaje: string } {
  if (!inv?.qr?.codigo) return { valido: false, motivo: 'sin_qr', mensaje: 'Este invitado no tiene QR.' };
  if (inv.qr.anulado === true) return { valido: false, motivo: 'anulado', mensaje: 'El residente anuló este QR.' };
  if (inv.qr.usadoEn || String(inv.estado || '') === 'Ingresó') {
    return {
      valido: false,
      motivo: 'usado',
      mensaje: inv.horaIngreso
        ? `Ya se usó: ingresó a las ${inv.horaIngreso}${String(inv.horaIngreso).endsWith('.') ? '' : '.'}`
        : 'Este QR ya se usó.',
    };
  }
  const fecha = normFecha(inv.fecha);
  if (fecha && fecha < hoy) return { valido: false, motivo: 'vencido', mensaje: `Este QR era para el ${fechaTexto(fecha)}.` };
  if (fecha && fecha > hoy) return { valido: false, motivo: 'futuro', mensaje: `Este QR es para el ${fechaTexto(fecha)}.` };
  return { valido: true, motivo: 'valido', mensaje: 'Invitado autorizado.' };
}

/** Texto del WhatsApp que el residente le envía a su invitado. */
export function mensajeCompartir(inv: any, enlace: string, anfitrion: string): string {
  const primer = String(inv?.nombre || '').split(/\s+/)[0] || '';
  const fecha = normFecha(inv?.fecha);
  const cuando = fecha === hoyISO() ? 'hoy' : `el ${fechaTexto(fecha)}`;
  return (
    `¡Hola ${primer}! 👋 ${anfitrion} te invitó a *${inv?.conjunto || 'su conjunto'}*` +
    `${inv?.parcela ? ` (${inv.parcela})` : ''} ${cuando}.\n\n` +
    `🔑 Tu acceso: ${enlace}\n` +
    `🔢 Código: *${inv?.qr?.codigo}*\n\n` +
    `_Muéstrale el QR al vigilante al llegar. Sirve solo ese día y una sola vez._`
  );
}
