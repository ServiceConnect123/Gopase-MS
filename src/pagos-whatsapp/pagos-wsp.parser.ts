/**
 * Interpreta el texto de un mensaje de WhatsApp con un pago.
 *
 * Formato largo (pie de foto del comprobante):
 *   #pago
 *   Usuario: alex97          (o Documento: 1020304050, o Tel: 3001234567)
 *   Mes: noviembre           (o "oct-nov", "octubre y noviembre", "nov 2026")
 *   Valor: 120.000
 *   Fondo: Administración    (opcional)
 *
 * Formato corto:  #pago alex97 nov 120000   ·   #pago 3001234567   ·   #pago
 *
 * Sin etiquetas: el primer número "suelto" es el identificador (teléfono o
 * documento) y el siguiente, el valor; un texto con letras es el usuario.
 */

export const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

export type TipoIdentificador = 'usuario' | 'documento' | 'telefono' | 'numero';

export interface PagoWspParseado {
  /** El mensaje trae #pago. */
  esPago: boolean;
  identificador?: { tipo: TipoIdentificador; valor: string };
  /** Meses pedidos (índice 0..11) con su año si lo escribió. */
  meses: Array<{ mes: string; idx: number; anio?: number }>;
  valor?: number;
  fondo?: string;
}

const sinTildes = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');
const norm = (s: string) => sinTildes(String(s || '')).toLowerCase().trim();

const ABREV: Record<string, number> = {
  ene: 0, enero: 0, feb: 1, febrero: 1, mar: 2, marzo: 2, abr: 3, abril: 3, may: 4, mayo: 4, jun: 5, junio: 5,
  jul: 6, julio: 6, ago: 7, agosto: 7, sep: 8, sept: 8, septiembre: 8, setiembre: 8, oct: 9, octubre: 9,
  nov: 10, noviembre: 10, dic: 11, diciembre: 11,
};

const mesDe = (t: string): number | undefined => ABREV[norm(t).replace(/\.$/, '')];
const esAnio = (t: string) => /^20\d{2}$/.test(t) && Number(t) >= 2020 && Number(t) <= 2099;

/** "120.000", "$120,000", "120000" → 120000. Con decimales ",00" o ".00" los ignora. */
export function parsearValor(t: string): number | undefined {
  let s = String(t || '').replace(/[$\s]/g, '').replace(/cop$/i, '');
  if (/^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(s)) s = s.split(',')[0].replace(/\./g, ''); // 120.000,00
  else if (/^\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(s)) s = s.split('.')[0].replace(/,/g, ''); // 120,000.00
  else s = s.replace(/[.,]\d{1,2}$/, '').replace(/\D/g, ''); // 120000 o 120000,00
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Meses de un texto: "oct-nov", "octubre y noviembre 2026", "nov". */
export function parsearMeses(texto: string): Array<{ mes: string; idx: number; anio?: number }> {
  const toks = norm(texto).replace(/[,;/]/g, ' ').replace(/\s*-\s*/g, ' - ').split(/\s+/).filter(Boolean);
  const out: Array<{ mes: string; idx: number; anio?: number }> = [];
  let anio: number | undefined;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (esAnio(t)) {
      anio = Number(t);
      continue;
    }
    const m = mesDe(t);
    if (m === undefined) continue;
    // Rango "oct - dic" o "oct a dic"
    if ((toks[i + 1] === '-' || toks[i + 1] === 'a' || toks[i + 1] === 'hasta') && mesDe(toks[i + 2] || '') !== undefined) {
      const fin = mesDe(toks[i + 2])!;
      let k = m;
      for (let guard = 0; guard < 12; guard++) {
        out.push({ mes: MESES[k], idx: k });
        if (k === fin) break;
        k = (k + 1) % 12;
      }
      i += 2;
      continue;
    }
    out.push({ mes: MESES[m], idx: m });
  }
  if (anio) for (const o of out) o.anio = anio;
  // Sin repetidos, en el orden escrito.
  const vistos = new Set<number>();
  return out.filter((o) => (vistos.has(o.idx) ? false : (vistos.add(o.idx), true)));
}

const ETIQUETAS: Array<[RegExp, 'usuario' | 'documento' | 'telefono' | 'mes' | 'valor' | 'fondo']> = [
  [/^(usuario|user|usr)$/, 'usuario'],
  [/^(documento|doc|cedula|cc|c\.c|identificacion|nit)$/, 'documento'],
  [/^(tel|telefono|celular|cel|movil|whatsapp|numero)$/, 'telefono'],
  [/^(mes|meses|periodo|periodos)$/, 'mes'],
  [/^(valor|monto|total|pago)$/, 'valor'],
  [/^(fondo|concepto|recaudo|tipo)$/, 'fondo'],
];

export function parsearMensajePago(texto: string): PagoWspParseado {
  const raw = String(texto || '');
  const res: PagoWspParseado = { esPago: /(^|\s)#\s?pago\b/i.test(sinTildes(raw)), meses: [] };
  if (!res.esPago) return res;

  // Datos con etiqueta: en cualquier parte. Sin etiqueta: solo después de #pago
  // (así un saludo antes del #pago no se toma como usuario).
  const marca = raw.match(/#\s?pago\b/i);
  const corte = marca ? (marca.index || 0) + marca[0].length : 0;
  const lineas = [
    ...raw.slice(0, marca ? marca.index : 0).split(/\r?\n/).map((l) => ({ l, libre: false })),
    ...raw.slice(corte).split(/\r?\n/).map((l) => ({ l, libre: true })),
  ];
  const sueltos: string[] = [];
  for (const { l: lineaRaw, libre } of lineas) {
    const linea = lineaRaw.trim();
    if (!linea) continue;
    const m = linea.match(/^([A-Za-zÁÉÍÓÚáéíóúñÑ.]+)\s*[:=]\s*(.+)$/);
    const tipo = m ? ETIQUETAS.find(([re]) => re.test(norm(m[1])))?.[1] : undefined;
    if (m && tipo) {
      const v = m[2].trim();
      if (tipo === 'usuario' || tipo === 'documento' || tipo === 'telefono') {
        // El dato es la primera "palabra" (con espacios/puntos si es número);
        // lo que siga en la línea se lee como formato corto ("Usuario: alex97 nov").
        const num = v.match(/^\+?[\d][\d\s.-]*\d|^\d/);
        const dato = tipo === 'usuario' ? v.split(/\s+/)[0] : num ? num[0] : v.split(/\s+/)[0];
        const resto = v.slice(dato.length).trim();
        if (tipo === 'usuario') res.identificador = { tipo: 'usuario', valor: dato.replace(/^@/, '') };
        else res.identificador = { tipo, valor: dato.replace(/\D/g, '') };
        if (resto) sueltos.push(...resto.split(/\s+/));
        continue;
      }
      else if (tipo === 'mes') res.meses = parsearMeses(v);
      else if (tipo === 'valor') res.valor = parsearValor(v);
      else if (tipo === 'fondo') res.fondo = v;
      continue;
    }
    if (libre) sueltos.push(...linea.split(/\s+/));
  }

  // Formato corto: tokens sin etiqueta.
  const restoMeses: string[] = [];
  for (let i = 0; i < sueltos.length; i++) {
    const t = sueltos[i].replace(/[,;]$/, '');
    if (!t) continue;
    const rango = t.match(/^([a-z\u00c0-\u017f.]+)-([a-z\u00c0-\u017f.]+)$/i);
    if ((rango && mesDe(rango[1]) !== undefined && mesDe(rango[2]) !== undefined) || mesDe(t) !== undefined || t === '-' || /^(a|y|hasta)$/i.test(t) || (esAnio(t) && restoMeses.length)) {
      restoMeses.push(t);
      continue;
    }
    if (/^\$/.test(t) || /^\d{1,3}([.,]\d{3})+([.,]\d{2})?$/.test(t)) {
      res.valor = res.valor ?? parsearValor(t);
      continue;
    }
    if (/^\+?\d[\d\s-]*$/.test(t)) {
      const d = t.replace(/\D/g, '');
      if (!res.identificador && d.length >= 6) res.identificador = { tipo: 'numero', valor: d };
      else if (res.valor === undefined) res.valor = parsearValor(d);
      continue;
    }
    if (/[a-z]/i.test(t) && !res.identificador && /^@?[\w.-]{3,}$/.test(t)) {
      res.identificador = { tipo: 'usuario', valor: t.replace(/^@/, '') };
    }
  }
  if (!res.meses.length && restoMeses.length) res.meses = parsearMeses(restoMeses.join(' '));
  return res;
}

/** Teléfono a 10 dígitos colombianos (quita el 57 inicial). */
export function normTelefono(t: unknown): string {
  let d = String(t ?? '').replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('57')) d = d.slice(2);
  return d.length > 10 ? d.slice(-10) : d;
}

/** Plantillas que el admin comparte con los residentes. */
export function plantillasPago(usuario = 'tu_usuario') {
  return {
    larga: `#pago\nUsuario: ${usuario}\nMes: noviembre\nValor: 120.000`,
    corta: `#pago ${usuario} nov 120000`,
  };
}
