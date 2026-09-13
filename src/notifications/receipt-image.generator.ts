import sharp from 'sharp';

export interface ReceiptData {
  /** Monto en pesos (número o string numérico). Ej: 60000 */
  monto: number | string;
  /** Estado del pago. Ej: "Confirmado". */
  estado?: string;
  /** Fecha de pago legible. Ej: "2026-01-01". */
  fecha?: string;
  /** Concepto / mes. Ej: "Administración Enero 2026". */
  concepto?: string;
  /** Nombre del propietario. */
  propietario?: string;
  /** Nombre del conjunto. */
  conjunto?: string;
  /** Número/consecutivo del recibo. Ej: "REC-20260101-WILME". */
  numeroRecibo?: string;
  /** Fecha de generación del documento (YYYY-MM-DD). Si no viene, se usa hoy. */
  fechaGeneracion?: string;
  // Campos aceptados por compatibilidad (no se muestran en este diseño):
  tipo?: string;
  referencia?: string;
  titulo?: string;
}

/** Escapa texto para insertarlo de forma segura dentro de un SVG. */
function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Formatea un monto a "$60,000 COP" (separador de miles con coma). */
function formatMonto(monto: number | string): string {
  const n = Number(String(monto).replace(/[^\d.-]/g, '')) || 0;
  return '$' + n.toLocaleString('en-US') + ' COP';
}

/** Trunca un texto largo para que no desborde. */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + '…';
}

/** Fecha de hoy en formato YYYY-MM-DD. */
function hoyISO(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Genera el recibo de pago de goPase como PNG (Buffer), con el diseño
 * "documento" (encabezado con nombre del conjunto, tabla de datos, monto,
 * sello PAGADO y pie institucional).
 */
export async function generateReceiptPng(data: ReceiptData): Promise<Buffer> {
  const W = 980;

  const cyan = '#29ABE2';
  const green = '#2FA84F';
  const dark = '#333333';
  const gray = '#666666';
  const lightLine = '#E5E7EB';

  const conjunto = data.conjunto || 'Conjunto';
  const numeroRecibo = data.numeroRecibo || '';
  const estado = data.estado || 'Confirmado';
  const montoTxt = formatMonto(data.monto);
  const fechaGen = data.fechaGeneracion || hoyISO();

  // Filas de la tabla (etiqueta / valor).
  const filas: Array<{ label: string; value: string; valueColor?: string; check?: boolean }> = [
    { label: 'Conjunto', value: truncate(conjunto, 34) },
    { label: 'Propietario', value: truncate(data.propietario || '-', 34) },
    { label: 'Concepto', value: truncate(data.concepto || '-', 34) },
    { label: 'Fecha de pago', value: truncate(data.fecha || '-', 24) },
    { label: 'Estado', value: estado, valueColor: green, check: true },
  ];

  // Layout.
  const padX = 40;
  const topRecibo = 40;      // "Recibo REC-..."
  const titleY = 108;        // nombre conjunto (grande)
  const subTitleY = 148;     // número recibo (gris)
  const barY = 186;          // barra cian
  const tableTop = 240;
  const rowH = 66;
  const tableH = filas.length * rowH;
  const montoY = tableTop + tableH + 90;
  const pagadoY = montoY + 78;
  const footLineY = pagadoY + 60;
  const footY1 = footLineY + 44;
  const footY2 = footY1 + 30;
  const H = footY2 + 40;

  // Fuente instalada en la imagen Docker (Alpine): DejaVu Sans / Liberation Sans.
  // Usar familias disponibles evita que el texto salga como cuadritos (tofu).
  const FONT = "'DejaVu Sans', 'Liberation Sans', sans-serif";

  const filasSvg = filas
    .map((f, i) => {
      const rowY = tableTop + i * rowH;
      const textY = rowY + 34;
      const valuePrefix = f.check ? '✓ ' : '';
      const sep = `<line x1="${padX}" y1="${rowY + rowH}" x2="${W - padX}" y2="${rowY + rowH}" stroke="${lightLine}" stroke-width="1"/>`;
      return `
        <text x="${padX}" y="${textY}" font-family="${FONT}" font-size="24" fill="${gray}">${esc(f.label)}</text>
        <text x="${W - padX}" y="${textY}" text-anchor="end" font-family="${FONT}" font-size="24" font-weight="700" fill="${f.valueColor || dark}">${esc(valuePrefix + f.value)}</text>
        ${sep}`;
    })
    .join('');

  const svg = `
  <svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${W}" height="${H}" fill="#FFFFFF"/>

    <!-- Recibo (pequeño, centrado) -->
    <text x="${W / 2}" y="${topRecibo}" text-anchor="middle"
          font-family="${FONT}" font-size="18" fill="${dark}">${esc('Recibo ' + numeroRecibo)}</text>

    <!-- Nombre del conjunto (grande, cian) -->
    <text x="${W / 2}" y="${titleY}" text-anchor="middle"
          font-family="${FONT}" font-size="46" font-weight="700" fill="${cyan}">${esc(conjunto)}</text>

    <!-- Número de recibo (gris) -->
    <text x="${W / 2}" y="${subTitleY}" text-anchor="middle"
          font-family="${FONT}" font-size="22" fill="${gray}">${esc(numeroRecibo)}</text>

    <!-- Barra separadora cian -->
    <rect x="${padX}" y="${barY}" width="${W - padX * 2}" height="4" fill="${cyan}"/>

    <!-- Tabla de datos -->
    ${filasSvg}

    <!-- Monto grande (verde, centrado) -->
    <text x="${W / 2}" y="${montoY}" text-anchor="middle"
          font-family="${FONT}" font-size="52" font-weight="700" fill="${green}">${esc(montoTxt)}</text>

    <!-- Sello PAGADO -->
    <text x="${W / 2}" y="${pagadoY}" text-anchor="middle"
          font-family="${FONT}" font-size="30" font-weight="700" letter-spacing="4" fill="${green}">${esc('— PAGADO —')}</text>

    <!-- Línea de pie -->
    <line x1="${padX}" y1="${footLineY}" x2="${W - padX}" y2="${footLineY}" stroke="${lightLine}" stroke-width="1"/>

    <!-- Pie institucional -->
    <text x="${W / 2}" y="${footY1}" text-anchor="middle"
          font-family="${FONT}" font-size="18" fill="${gray}">${esc('Documento generado el ' + fechaGen)}</text>
    <text x="${W / 2}" y="${footY2}" text-anchor="middle"
          font-family="${FONT}" font-size="18" fill="${gray}">GoPase - Sistema de Gestión Residencial</text>
  </svg>`;

  return sharp(Buffer.from(svg)).png().toBuffer();
}
