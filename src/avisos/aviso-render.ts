import sharp from 'sharp';

/**
 * Avisos del conjunto con su marca (diseño "GoPase · Avisos con la marca del
 * conjunto"): plantillas que el administrador llena con unos pocos campos y que
 * se dibujan como imagen (SVG -> PNG con sharp, igual que el recibo de WhatsApp).
 *
 * Formatos: cuadrado 1080x1080 (grupo y redes) y vertical 1080x1920 (estados).
 * Diseños: A (tarjeta blanca con franja de color) y B (todo a color).
 */

export type AvisoFormato = 'cuadrado' | 'vertical';
export type AvisoDiseno = 'A' | 'B';

export interface CampoPlantilla {
  key: string;
  label: string;
  placeholder: string;
  requerido?: boolean;
  multilinea?: boolean;
  /** Etiqueta con la que sale en el aviso (si es un dato de la tabla). */
  enAviso?: string;
  max: number;
}

export interface Plantilla {
  id: string;
  nombre: string;
  kicker: string;
  color: string;
  icono: string;
  tituloSugerido: string;
  campos: CampoPlantilla[];
}

const titulo = (sugerido: string): CampoPlantilla => ({ key: 'titulo', label: 'Título', placeholder: sugerido, requerido: true, max: 70 });
const mensaje = (ph: string): CampoPlantilla => ({ key: 'mensaje', label: 'Mensaje', placeholder: ph, multilinea: true, max: 260 });
const dato = (key: string, label: string, ph: string, requerido = false): CampoPlantilla => ({ key, label, placeholder: ph, enAviso: label, requerido, max: 40 });

export const PLANTILLAS: Plantilla[] = [
  {
    id: 'corte', nombre: 'Corte de servicio', kicker: 'AVISO IMPORTANTE', color: '#0369A1', icono: 'gota', tituloSugerido: 'Corte de agua',
    campos: [titulo('Corte de agua'), dato('fecha', 'Fecha', 'Martes 25 de noviembre', true), dato('horario', 'Horario', '8:00 a. m. – 12:00 m.'), dato('afecta', 'Afecta', 'Torres 1, 2 y 3'),
      mensaje('Por mantenimiento del tanque. Te recomendamos guardar agua con anticipación.')],
  },
  {
    id: 'asamblea', nombre: 'Asamblea', kicker: 'CONVOCATORIA', color: '#6D28D9', icono: 'gente', tituloSugerido: 'Asamblea general ordinaria',
    campos: [titulo('Asamblea general ordinaria'), dato('fecha', 'Fecha', 'Sábado 6 de diciembre', true), dato('hora', 'Hora', '9:00 a. m.'), dato('lugar', 'Lugar', 'Salón social'),
      mensaje('Tu asistencia es importante. Si no puedes asistir, envía tu poder firmado a la administración.')],
  },
  {
    id: 'mantenimiento', nombre: 'Mantenimiento', kicker: 'MANTENIMIENTO', color: '#C2410C', icono: 'llave', tituloSugerido: 'Ascensor fuera de servicio',
    campos: [titulo('Ascensor torre 2 fuera de servicio'), dato('fecha', 'Fecha', 'Jueves 27 de noviembre', true), dato('horario', 'Horario', '9:00 a. m. – 3:00 p. m.'), dato('lugar', 'Lugar', 'Torre 2'),
      mensaje('Mantenimiento preventivo programado. Gracias por tu paciencia.')],
  },
  {
    id: 'pago', nombre: 'Recordatorio de pago', kicker: 'RECORDATORIO', color: '#0F766E', icono: 'calendario', tituloSugerido: 'Paga tu administración',
    campos: [titulo('Paga tu administración antes del día 10'), dato('fechaLimite', 'Fecha límite', 'Día 10 de cada mes'), dato('como', 'Cómo pagar', 'Desde la app GoPase'),
      mensaje('Evita intereses de mora. Si ya pagaste, no tienes que hacer nada.')],
  },
  {
    id: 'evento', nombre: 'Evento', kicker: 'EVENTO', color: '#BE185D', icono: 'estrella', tituloSugerido: 'Novena de aguinaldos',
    campos: [titulo('Novena de aguinaldos'), dato('fecha', 'Fecha', '16 al 24 de diciembre', true), dato('hora', 'Hora', '7:00 p. m.'), dato('lugar', 'Lugar', 'Parque infantil'),
      mensaje('Trae a tu familia. ¡Te esperamos!')],
  },
  {
    id: 'general', nombre: 'Aviso general', kicker: 'AVISO', color: '#1E3A8A', icono: 'megafono', tituloSugerido: 'Nuevo horario de la piscina',
    campos: [titulo('Nuevo horario de la piscina'), dato('dato1', 'Cuándo', 'Martes a domingo'), dato('dato2', 'Detalle', '8:00 a. m. – 8:00 p. m.'),
      mensaje('Escribe aquí el aviso para los residentes.')],
  },
];

export const plantillaPorId = (id: string): Plantilla | undefined => PLANTILLAS.find((p) => p.id === id);

/** Trazos de los íconos (rejilla 24x24, estilo línea). */
const ICONOS: Record<string, string> = {
  gota: '<path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z"/><path d="M4 4l16 16"/>',
  gente: '<circle cx="9" cy="8" r="3.2"/><path d="M3 20c.8-3.6 3.2-5.5 6-5.5s5.2 1.9 6 5.5"/><circle cx="17" cy="9" r="2.6"/><path d="M16 14.5c2.6.2 4.4 2 5 5"/>',
  llave: '<path d="M14.5 4.5a4 4 0 0 0-5 5L4 15v5h5l5.5-5.5a4 4 0 0 0 5-5l-3 3-2.5-.5-.5-2.5z"/>',
  calendario: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/><path d="M9 15l2 2 4-4"/>',
  estrella: '<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/>',
  megafono: '<path d="M4 10v4h3l7 4V6L7 10z"/><path d="M17 9a4 4 0 0 1 0 6"/><path d="M7 14l1.5 5h2.5l-1.2-4.6"/>',
};

/** Marca del conjunto (mirror/marcas). Los logos van como data URL PNG. */
export interface MarcaConjunto {
  conjunto: string;
  logoConjunto?: string;
  mostrarAdmin?: boolean;
  adminNombre?: string;
  logoAdmin?: string;
  colorPrincipal?: string;
  colorAcento?: string;
}

export interface AvisoDatos {
  plantilla: string;
  campos: Record<string, string>;
  formato?: AvisoFormato;
  diseno?: AvisoDiseno;
  /** Color del aviso (hex). Vacío = el de la plantilla. */
  color?: string;
}

const FONT = "'DejaVu Sans', 'Liberation Sans', Arial, sans-serif";

export function esc(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export const colorValido = (c: unknown): string | null => {
  const s = String(c ?? '').trim();
  return /^#[0-9a-fA-F]{6}$/.test(s) ? s.toUpperCase() : null;
};

/** Solo PNG/JPEG en data URL (lo que guarda la marca); cualquier otra cosa se ignora. */
const logoValido = (s: unknown): string | null => {
  const v = String(s ?? '');
  return /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(v) ? v : null;
};

/** Ancho aproximado de un texto en DejaVu Sans (0.6 em; 0.66 en negrita). */
export function anchoTexto(t: string, size: number, bold = false): number {
  return String(t ?? '').length * size * (bold ? 0.66 : 0.6);
}

/** Corta un texto en líneas que quepan en `maxPx`; la última lleva «…» si sobra. */
export function partirLineas(texto: string, maxPx: number, size: number, bold: boolean, maxLineas: number): string[] {
  const palabras = String(texto ?? '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const maxChars = Math.max(4, Math.floor(maxPx / (size * (bold ? 0.66 : 0.57))));
  const lineas: string[] = [];
  let actual = '';
  for (let i = 0; i < palabras.length; i++) {
    let p = palabras[i];
    while (p.length > maxChars) {
      // Palabra más larga que la línea: se corta a la fuerza.
      if (actual) { lineas.push(actual); actual = ''; }
      lineas.push(p.slice(0, maxChars));
      p = p.slice(maxChars);
    }
    const prueba = actual ? `${actual} ${p}` : p;
    if (prueba.length <= maxChars) actual = prueba;
    else { lineas.push(actual); actual = p; }
  }
  if (actual) lineas.push(actual);
  if (lineas.length > maxLineas) {
    const cortadas = lineas.slice(0, maxLineas);
    let ultima = cortadas[maxLineas - 1];
    while (ultima.length > maxChars - 1) ultima = ultima.slice(0, -1);
    cortadas[maxLineas - 1] = ultima.replace(/[\s,.;:]+$/, '') + '…';
    return cortadas;
  }
  return lineas;
}

const recortar = (t: string, maxPx: number, size: number, bold = false) => partirLineas(t, maxPx, size, bold, 1)[0] || '';

const iniciales = (nombre: string) =>
  String(nombre || '')
    .replace(/^(conjunto|edificio|condominio|urbanizaci[oó]n|residencial)\s+/i, '')
    .split(/\s+/)
    .filter((w) => /^[A-Za-zÁÉÍÓÚÑáéíóúñ0-9]/.test(w))
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('') || 'C';

/** Logo dentro de un cuadro redondeado (o iniciales si no hay logo). */
function logoSvg(x: number, y: number, size: number, logo: string | null, nombre: string, fondo: string, colorIniciales: string): string {
  const r = Math.round(size * 0.22);
  const clip = `clip${Math.round(x)}_${Math.round(y)}_${size}`;
  if (logo) {
    const pad = Math.round(size * 0.08);
    return (
      `<defs><clipPath id="${clip}"><rect x="${x}" y="${y}" width="${size}" height="${size}" rx="${r}"/></clipPath></defs>` +
      `<rect x="${x}" y="${y}" width="${size}" height="${size}" rx="${r}" fill="${fondo}"/>` +
      `<image x="${x + pad}" y="${y + pad}" width="${size - 2 * pad}" height="${size - 2 * pad}" xlink:href="${logo}" preserveAspectRatio="xMidYMid meet" clip-path="url(#${clip})"/>`
    );
  }
  const ini = iniciales(nombre);
  return (
    `<rect x="${x}" y="${y}" width="${size}" height="${size}" rx="${r}" fill="${fondo}"/>` +
    `<text x="${x + size / 2}" y="${y + size / 2 + size * 0.14}" text-anchor="middle" font-family="${FONT}" font-size="${Math.round(size * (ini.length > 1 ? 0.38 : 0.46))}" font-weight="700" fill="${colorIniciales}">${esc(ini)}</text>`
  );
}

/** Filas de datos que salen en el aviso (los campos con `enAviso` que tienen valor). */
export function filasAviso(p: Plantilla, campos: Record<string, string>): Array<[string, string]> {
  return p.campos
    .filter((c) => c.enAviso && String(campos?.[c.key] ?? '').trim())
    .map((c) => [c.enAviso as string, String(campos[c.key]).trim().slice(0, c.max)]);
}

/**
 * Dibuja el aviso como SVG. Todo el texto del administrador se escapa y se
 * recorta para que no se salga del diseño.
 */
export function buildAvisoSvg(datos: AvisoDatos, marca: MarcaConjunto): string {
  const p = plantillaPorId(datos.plantilla) || PLANTILLAS[PLANTILLAS.length - 1];
  const formato: AvisoFormato = datos.formato === 'vertical' ? 'vertical' : 'cuadrado';
  const diseno: AvisoDiseno = datos.diseno === 'B' ? 'B' : 'A';
  const W = 1080;
  const H = formato === 'vertical' ? 1920 : 1080;
  const V = formato === 'vertical';
  const c = colorValido(datos.color) || p.color;
  const campos = datos.campos || {};
  const tituloTxt = String(campos.titulo || p.tituloSugerido).slice(0, 70);
  const mensajeTxt = String(campos.mensaje || '').slice(0, 260);
  const filas = filasAviso(p, campos);
  const nombreConjunto = String(marca.conjunto || 'Conjunto').trim();
  const logoC = logoValido(marca.logoConjunto);
  const logoA = logoValido(marca.logoAdmin);
  const adminNombre = String(marca.adminNombre || '').trim().slice(0, 60);
  const conAdmin = marca.mostrarAdmin === true && (!!adminNombre || !!logoA);

  const B = diseno === 'B';
  const fondo = B ? c : '#FFFFFF';
  const texto = B ? '#FFFFFF' : '#0B1530';
  const suave = B ? 'rgba(255,255,255,0.82)' : '#475569';
  const linea = B ? 'rgba(255,255,255,0.28)' : '#E2E8F0';
  const L = V ? 90 : 64;
  const R = W - L;
  const ancho = R - L;
  const out: string[] = [];

  out.push(`<rect width="${W}" height="${H}" fill="${fondo}"/>`);

  // Encabezado: logo + nombre del conjunto + tipo de aviso.
  let y: number;
  if (!B) {
    const bandaH = V ? 190 : 150;
    out.push(`<rect width="${W}" height="${bandaH}" fill="${c}"/>`);
    const ls = V ? 104 : 86;
    const ly = (bandaH - ls) / 2;
    out.push(logoSvg(L, ly, ls, logoC, nombreConjunto, '#FFFFFF', c));
    const chipTxt = p.kicker;
    const chipW = Math.round(anchoTexto(chipTxt, 24, true) + 44);
    out.push(`<rect x="${R - chipW}" y="${bandaH / 2 - 26}" width="${chipW}" height="52" rx="26" fill="rgba(255,255,255,0.2)"/>`);
    out.push(`<text x="${R - chipW / 2}" y="${bandaH / 2 + 9}" text-anchor="middle" font-family="${FONT}" font-size="24" font-weight="700" letter-spacing="1" fill="#FFFFFF">${esc(chipTxt)}</text>`);
    const nx = L + ls + 22;
    out.push(`<text x="${nx}" y="${bandaH / 2 + 13}" font-family="${FONT}" font-size="${V ? 40 : 36}" font-weight="700" fill="#FFFFFF">${esc(recortar(nombreConjunto, R - chipW - 30 - nx, V ? 40 : 36, true))}</text>`);
    y = bandaH + (V ? 90 : 56);
  } else {
    const ls = V ? 110 : 90;
    const top = V ? 110 : 56;
    out.push(logoSvg(L, top, ls, logoC, nombreConjunto, '#FFFFFF', c));
    out.push(`<text x="${L + ls + 24}" y="${top + ls / 2 + 14}" font-family="${FONT}" font-size="${V ? 42 : 38}" font-weight="700" fill="#FFFFFF">${esc(recortar(nombreConjunto, R - L - ls - 24, V ? 42 : 38, true))}</text>`);
    y = top + ls + (V ? 70 : 40);
    const chipW = Math.round(anchoTexto(p.kicker, 26, true) + 48);
    out.push(`<rect x="${L}" y="${y}" width="${chipW}" height="58" rx="29" fill="#FFFFFF"/>`);
    out.push(`<text x="${L + chipW / 2}" y="${y + 39}" text-anchor="middle" font-family="${FONT}" font-size="26" font-weight="700" letter-spacing="1" fill="${c}">${esc(p.kicker)}</text>`);
    y += 58 + (V ? 60 : 36);
  }

  // Ícono + título.
  const icoBox = V ? 150 : 118;
  const icoStroke = B ? '#FFFFFF' : c;
  if (!B) out.push(`<rect x="${L}" y="${y}" width="${icoBox}" height="${icoBox}" rx="${Math.round(icoBox * 0.26)}" fill="${c}" fill-opacity="0.12"/>`);
  else out.push(`<rect x="${L}" y="${y}" width="${icoBox}" height="${icoBox}" rx="${Math.round(icoBox * 0.26)}" fill="#FFFFFF" fill-opacity="0.16"/>`);
  const icoS = icoBox * 0.58;
  out.push(`<g transform="translate(${L + (icoBox - icoS) / 2} ${y + (icoBox - icoS) / 2}) scale(${(icoS / 24).toFixed(3)})" fill="none" stroke="${icoStroke}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONOS[p.icono] || ICONOS.megafono}</g>`);
  const tx = L + icoBox + (V ? 34 : 28);
  let tSize = V ? 92 : 72;
  let tLineas = partirLineas(tituloTxt, R - tx, tSize, true, 3);
  if (tLineas.length === 3) {
    tSize = V ? 80 : 62;
    tLineas = partirLineas(tituloTxt, R - tx, tSize, true, 3);
  }
  const tLH = Math.round(tSize * 1.08);
  const tBloque = tLineas.length * tLH;
  const tTop = y + Math.max(0, (icoBox - tBloque) / 2);
  tLineas.forEach((ln, i) => {
    out.push(`<text x="${tx}" y="${Math.round(tTop + tSize * 0.86 + i * tLH)}" font-family="${FONT}" font-size="${tSize}" font-weight="700" fill="${texto}">${esc(ln)}</text>`);
  });
  y = Math.max(y + icoBox, tTop + tBloque) + (V ? 60 : 34);

  // Datos clave.
  const fSize = V ? 38 : 30;
  const rowH = V ? 104 : 78;
  for (const [lab, val] of filas) {
    out.push(`<line x1="${L}" y1="${y}" x2="${R}" y2="${y}" stroke="${linea}" stroke-width="2"/>`);
    out.push(`<text x="${L}" y="${y + rowH / 2 + fSize * 0.36}" font-family="${FONT}" font-size="${fSize - 2}" fill="${suave}">${esc(lab)}</text>`);
    const labW = anchoTexto(lab, fSize - 2) + 40;
    out.push(`<text x="${R}" y="${y + rowH / 2 + fSize * 0.36}" text-anchor="end" font-family="${FONT}" font-size="${fSize}" font-weight="700" fill="${texto}">${esc(recortar(val, ancho - labW, fSize, true))}</text>`);
    y += rowH;
  }
  if (filas.length) {
    out.push(`<line x1="${L}" y1="${y}" x2="${R}" y2="${y}" stroke="${linea}" stroke-width="2"/>`);
    y += V ? 56 : 36;
  }

  // Pie: administradora (si se muestra) y "Publicado con GoPase".
  const pieH = V ? 150 : 118;
  const pieTop = H - pieH - (V ? 30 : 0);

  // Mensaje: las líneas que quepan antes del pie.
  if (mensajeTxt) {
    const mSize = V ? 46 : 33;
    const mLH = Math.round(mSize * 1.42);
    const maxL = Math.max(1, Math.floor((pieTop - 20 - y) / mLH));
    partirLineas(mensajeTxt, ancho, mSize, false, maxL).forEach((ln, i) => {
      out.push(`<text x="${L}" y="${Math.round(y + mSize + i * mLH)}" font-family="${FONT}" font-size="${mSize}" fill="${B ? 'rgba(255,255,255,0.92)' : '#334155'}">${esc(ln)}</text>`);
    });
  }

  out.push(`<line x1="${L}" y1="${pieTop}" x2="${R}" y2="${pieTop}" stroke="${linea}" stroke-width="2"/>`);
  const pieMid = pieTop + pieH / 2;
  const gp = 'Publicado con GoPase';
  out.push(`<text x="${R}" y="${pieMid + 8}" text-anchor="end" font-family="${FONT}" font-size="${V ? 24 : 20}" fill="${suave}">${esc(gp)}</text>`);
  if (conAdmin) {
    const as = V ? 74 : 60;
    let ax = L;
    if (logoA) {
      out.push(logoSvg(L, pieMid - as / 2, as, logoA, adminNombre, B ? '#FFFFFF' : '#F1F5F9', c));
      ax = L + as + 18;
    }
    const maxNom = R - anchoTexto(gp, V ? 24 : 20) - 40 - ax;
    out.push(`<text x="${ax}" y="${pieMid - 6}" font-family="${FONT}" font-size="${V ? 24 : 20}" fill="${suave}">Administrado por</text>`);
    if (adminNombre) out.push(`<text x="${ax}" y="${pieMid + (V ? 30 : 26)}" font-family="${FONT}" font-size="${V ? 30 : 26}" font-weight="700" fill="${texto}">${esc(recortar(adminNombre, maxNom, V ? 30 : 26, true))}</text>`);
  } else {
    out.push(`<text x="${L}" y="${pieMid + 10}" font-family="${FONT}" font-size="${V ? 30 : 26}" font-weight="700" fill="${texto}">${esc(recortar(nombreConjunto, R - anchoTexto(gp, 20) - 40 - L, V ? 30 : 26, true))}</text>`);
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${out.join('')}</svg>`;
}

export async function renderAvisoPng(datos: AvisoDatos, marca: MarcaConjunto): Promise<Buffer> {
  return sharp(Buffer.from(buildAvisoSvg(datos, marca))).png({ compressionLevel: 9 }).toBuffer();
}

/** Logo subido por el admin -> PNG cuadrado de 320 px con fondo transparente (data URL). */
export async function normalizarLogo(base64: string): Promise<string> {
  const limpio = String(base64 || '').includes(',') ? String(base64).split(',').pop()! : String(base64 || '');
  const buf = Buffer.from(limpio, 'base64');
  if (!buf.length) throw new Error('Imagen vacía.');
  if (buf.length > 6 * 1024 * 1024) throw new Error('La imagen pesa más de 6 MB.');
  const png = await sharp(buf)
    .rotate()
    .resize(320, 320, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 })
    .toBuffer();
  return `data:image/png;base64,${png.toString('base64')}`;
}
