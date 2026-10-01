import { Injectable, Logger } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import { FirebaseService } from '../firebase/firebase.service';
import { ReportsService } from './reports.service';

/**
 * Import/export de gastos e ingresos (reportes tipo Gasto / Ingreso Extra) vía
 * Excel (.xlsx). El backend genera la plantilla y procesa el archivo subido,
 * para no cargar al frontend con la generación/parseo del Excel.
 *
 * Columnas de la plantilla:
 *   id          (vacío al crear; requerido para actualizar)
 *   tipo        ("Gasto" | "Ingreso Extra")
 *   descripcion (texto)
 *   fecha       (YYYY-MM-DD)
 *   propietario (username o nombre; vacío = del conjunto)
 *   monto       (número entero en pesos)
 *   eliminar    ("x"/"si"/"true" para borrar esa fila; requiere id)
 */
const TIPOS_VALIDOS = ['Gasto', 'Ingreso Extra'];
const HEADERS = ['id', 'tipo', 'descripcion', 'fecha', 'propietario', 'monto', 'eliminar'];

export interface ImportRowResult {
  fila: number;
  accion: 'crear' | 'actualizar' | 'eliminar' | 'omitir' | 'error';
  detalle: string;
}

export interface ImportSummary {
  dryRun: boolean;
  totalFilas: number;
  crear: number;
  actualizar: number;
  eliminar: number;
  errores: number;
  resultados: ImportRowResult[];
}

@Injectable()
export class FinanceImportService {
  private readonly logger = new Logger(FinanceImportService.name);

  constructor(
    private readonly firebase: FirebaseService,
    private readonly reports: ReportsService,
  ) {}

  private norm(s: unknown): string {
    return String(s ?? '').trim().toLowerCase();
  }

  /** Propietarios del conjunto: [{username, nombre}]. Para la hoja de referencia. */
  private async getOwners(conjunto: string): Promise<{ username: string; nombre: string }[]> {
    if (!this.firebase.isEnabled()) return [];
    const snap = await this.firebase.db().ref('mirror/usuarios').get();
    if (!snap.exists()) return [];
    const all = Object.values(snap.val() || {}) as any[];
    return all
      .filter((u) => this.norm(u.rol) === 'propietario')
      .filter((u) => !conjunto || this.norm(u.conjunto) === this.norm(conjunto))
      .map((u) => ({ username: String(u.usuario ?? ''), nombre: String(u.nombre ?? u.usuario ?? '') }))
      .filter((o) => o.username);
  }

  // ---------------------------------------------------------------------------
  // Generar plantilla
  // ---------------------------------------------------------------------------

  /**
   * Genera el .xlsx. mode='create' => cabeceras + fila de ejemplo (sin id).
   * mode='edit' => data actual del conjunto/tipo con su id para actualizar.
   */
  async generateTemplate(opts: {
    conjunto: string;
    tipo?: string;
    mode: 'create' | 'edit';
    /** Filtra por propietario (username) en modo 'edit'. Vacío = todos. */
    propietario?: string;
  }): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'goPase';
    wb.created = new Date();

    const ws = wb.addWorksheet('Gastos e Ingresos');
    ws.columns = HEADERS.map((h) => ({
      header: h,
      key: h,
      width: h === 'descripcion' ? 32 : h === 'id' ? 24 : 16,
    }));
    // Estilo de cabecera.
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF1E3A8A' },
    };
    ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };

    if (opts.mode === 'edit') {
      const data = await this.reports.list({ conjunto: opts.conjunto });
      const propFiltro = this.norm(opts.propietario);
      const filtered = data.filter((r: any) => {
        const t = r.tipo || r.dato_7 || '';
        if (!TIPOS_VALIDOS.includes(t)) return false;
        if (opts.tipo && t !== opts.tipo) return false;
        // Filtro por propietario (username) si se indicó.
        if (propFiltro && this.norm(r.usuario ?? r.dato_4 ?? '') !== propFiltro) return false;
        return true;
      });
      for (const r of filtered) {
        ws.addRow({
          id: r.id ?? r.dato_1 ?? '',
          tipo: r.tipo ?? r.dato_7 ?? '',
          descripcion: r.descripcion ?? r.dato_5 ?? '',
          fecha: (r.fecha ?? r.dato_3 ?? '').toString().split('T')[0],
          propietario: r.usuario ?? r.dato_4 ?? '',
          monto: Number(r.ubicacion ?? r.dato_8 ?? 0) || 0,
          eliminar: '',
        });
      }
    } else {
      // Fila de ejemplo (se ignora si el usuario no la cambia: sin monto válido).
      ws.addRow({
        id: '',
        tipo: opts.tipo && TIPOS_VALIDOS.includes(opts.tipo) ? opts.tipo : 'Gasto',
        descripcion: 'Ejemplo: mantenimiento ascensor',
        fecha: new Date().toISOString().split('T')[0],
        propietario: '',
        monto: 0,
        eliminar: '',
      });
    }

    // Hoja de referencia con los propietarios válidos (ayuda al usuario).
    const owners = await this.getOwners(opts.conjunto);
    if (owners.length > 0) {
      const refs = wb.addWorksheet('Propietarios');
      refs.columns = [
        { header: 'usuario (para columna propietario)', key: 'username', width: 32 },
        { header: 'nombre', key: 'nombre', width: 32 },
      ];
      refs.getRow(1).font = { bold: true };
      owners.forEach((o) => refs.addRow(o));
    }

    const arrayBuffer = await wb.xlsx.writeBuffer();
    return Buffer.from(arrayBuffer);
  }

  // ---------------------------------------------------------------------------
  // Procesar import
  // ---------------------------------------------------------------------------

  /**
   * Procesa un .xlsx (base64). Con dryRun=true solo valida y devuelve el
   * resumen (preview), sin escribir. Con dryRun=false aplica los cambios.
   */
  async processImport(opts: {
    conjunto: string;
    fileBase64: string;
    dryRun: boolean;
  }): Promise<ImportSummary> {
    const summary: ImportSummary = {
      dryRun: opts.dryRun,
      totalFilas: 0,
      crear: 0,
      actualizar: 0,
      eliminar: 0,
      errores: 0,
      resultados: [],
    };

    const clean = opts.fileBase64.includes(',')
      ? opts.fileBase64.split(',').pop()!
      : opts.fileBase64;
    const buffer = Buffer.from(clean, 'base64');

    const wb = new ExcelJS.Workbook();
    try {
      await wb.xlsx.load(buffer as any);
    } catch {
      summary.errores = 1;
      summary.resultados.push({ fila: 0, accion: 'error', detalle: 'El archivo no es un .xlsx válido.' });
      return summary;
    }

    const ws = wb.worksheets[0];
    if (!ws) {
      summary.errores = 1;
      summary.resultados.push({ fila: 0, accion: 'error', detalle: 'El archivo no tiene hojas.' });
      return summary;
    }

    // Mapear cabeceras por nombre (tolerante al orden).
    const headerRow = ws.getRow(1);
    const colIndex: Record<string, number> = {};
    headerRow.eachCell((cell, col) => {
      const name = this.norm(cell.value);
      if (HEADERS.includes(name)) colIndex[name] = col;
    });
    if (colIndex['tipo'] == null || colIndex['monto'] == null) {
      summary.errores = 1;
      summary.resultados.push({
        fila: 1,
        accion: 'error',
        detalle: 'Faltan columnas obligatorias (al menos "tipo" y "monto").',
      });
      return summary;
    }

    const cellStr = (row: ExcelJS.Row, col?: number): string => {
      if (!col) return '';
      const v = row.getCell(col).value;
      if (v == null) return '';
      if (typeof v === 'object' && 'text' in (v as any)) return String((v as any).text).trim();
      if (typeof v === 'object' && 'result' in (v as any)) return String((v as any).result).trim();
      return String(v).trim();
    };

    // Acumula operaciones a aplicar (para no escribir en dry-run).
    const ops: Array<() => Promise<void>> = [];

    for (let i = 2; i <= ws.rowCount; i++) {
      const row = ws.getRow(i);
      const id = cellStr(row, colIndex['id']);
      const tipo = cellStr(row, colIndex['tipo']);
      const descripcion = cellStr(row, colIndex['descripcion']);
      const fecha = cellStr(row, colIndex['fecha']).split('T')[0];
      const propietario = cellStr(row, colIndex['propietario']);
      const montoRaw = cellStr(row, colIndex['monto']).replace(/[^\d.-]/g, '');
      const monto = Math.round(Number(montoRaw) || 0);
      const eliminar = this.norm(cellStr(row, colIndex['eliminar']));

      // Fila totalmente vacía: se omite silenciosamente.
      if (!id && !tipo && !descripcion && !montoRaw) continue;

      summary.totalFilas++;

      // Borrado explícito.
      if (['x', 'si', 'sí', 'true', '1'].includes(eliminar)) {
        if (!id) {
          summary.errores++;
          summary.resultados.push({ fila: i, accion: 'error', detalle: 'Para eliminar se requiere el id.' });
          continue;
        }
        summary.eliminar++;
        summary.resultados.push({ fila: i, accion: 'eliminar', detalle: `Se eliminará el registro ${id}.` });
        ops.push(async () => { await this.reports.remove(id); });
        continue;
      }

      // Validaciones comunes para crear/actualizar.
      if (!TIPOS_VALIDOS.includes(tipo)) {
        summary.errores++;
        summary.resultados.push({ fila: i, accion: 'error', detalle: `Tipo inválido: "${tipo}". Usa "Gasto" o "Ingreso Extra".` });
        continue;
      }
      if (!descripcion) {
        summary.errores++;
        summary.resultados.push({ fila: i, accion: 'error', detalle: 'Falta la descripción.' });
        continue;
      }
      if (!monto || monto <= 0) {
        summary.errores++;
        summary.resultados.push({ fila: i, accion: 'error', detalle: 'Monto inválido (debe ser mayor a 0).' });
        continue;
      }

      const dto = {
        titulo: descripcion,
        fecha: fecha || new Date().toISOString().split('T')[0],
        usuario: propietario,
        descripcion,
        conjunto: opts.conjunto,
        tipo,
        ubicacion: String(monto), // dato_8 = monto en reportes financieros
        estado: 'Registrado',
      };

      if (id) {
        summary.actualizar++;
        summary.resultados.push({ fila: i, accion: 'actualizar', detalle: `Actualizar ${id}: ${descripcion} ($${monto.toLocaleString()}).` });
        ops.push(async () => { await this.reports.update(id, dto); });
      } else {
        summary.crear++;
        summary.resultados.push({ fila: i, accion: 'crear', detalle: `Crear: ${descripcion} ($${monto.toLocaleString()}).` });
        const newId = `${Date.now()}_${i}_${Math.random().toString(36).slice(2, 6)}`;
        ops.push(async () => { await this.reports.create({ ...dto, id: newId }); });
      }
    }

    // Aplicar solo si NO es dry-run y no hubo errores de validación.
    if (!opts.dryRun && summary.errores === 0) {
      for (const op of ops) {
        try {
          await op();
        } catch (e: any) {
          summary.errores++;
          summary.resultados.push({ fila: 0, accion: 'error', detalle: e?.message || 'Error aplicando un cambio.' });
        }
      }
    }

    return summary;
  }
}
