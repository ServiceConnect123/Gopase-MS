import { Injectable, Logger } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import { FirebaseService } from '../firebase/firebase.service';
import { PaymentsService, Pago } from './payments.service';

/**
 * Import/export MASIVO de PAGOS de administración vía Excel (.xlsx), con UNA
 * HOJA POR PROPIETARIO y, en cada hoja, todos los pagos de ese propietario del
 * año seleccionado.
 *
 * Es edición administrativa directa sobre mirror/pagos:
 *   - NO pasa por Mercado Pago ni por el OCR (Gemini). El flujo con comprobante
 *     sigue intacto en la pantalla de Pagos.
 *   - Reutiliza PaymentsService.createPayments/updatePayment/deletePayment.
 *
 * Nombre de cada hoja = NOMBRE del propietario (legible), saneado y truncado a
 * 31 caracteres (límite de Excel). En la fila 1 de cada hoja se escribe también
 * el username real (celda E1) para resolver el propietario sin ambigüedad al
 * re-importar, aunque el nombre de hoja se haya truncado o repetido.
 *
 * Columnas por hoja (fila 2 = cabeceras, datos desde la fila 3):
 *   id          (vacío = crear; con valor = actualizar ese pago)
 *   concepto    (p. ej. "Administración Enero 2026")
 *   valor
 *   fecha       (YYYY-MM-DD)
 *   estado      (Confirmado | Pendiente | Rechazado)
 *   referencia
 *   eliminar    ("x"/"si"/"true" = borra ese pago; requiere id)
 */
const HEADERS = ['id', 'concepto', 'valor', 'fecha', 'estado', 'referencia', 'eliminar'];

/** Fila 1 de cada hoja: etiquetas de metadatos (col A/B = nombre, col D/E = username). */
const META_ROW = 1;
const HEADER_ROW = 2;
const DATA_START_ROW = 3;

interface Usuario {
  usuario: string;
  nombre: string;
  rol: string;
  conjunto: string;
}

export interface PaymentsImportRowResult {
  hoja: string;
  fila: number;
  accion: 'crear' | 'actualizar' | 'eliminar' | 'omitir' | 'error';
  detalle: string;
}

export interface PaymentsImportSummary {
  dryRun: boolean;
  totalFilas: number;
  crear: number;
  actualizar: number;
  eliminar: number;
  errores: number;
  resultados: PaymentsImportRowResult[];
}

const MIRROR_USERS = 'mirror/usuarios';

@Injectable()
export class PaymentsImportService {
  private readonly logger = new Logger(PaymentsImportService.name);

  constructor(
    private readonly firebase: FirebaseService,
    private readonly payments: PaymentsService,
  ) {}

  private norm(s: unknown): string {
    return String(s ?? '').trim().toLowerCase();
  }

  /** Sanea un nombre de hoja de Excel: quita caracteres no permitidos y trunca a 31. */
  private sheetName(base: string, used: Set<string>): string {
    let name = String(base || 'hoja')
      .replace(/[:\\/?*\[\]]/g, '_')
      .trim()
      .slice(0, 31);
    if (!name) name = 'hoja';
    // Garantiza unicidad (Excel no permite nombres de hoja repetidos).
    let candidate = name;
    let n = 2;
    while (used.has(candidate.toLowerCase())) {
      const suffix = `_${n++}`;
      candidate = name.slice(0, 31 - suffix.length) + suffix;
    }
    used.add(candidate.toLowerCase());
    return candidate;
  }

  /** Propietarios del conjunto (desde RTDB). Excluye superAdmin y vigilante. */
  private async getPropietarios(conjunto: string, isSuperAdmin: boolean): Promise<Usuario[]> {
    if (!this.firebase.isEnabled()) return [];
    const snap = await this.firebase.db().ref(MIRROR_USERS).get();
    if (!snap.exists()) return [];
    const all = Object.values(snap.val() || {}) as any[];
    return all
      .filter((u) => this.norm(u.rol) !== 'superadmin' && this.norm(u.rol) !== 'vigilante')
      .filter((u) => isSuperAdmin || !conjunto || this.norm(u.conjunto) === this.norm(conjunto))
      .map((u) => ({
        usuario: String(u.usuario ?? ''),
        nombre: String(u.nombre ?? u.usuario ?? ''),
        rol: String(u.rol ?? ''),
        conjunto: String(u.conjunto ?? ''),
      }))
      .filter((u) => !!u.usuario)
      .sort((a, b) => a.nombre.localeCompare(b.nombre));
  }

  /** Pagos del conjunto (TODOS los años), agrupados por username. */
  private async getPagosByUsuario(
    conjunto: string,
    isSuperAdmin: boolean,
  ): Promise<Map<string, Pago[]>> {
    // year<=0 => todos los años.
    const pagos = await this.payments.getPaymentsList(conjunto, 0, isSuperAdmin);
    const map = new Map<string, Pago[]>();
    for (const p of pagos) {
      const key = String((p as any).usuario ?? '');
      const arr = map.get(key) || [];
      arr.push(p);
      map.set(key, arr);
    }
    return map;
  }

  // ---------------------------------------------------------------------------
  // Generar plantilla (una hoja por propietario)
  // ---------------------------------------------------------------------------

  async generateTemplate(opts: {
    conjunto: string;
    isSuperAdmin: boolean;
    mode: 'create' | 'edit';
  }): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'goPase';
    wb.created = new Date();

    const propietarios = await this.getPropietarios(opts.conjunto, opts.isSuperAdmin);
    const pagosByUsuario =
      opts.mode === 'edit'
        ? await this.getPagosByUsuario(opts.conjunto, opts.isSuperAdmin)
        : new Map<string, Pago[]>();

    const usedNames = new Set<string>();

    if (propietarios.length === 0) {
      // Hoja de aviso para que el archivo no quede vacío.
      const ws = wb.addWorksheet('Sin propietarios');
      ws.getCell('A1').value = 'No hay propietarios para el conjunto/año seleccionados.';
    }

    for (const u of propietarios) {
      // Nombre de hoja = NOMBRE del propietario (legible). El username real queda
      // en la celda E1 para resolver sin ambigüedad al re-importar.
      const ws = wb.addWorksheet(this.sheetName(u.nombre || u.usuario, usedNames));

      // Fila 1: metadatos (nombre legible + username real para re-importar).
      ws.getCell(META_ROW, 1).value = 'Propietario:';
      ws.getCell(META_ROW, 2).value = u.nombre;
      ws.getCell(META_ROW, 4).value = 'usuario:';
      ws.getCell(META_ROW, 5).value = u.usuario;
      ws.getRow(META_ROW).font = { bold: true, color: { argb: 'FF1E3A8A' } };

      // Fila 2: cabeceras.
      HEADERS.forEach((h, i) => {
        const cell = ws.getCell(HEADER_ROW, i + 1);
        cell.value = h;
        cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A8A' } };
      });

      // Ancho de columnas.
      ws.getColumn(1).width = 16; // id
      ws.getColumn(2).width = 30; // concepto
      ws.getColumn(3).width = 14; // valor
      ws.getColumn(4).width = 14; // fecha
      ws.getColumn(5).width = 14; // estado
      ws.getColumn(6).width = 20; // referencia
      ws.getColumn(7).width = 10; // eliminar

      // Datos (modo edit): todos los pagos del propietario (todos los años).
      const pagos = (pagosByUsuario.get(u.usuario) || []).sort((a, b) =>
        String(a.concepto || '').localeCompare(String(b.concepto || '')),
      );
      let r = DATA_START_ROW;
      for (const p of pagos) {
        ws.getCell(r, 1).value = p.id ?? '';
        ws.getCell(r, 2).value = p.concepto ?? '';
        ws.getCell(r, 3).value = p.valor ?? '';
        ws.getCell(r, 4).value = (p.fecha ?? '').toString().split('T')[0];
        ws.getCell(r, 5).value = p.estado ?? '';
        ws.getCell(r, 6).value = p.referencia ?? '';
        ws.getCell(r, 7).value = '';
        r++;
      }

      // En modo create (o si no tiene pagos) deja una fila de ejemplo guía.
      if (pagos.length === 0) {
        const anioEjemplo = new Date().getFullYear();
        ws.getCell(DATA_START_ROW, 1).value = '';
        ws.getCell(DATA_START_ROW, 2).value = `Administración Enero ${anioEjemplo}`;
        ws.getCell(DATA_START_ROW, 3).value = '';
        ws.getCell(DATA_START_ROW, 4).value = new Date().toISOString().split('T')[0];
        ws.getCell(DATA_START_ROW, 5).value = 'Confirmado';
        ws.getCell(DATA_START_ROW, 6).value = '';
        ws.getCell(DATA_START_ROW, 7).value = '';
        ws.getRow(DATA_START_ROW).font = { italic: true, color: { argb: 'FF9CA3AF' } };
      }
    }

    const arrayBuffer = await wb.xlsx.writeBuffer();
    return Buffer.from(arrayBuffer);
  }

  // ---------------------------------------------------------------------------
  // Procesar import
  // ---------------------------------------------------------------------------

  private cellStr(ws: ExcelJS.Worksheet, row: number, col: number): string {
    const v = ws.getCell(row, col).value;
    if (v == null) return '';
    if (typeof v === 'object' && 'text' in (v as any)) return String((v as any).text).trim();
    if (typeof v === 'object' && 'result' in (v as any)) return String((v as any).result).trim();
    if (typeof v === 'object' && 'richText' in (v as any)) {
      return (v as any).richText.map((t: any) => t.text).join('').trim();
    }
    return String(v).trim();
  }

  /**
   * Resuelve el username de una hoja. Prioridad:
   *  1) celda meta E1 (username real que escribió la plantilla),
   *  2) nombre de hoja interpretado como NOMBRE del propietario (vía mapa),
   *  3) nombre de hoja tal cual (último recurso).
   */
  private resolveUsuario(ws: ExcelJS.Worksheet, nombreToUsuario: Map<string, string>): string {
    const metaLabel = this.norm(this.cellStr(ws, META_ROW, 4));
    const metaValue = this.cellStr(ws, META_ROW, 5);
    if (metaLabel.includes('usuario') && metaValue) return metaValue;
    // Fallback: el nombre de la hoja es el NOMBRE del propietario (truncado a 31).
    const byNombre = nombreToUsuario.get(this.norm(ws.name));
    if (byNombre) return byNombre;
    return ws.name;
  }

  async processImport(opts: {
    conjunto: string;
    isSuperAdmin: boolean;
    fileBase64: string;
    dryRun: boolean;
  }): Promise<PaymentsImportSummary> {
    const summary: PaymentsImportSummary = {
      dryRun: opts.dryRun,
      totalFilas: 0, crear: 0, actualizar: 0, eliminar: 0, errores: 0, resultados: [],
    };

    const clean = opts.fileBase64.includes(',') ? opts.fileBase64.split(',').pop()! : opts.fileBase64;
    const buffer = Buffer.from(clean, 'base64');

    const wb = new ExcelJS.Workbook();
    try {
      await wb.xlsx.load(buffer as any);
    } catch {
      summary.errores = 1;
      summary.resultados.push({ hoja: '', fila: 0, accion: 'error', detalle: 'El archivo no es un .xlsx válido.' });
      return summary;
    }

    // Mapa de usuarios válidos del conjunto (para validar que la hoja existe).
    const propietarios = await this.getPropietarios(opts.conjunto, opts.isSuperAdmin);
    const validUsernames = new Set(propietarios.map((u) => this.norm(u.usuario)));
    const conjuntoByUsuario = new Map(propietarios.map((u) => [this.norm(u.usuario), u.conjunto]));
    // Nombre (saneado/truncado como el nombre de hoja) -> username, para
    // resolver la hoja cuando la celda meta E1 no está disponible.
    const nombreToUsuario = new Map<string, string>();
    for (const u of propietarios) {
      const sheetLike = this.norm((u.nombre || u.usuario).replace(/[:\\/?*\[\]]/g, '_').slice(0, 31));
      if (sheetLike && !nombreToUsuario.has(sheetLike)) nombreToUsuario.set(sheetLike, u.usuario);
    }

    const currentYear = new Date().getFullYear();
    const ops: Array<() => Promise<void>> = [];

    for (const ws of wb.worksheets) {
      if (this.norm(ws.name) === 'sin propietarios') continue;

      const usuario = this.resolveUsuario(ws, nombreToUsuario);
      const usuarioNorm = this.norm(usuario);

      // Validar que la hoja corresponde a un propietario conocido del conjunto.
      if (!validUsernames.has(usuarioNorm)) {
        summary.errores++;
        summary.resultados.push({
          hoja: ws.name,
          fila: META_ROW,
          accion: 'error',
          detalle: `La hoja "${ws.name}" no corresponde a un propietario del conjunto.`,
        });
        continue;
      }

      const conjuntoDelUsuario = conjuntoByUsuario.get(usuarioNorm) || opts.conjunto;

      // Verifica que la fila de cabeceras tenga el formato esperado.
      const h0 = this.norm(this.cellStr(ws, HEADER_ROW, 1));
      if (h0 !== 'id') {
        summary.errores++;
        summary.resultados.push({
          hoja: ws.name,
          fila: HEADER_ROW,
          accion: 'error',
          detalle: `La hoja "${ws.name}" no tiene el formato esperado (falta la cabecera "id").`,
        });
        continue;
      }

      for (let i = DATA_START_ROW; i <= ws.rowCount; i++) {
        const id = this.cellStr(ws, i, 1);
        const concepto = this.cellStr(ws, i, 2);
        const valor = this.cellStr(ws, i, 3);
        const fecha = this.cellStr(ws, i, 4).split('T')[0];
        const estado = this.cellStr(ws, i, 5) || 'Confirmado';
        const referencia = this.cellStr(ws, i, 6);
        const eliminar = this.norm(this.cellStr(ws, i, 7));

        // Fila vacía: se omite.
        if (!id && !concepto && !valor && !fecha && !referencia && !eliminar) continue;

        summary.totalFilas++;

        // Borrado explícito (requiere id).
        if (['x', 'si', 'sí', 'true', '1'].includes(eliminar)) {
          if (!id) {
            summary.errores++;
            summary.resultados.push({ hoja: ws.name, fila: i, accion: 'error', detalle: 'Para eliminar se requiere el "id" del pago.' });
            continue;
          }
          summary.eliminar++;
          summary.resultados.push({ hoja: ws.name, fila: i, accion: 'eliminar', detalle: `Eliminar pago ${id} (${concepto || 's/concepto'}).` });
          ops.push(async () => { await this.payments.deletePayment(id); });
          continue;
        }

        // Validaciones mínimas para crear/editar.
        if (!concepto) {
          summary.errores++;
          summary.resultados.push({ hoja: ws.name, fila: i, accion: 'error', detalle: 'Falta el "concepto".' });
          continue;
        }
        const valorNum = parseFloat(String(valor).replace(/[^0-9.-]/g, ''));
        if (!valor || isNaN(valorNum)) {
          summary.errores++;
          summary.resultados.push({ hoja: ws.name, fila: i, accion: 'error', detalle: `Valor inválido ("${valor}") en "${concepto}".` });
          continue;
        }

        if (id) {
          // Actualizar pago existente.
          summary.actualizar++;
          summary.resultados.push({ hoja: ws.name, fila: i, accion: 'actualizar', detalle: `Actualizar pago ${id}: ${concepto} = ${valor}.` });
          ops.push(async () => {
            // No se envían campos vacíos para no borrar datos existentes por accidente.
            const changes: Partial<Pago> = { usuario, concepto, valor, estado };
            if (fecha) (changes as any).fecha = fecha;
            if (referencia) (changes as any).referencia = referencia;
            await this.payments.updatePayment(id, changes);
          });
        } else {
          // Crear pago nuevo (concepto libre, un solo pago).
          summary.crear++;
          summary.resultados.push({ hoja: ws.name, fila: i, accion: 'crear', detalle: `Crear pago para ${usuario}: ${concepto} = ${valor}.` });
          ops.push(async () => {
            await this.payments.createPayments({
              usuario,
              montoPerMonth: valor,
              year: currentYear,
              estado,
              referencia,
              conjunto: conjuntoDelUsuario,
              concepto,
            });
          });
        }
      }
    }

    // Aplicar solo si NO es dry-run y no hubo errores de validación.
    if (!opts.dryRun && summary.errores === 0) {
      for (const op of ops) {
        try {
          await op();
        } catch (e: any) {
          summary.errores++;
          summary.resultados.push({ hoja: '', fila: 0, accion: 'error', detalle: e?.message || 'Error aplicando un cambio.' });
        }
      }
    }

    return summary;
  }
}
