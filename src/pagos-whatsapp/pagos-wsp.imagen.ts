/**
 * De dónde sale la foto del comprobante de un mensaje #pago:
 *  - 'adjunta':  el #pago va en el pie de la foto (caso de siempre).
 *  - 'citada':   el #pago responde (cita) a un mensaje que tiene la foto.
 *  - 'anterior': el #pago llega como texto justo después de una foto del
 *                mismo remitente en el mismo chat (ventana corta).
 *
 * Las fotos sin #pago NO se descargan: de ellas solo se recuerda en memoria
 * (unos minutos, sin persistir) la referencia del mensaje, por si el
 * remitente manda el #pago enseguida. Si no llega, se olvida.
 *
 * Sin dependencias de Nest/Baileys para poder probarlo aislado.
 */

export type OrigenImagen = 'adjunta' | 'citada' | 'anterior';

/** Mensaje de Baileys listo para downloadMediaMessage ({ key, message }). */
export interface MensajeConImagen {
  key: { remoteJid: string; id: string; participant?: string; fromMe?: boolean };
  message: any;
}

/** Quita envolturas (temporales / ver una vez / documento con pie). */
export function desenvolver(m: any): any {
  for (let i = 0; i < 3 && m; i++) {
    const inner =
      m.ephemeralMessage?.message ||
      m.viewOnceMessage?.message ||
      m.viewOnceMessageV2?.message ||
      m.documentWithCaptionMessage?.message;
    if (!inner) break;
    m = inner;
  }
  return m || null;
}

/** Imagen del mensaje (foto o documento de tipo imagen), si la tiene. */
export function imagenDe(m: any): any | null {
  if (!m) return null;
  if (m.imageMessage) return m.imageMessage;
  return String(m.documentMessage?.mimetype || '').startsWith('image/') ? m.documentMessage : null;
}

/** contextInfo del mensaje (en texto, foto o documento). */
function contextoDe(m: any): any | null {
  return m?.extendedTextMessage?.contextInfo || m?.imageMessage?.contextInfo || m?.documentMessage?.contextInfo || null;
}

/**
 * Si el mensaje cita (responde) a otro que tiene una imagen, devuelve ese
 * mensaje citado en forma descargable. WhatsApp incluye en la cita el mensaje
 * original completo (con su clave de medios), así que no hace falta haberlo
 * guardado antes.
 */
export function imagenCitada(m: any, chatJid: string): MensajeConImagen | null {
  const ctx = contextoDe(m);
  const citado = desenvolver(ctx?.quotedMessage);
  if (!citado || !imagenDe(citado) || !ctx?.stanzaId) return null;
  return {
    key: {
      remoteJid: String(ctx.remoteJid || chatJid),
      id: String(ctx.stanzaId),
      participant: ctx.participant ? String(ctx.participant) : undefined,
      fromMe: false,
    },
    message: citado,
  };
}

/** Texto del mensaje (pie de foto, texto simple o texto con formato/cita). */
export function textoDe(m: any): string {
  const img = imagenDe(m);
  return String(img?.caption || m?.conversation || m?.extendedTextMessage?.text || '').trim();
}

/**
 * Fotos recientes (sin #pago) por chat + remitente, en memoria.
 * Guarda solo la referencia al mensaje; nunca la imagen.
 */
export class FotosRecientes {
  private readonly porClave = new Map<string, { msg: MensajeConImagen; ts: number }>();
  private readonly ventanaMs: number;
  private readonly maximo: number;

  constructor(ventanaMs = 5 * 60_000, maximo = 500) {
    this.ventanaMs = ventanaMs;
    this.maximo = maximo;
  }

  private clave(sesion: string, chatJid: string, remitente: string) {
    return `${sesion}|${chatJid}|${remitente}`;
  }

  /** Recuerda la última foto del remitente en ese chat (reemplaza la anterior). */
  recordar(sesion: string, chatJid: string, remitente: string, msg: MensajeConImagen, ahora = Date.now()): void {
    if (!remitente || !chatJid) return;
    this.limpiar(ahora);
    const k = this.clave(sesion, chatJid, remitente);
    this.porClave.delete(k); // reinsertar = queda como la más reciente
    this.porClave.set(k, { msg, ts: ahora });
    while (this.porClave.size > this.maximo) {
      const primera = this.porClave.keys().next().value;
      if (primera === undefined) break;
      this.porClave.delete(primera);
    }
  }

  /** Toma (y olvida) la foto reciente del remitente, si está dentro de la ventana. */
  tomar(sesion: string, chatJid: string, remitente: string, ahora = Date.now()): MensajeConImagen | null {
    const k = this.clave(sesion, chatJid, remitente);
    const v = this.porClave.get(k);
    if (!v) return null;
    this.porClave.delete(k);
    return ahora - v.ts <= this.ventanaMs ? v.msg : null;
  }

  limpiar(ahora = Date.now()): void {
    for (const [k, v] of this.porClave) if (ahora - v.ts > this.ventanaMs) this.porClave.delete(k);
  }

  get tamano(): number {
    return this.porClave.size;
  }
}
