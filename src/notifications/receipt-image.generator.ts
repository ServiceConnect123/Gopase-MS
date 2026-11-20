import sharp from "sharp";

/** Una línea del detalle del recibo (p. ej. un mes de administración). */
export interface ReceiptItem {
  concepto: string;
  monto: number | string;
}

export interface ReceiptData {
  /** Monto total en pesos (número o string numérico). Ej: 140000 */
  monto: number | string;
  /** Estado del pago. Ej: "Confirmado". */
  estado?: string;
  /** Fecha de pago (YYYY-MM-DD o ISO). */
  fecha?: string;
  /** Concepto (cuando es un solo ítem). Ej: "Administración Noviembre 2026". */
  concepto?: string;
  /** Detalle por ítems (varios meses en un mismo recibo). Si viene, manda sobre `concepto`. */
  items?: ReceiptItem[];
  /** Nombre del propietario. */
  propietario?: string;
  /** Unidad / casa / apartamento. Ej: "Casa 14". */
  unidad?: string;
  /** Nombre del conjunto. */
  conjunto?: string;
  /** Número/consecutivo del recibo. */
  numeroRecibo?: string;
  /** Fondo / tipo de recaudo. Ej: "Administración". */
  tipoRecaudo?: string;
  /** Referencia del pago (las de imagen "IMG:..." se muestran como "Comprobante adjunto"). */
  referencia?: string;
  /** Código de moneda. Por defecto COP. */
  moneda?: string;
  /** Fecha de generación del documento (YYYY-MM-DD). Si no viene, se usa hoy. */
  fechaGeneracion?: string;
  // Aceptados por compatibilidad (no se muestran):
  tipo?: string;
  titulo?: string;
}

/** Escapa texto para insertarlo de forma segura dentro de un SVG. */
function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Monto a pesos colombianos: 140000 -> "$140.000". */
export function formatPesos(monto: number | string): string {
  const n = Math.round(
    Number(String(monto ?? "").replace(/[^\d.-]/g, "")) || 0,
  );
  const s = String(Math.abs(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return (n < 0 ? "-$" : "$") + s;
}

const MESES = [
  "enero",
  "febrero",
  "marzo",
  "abril",
  "mayo",
  "junio",
  "julio",
  "agosto",
  "septiembre",
  "octubre",
  "noviembre",
  "diciembre",
];

/** "2026-11-20" (o ISO) -> "20 de noviembre de 2026". Si no se reconoce, se devuelve tal cual. */
export function formatFechaLarga(raw?: string): string {
  const s = String(raw ?? "").trim();
  const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!m) return s || "-";
  const mes = MESES[Number(m[2]) - 1];
  return mes ? `${Number(m[3])} de ${mes} de ${m[1]}` : s;
}

function hoyISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Fuente instalada en la imagen Docker (Alpine): DejaVu Sans / Liberation Sans.
// Usar familias disponibles evita que el texto salga como cuadritos (tofu).
const FONT = "'DejaVu Sans', 'Liberation Sans', Arial, sans-serif";

/**
 * Recorta un texto para que quepa en `maxPx` a `size` px. DejaVu Sans es ancha:
 * ~0.6 em por carácter en promedio (0.66 en negrita), estimación conservadora.
 */
function fit(text: string, maxPx: number, size: number, bold = false): string {
  const t = String(text ?? "");
  const maxChars = Math.max(
    4,
    Math.floor(maxPx / (size * (bold ? 0.66 : 0.6))),
  );
  return t.length <= maxChars ? t : t.slice(0, maxChars - 1) + "…";
}

/** Paleta: la misma de la app (src/design/tokens.ts + estados de la propuesta visual). */
const C = {
  primary: "#1E3A8A",
  primarySoft: "#C7D2FE",
  bg: "#EEF1F7",
  card: "#FFFFFF",
  text: "#111827",
  muted: "#4B5563",
  subtle: "#6B7280",
  line: "#E5E7EB",
  ok: "#0F766E",
  okSoft: "#E3F2EF",
  okText: "#0B5E57",
  warn: "#D97706",
  warnSoft: "#FEF3C7",
  warnText: "#92400E",
};

/**
 * Genera el recibo de pago de GoPase como PNG (Buffer).
 *
 * Diseño tipo tiquete: encabezado con el conjunto y el número de recibo, monto
 * destacado con el estado, corte punteado, datos del pago y detalle por ítems
 * (un recibo puede agrupar varios meses). Ancho 1080 px (buena nitidez en
 * WhatsApp); el alto se ajusta al contenido.
 */
export async function generateReceiptPng(data: ReceiptData): Promise<Buffer> {
  return sharp(Buffer.from(buildReceiptSvg(data)))
    .png()
    .toBuffer();
}

/** SVG del recibo (separado para poder probarlo sin rasterizar). */
export function buildReceiptSvg(data: ReceiptData): string {
  const W = 1080;
  const M = 40; // margen exterior
  const CX = M; // x de la tarjeta
  const CW = W - M * 2; // ancho de la tarjeta
  const P = 56; // padding interno
  const L = CX + P; // x izquierda del contenido
  const R = CX + CW - P; // x derecha del contenido
  const inner = R - L;

  const confirmado =
    String(data.estado || "Confirmado").toLowerCase() === "confirmado";
  const conjunto = data.conjunto || "Conjunto";
  const moneda = (data.moneda || "COP").toUpperCase();
  const items: ReceiptItem[] =
    Array.isArray(data.items) && data.items.length > 0
      ? data.items
      : [{ concepto: data.concepto || "Pago", monto: data.monto }];
  const total =
    Array.isArray(data.items) && data.items.length > 0
      ? items.reduce(
          (s, it) =>
            s + (Number(String(it.monto).replace(/[^\d.-]/g, "")) || 0),
          0,
        )
      : data.monto;

  const ref = String(data.referencia ?? "").trim();
  const refTxt = !ref
    ? ""
    : ref.startsWith("IMG:")
      ? "Comprobante adjunto"
      : ref;

  const datos: Array<[string, string]> = [
    ["Propietario", data.propietario || "-"],
  ];
  if (data.unidad) datos.push(["Unidad", data.unidad]);
  datos.push(["Fecha de pago", formatFechaLarga(data.fecha)]);
  if (data.tipoRecaudo) datos.push(["Fondo", data.tipoRecaudo]);
  if (refTxt) datos.push(["Referencia", refTxt]);

  const parts: string[] = [];
  let y = M;

  // ---- Encabezado (banda azul) ----
  const headH = 176;
  const headTop = y;
  // Nombre del conjunto: se reduce la letra antes de recortar (nombres largos).
  const tituloMax = inner - (data.numeroRecibo ? 290 : 0);
  const tituloSize =
    [44, 38, 32, 28].find((sz) => conjunto.length * sz * 0.62 <= tituloMax) ??
    28;
  parts.push(
    `<path d="M${CX} ${headTop + 28} a28 28 0 0 1 28 -28 h${CW - 56} a28 28 0 0 1 28 28 v${headH - 28} h-${CW} z" fill="${C.primary}"/>`,
    `<text x="${L}" y="${headTop + 72}" font-family="${FONT}" font-size="22" font-weight="700" letter-spacing="3" fill="${C.primarySoft}">RECIBO DE PAGO</text>`,
    `<text x="${L}" y="${headTop + 128}" font-family="${FONT}" font-size="${tituloSize}" font-weight="700" fill="#FFFFFF">${esc(fit(conjunto, tituloMax, tituloSize, true))}</text>`,
  );
  if (data.numeroRecibo) {
    parts.push(
      `<text x="${R}" y="${headTop + 72}" text-anchor="end" font-family="${FONT}" font-size="20" fill="${C.primarySoft}">N.º</text>`,
      `<text x="${R}" y="${headTop + 104}" text-anchor="end" font-family="${FONT}" font-size="24" font-weight="700" fill="#FFFFFF">${esc(fit(data.numeroRecibo, 300, 24, true))}</text>`,
    );
  }
  y = headTop + headH;

  // ---- Monto y estado ----
  const heroTop = y;
  const okC = confirmado ? C.ok : C.warn;
  const okSoft = confirmado ? C.okSoft : C.warnSoft;
  const okText = confirmado ? C.okText : C.warnText;
  const estadoTxt = confirmado
    ? "Pago confirmado"
    : `Pago ${String(data.estado || "").toLowerCase()}`;
  const icon = confirmado
    ? `<path d="M${L + 15} ${heroTop + 74} l9 9 l17 -19" fill="none" stroke="#FFFFFF" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>`
    : `<path d="M${L + 28} ${heroTop + 64} v12 l7 5" fill="none" stroke="#FFFFFF" stroke-width="4.5" stroke-linecap="round"/>`;
  const estadoW = Math.round(estadoTxt.length * 24 * 0.6) + 84;
  parts.push(
    `<rect x="${L - 4}" y="${heroTop + 48}" width="${estadoW}" height="56" rx="28" fill="${okSoft}"/>`,
    `<circle cx="${L + 28}" cy="${heroTop + 76}" r="20" fill="${okC}"/>`,
    icon,
    `<text x="${L + 60}" y="${heroTop + 84}" font-family="${FONT}" font-size="24" font-weight="700" fill="${okText}">${esc(estadoTxt)}</text>`,
    `<text x="${L}" y="${heroTop + 196}" font-family="${FONT}" font-size="84" font-weight="700" letter-spacing="-2" fill="${C.text}">${esc(formatPesos(total))}<tspan font-size="34" font-weight="400" letter-spacing="0" fill="${C.subtle}" dx="14">${esc(moneda)}</tspan></text>`,
  );
  const todosAdmin = items.every((it) =>
    /administraci[oó]n/i.test(it.concepto),
  );
  const resumen =
    items.length > 1
      ? `${items.length} ${todosAdmin ? "meses de administración" : "conceptos"}`
      : fit(items[0].concepto, inner, 26);
  parts.push(
    `<text x="${L}" y="${heroTop + 244}" font-family="${FONT}" font-size="26" fill="${C.muted}">${esc(resumen)}</text>`,
  );
  y = heroTop + 300;

  // ---- Corte tipo tiquete ----
  const cutY = y;
  parts.push(
    `<line x1="${CX + 34}" y1="${cutY}" x2="${CX + CW - 34}" y2="${cutY}" stroke="#CBD2DC" stroke-width="2.5" stroke-dasharray="10 10"/>`,
    `<circle cx="${CX}" cy="${cutY}" r="22" fill="${C.bg}"/>`,
    `<circle cx="${CX + CW}" cy="${cutY}" r="22" fill="${C.bg}"/>`,
  );
  y = cutY + 34;

  // ---- Datos del pago ----
  const rowH = 70;
  const labelW = 240;
  datos.forEach(([label, value], i) => {
    const ry = y + i * rowH;
    parts.push(
      `<text x="${L}" y="${ry + 44}" font-family="${FONT}" font-size="24" fill="${C.subtle}">${esc(label)}</text>`,
      `<text x="${R}" y="${ry + 44}" text-anchor="end" font-family="${FONT}" font-size="26" font-weight="700" fill="${C.text}">${esc(fit(value, inner - labelW, 26, true))}</text>`,
    );
    if (i < datos.length - 1) {
      parts.push(
        `<line x1="${L}" y1="${ry + rowH}" x2="${R}" y2="${ry + rowH}" stroke="${C.line}" stroke-width="1.5"/>`,
      );
    }
  });
  y += datos.length * rowH + 28;

  // ---- Detalle por ítems (solo si hay varios; con uno, el concepto ya va arriba) ----
  if (items.length > 1) {
    const itemH = 58;
    const detTop = y;
    const detH = 72 + items.length * itemH + (items.length > 1 ? 72 : 16);
    parts.push(
      `<rect x="${L - 24}" y="${detTop}" width="${inner + 48}" height="${detH}" rx="20" fill="#F7F8FB"/>`,
      `<text x="${L}" y="${detTop + 50}" font-family="${FONT}" font-size="20" font-weight="700" letter-spacing="2" fill="${C.muted}">DETALLE</text>`,
    );
    items.forEach((it, i) => {
      const iy = detTop + 72 + i * itemH;
      parts.push(
        `<circle cx="${L + 7}" cy="${iy + 28}" r="7" fill="${okC}"/>`,
        `<text x="${L + 30}" y="${iy + 37}" font-family="${FONT}" font-size="25" fill="${C.text}">${esc(fit(it.concepto, inner - 240, 25))}</text>`,
        `<text x="${R}" y="${iy + 37}" text-anchor="end" font-family="${FONT}" font-size="25" fill="${C.text}">${esc(formatPesos(it.monto))}</text>`,
      );
    });
    if (items.length > 1) {
      const ty = detTop + 72 + items.length * itemH;
      parts.push(
        `<line x1="${L}" y1="${ty + 8}" x2="${R}" y2="${ty + 8}" stroke="${C.line}" stroke-width="1.5"/>`,
        `<text x="${L}" y="${ty + 52}" font-family="${FONT}" font-size="26" font-weight="700" fill="${C.text}">Total</text>`,
        `<text x="${R}" y="${ty + 52}" text-anchor="end" font-family="${FONT}" font-size="26" font-weight="700" fill="${C.text}">${esc(formatPesos(total))}</text>`,
      );
    }
    y = detTop + detH + 44;
  } else {
    y += 16;
  }

  // ---- Pie ----
  parts.push(
    `<text x="${W / 2}" y="${y + 8}" text-anchor="middle" font-family="${FONT}" font-size="20" fill="${C.subtle}">${esc("Generado el " + formatFechaLarga(data.fechaGeneracion || hoyISO()))}</text>`,
    `<text x="${W / 2}" y="${y + 42}" text-anchor="middle" font-family="${FONT}" font-size="20" font-weight="700" fill="${C.primary}">GoPase<tspan font-weight="400" fill="${C.subtle}" dx="10">·</tspan><tspan font-weight="400" fill="${C.subtle}" dx="10">Gestión residencial</tspan></text>`,
  );
  const cardBottom = y + 80;
  const H = cardBottom + M;

  // Tarjeta (cuerpo blanco bajo la banda) + fondo; se insertan al principio.
  const fondo = [
    `<rect width="${W}" height="${H}" fill="${C.bg}"/>`,
    `<rect x="${CX}" y="${M}" width="${CW}" height="${cardBottom - M}" rx="28" fill="${C.card}"/>`,
  ];

  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">${fondo.join("")}${parts.join("")}</svg>`;
}
