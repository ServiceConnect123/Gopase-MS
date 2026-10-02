import { Injectable, Logger } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import { FirebaseService } from '../firebase/firebase.service';
import { UsersService } from './users.service';

/**
 * Import/export MASIVO de PROPIETARIOS vía Excel (.xlsx). El backend genera la
 * plantilla y procesa el archivo subido, reutilizando UsersService (RTDB + Auth).
 *
 * Reglas de seguridad:
 *  - Solo opera sobre usuarios con rol "propietario".
 *  - NUNCA crea ni edita superAdmin (ni permite setear ese rol). Si una fila
 *    apunta a un superAdmin existente o intenta asignar rol superAdmin, se
 *    rechaza con error.
 *  - La contraseña NO está en la plantilla (los propietarios no la usan).
 *
 * Columnas de la plantilla:
 *   usuario      (vacío = crear; con valor = actualizar al usuario con ese username)
 *   nombre       (requerido para crear; genera el username si usuario está vacío)
 *   email
 *   documentType (CC | CE | PAS | NIT)
 *   documentNumber
 *   phone
 *   conjunto
 *   parcela
 *   placa1
 *   placa2
 *   fechaIngreso (YYYY-MM-DD)
 *   eliminar     ("x"/"si"/"true" para borrar esa fila; requiere usuario)
 */
const HEADERS = [
  'usuario', 'nombre', 'email', 'documentType', 'documentNumber',
  'phone', 'conjunto', 'parcela', 'placa1', 'placa2', 'fechaIngreso', 'eliminar',
];

export interface UsersImportRowResult {
  fila: number;
  accion: 'crear' | 'actualizar' | 'eliminar' | 'omitir' | 'error';
  detalle: string;
}

export interface UsersImportSummary {
  dryRun: boolean;
  totalFilas: number;
  crear: number;
  actualizar: number;
  eliminar: number;
  errores: number;
  resultados: UsersImportRowResult[];
}

const MIRROR_USERS = 'mirror/usuarios';

@Injectable()
export class UsersImportService {
  private readonly logger = new Logger(UsersImportService.name);

  constructor(
    private readonly firebase: FirebaseService,
    private readonly users: UsersService,
  ) {}

  private norm(s: unknown): string {
    return String(s ?? '').trim().toLowerCase();
  }

  /** Genera username desde el nombre (misma lógica que el frontend). */
  private generarUsuario(nombre: string): string {
    return (nombre || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');
  }

  /** Propietarios del conjunto (desde RTDB). Excluye superAdmin siempre. */
  private async getPropietarios(conjunto: string): Promise<any[]> {
    if (!this.firebase.isEnabled()) return [];
    const snap = await this.firebase.db().ref(MIRROR_USERS).get();
    if (!snap.exists()) return [];
    const all = Object.values(snap.val() || {}) as any[];
    return all
      .filter((u) => this.norm(u.rol) === 'propietario')
      .filter((u) => !conjunto || this.norm(u.conjunto) === this.norm(conjunto));
  }

  /** Mapa username -> rol (para validar que no se toque un superAdmin). */
  private async getRolesByUsername(): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    if (!this.firebase.isEnabled()) return map;
    const snap = await this.firebase.db().ref(MIRROR_USERS).get();
    if (!snap.exists()) return map;
    for (const u of Object.values(snap.val() || {}) as any[]) {
      const uname = this.norm(u.usuario);
      if (uname) map.set(uname, this.norm(u.rol));
    }
    return map;
  }

  // ---------------------------------------------------------------------------
  // Generar plantilla
  // ---------------------------------------------------------------------------

  async generateTemplate(opts: { conjunto: string; mode: 'create' | 'edit' }): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'goPase';
    wb.created = new Date();

    const ws = wb.addWorksheet('Propietarios');
    ws.columns = HEADERS.map((h) => ({
      header: h,
      key: h,
      width: h === 'nombre' || h === 'email' ? 28 : h === 'usuario' ? 22 : 16,
    }));
    ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A8A' } };

    if (opts.mode === 'edit') {
      const propietarios = await this.getPropietarios(opts.conjunto);
      for (const u of propietarios) {
        ws.addRow({
          usuario: u.usuario ?? '',
          nombre: u.nombre ?? '',
          email: u.email ?? '',
          documentType: u.docType ?? '',
          documentNumber: u.docNum ?? '',
          phone: u.phone ?? '',
          conjunto: u.conjunto ?? '',
          parcela: u.parcela ?? '',
          placa1: u.placa1 ?? '',
          placa2: u.placa2 ?? '',
          fechaIngreso: (u.fechaIngreso ?? '').toString().split('T')[0],
          eliminar: '',
        });
      }
    } else {
      ws.addRow({
        usuario: '',
        nombre: 'Ejemplo: Juan Pérez',
        email: 'juan@correo.com',
        documentType: 'CC',
        documentNumber: '123456789',
        phone: '3001234567',
        conjunto: opts.conjunto || '',
        parcela: 'Casa 1',
        placa1: '',
        placa2: '',
        fechaIngreso: new Date().toISOString().split('T')[0],
        eliminar: '',
      });
    }

    const arrayBuffer = await wb.xlsx.writeBuffer();
    return Buffer.from(arrayBuffer);
  }

  // ---------------------------------------------------------------------------
  // Procesar import
  // ---------------------------------------------------------------------------

  async processImport(opts: {
    conjunto: string;
    fileBase64: string;
    dryRun: boolean;
  }): Promise<UsersImportSummary> {
    const summary: UsersImportSummary = {
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
    if (colIndex['nombre'] == null && colIndex['usuario'] == null) {
      summary.errores = 1;
      summary.resultados.push({
        fila: 1, accion: 'error',
        detalle: 'Faltan columnas obligatorias (al menos "usuario" o "nombre").',
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

    const rolesByUsername = await this.getRolesByUsername();
    const usernamesEnArchivo = new Set<string>();
    const ops: Array<() => Promise<void>> = [];

    for (let i = 2; i <= ws.rowCount; i++) {
      const row = ws.getRow(i);
      const usuario = cellStr(row, colIndex['usuario']);
      const nombre = cellStr(row, colIndex['nombre']);
      const email = cellStr(row, colIndex['email']);
      const documentType = cellStr(row, colIndex['documentType']);
      const documentNumber = cellStr(row, colIndex['documentNumber']);
      const phone = cellStr(row, colIndex['phone']);
      const conjunto = cellStr(row, colIndex['conjunto']) || opts.conjunto;
      const parcela = cellStr(row, colIndex['parcela']);
      const placa1 = cellStr(row, colIndex['placa1']);
      const placa2 = cellStr(row, colIndex['placa2']);
      const fechaIngreso = cellStr(row, colIndex['fechaIngreso']).split('T')[0];
      const eliminar = this.norm(cellStr(row, colIndex['eliminar']));

      // Fila totalmente vacía: se omite.
      if (!usuario && !nombre && !email && !documentNumber) continue;

      summary.totalFilas++;

      // Protección: nunca tocar un superAdmin existente.
      const rolExistente = usuario ? rolesByUsername.get(this.norm(usuario)) : undefined;
      if (rolExistente === 'superadmin') {
        summary.errores++;
        summary.resultados.push({ fila: i, accion: 'error', detalle: `"${usuario}" es superAdmin y no puede editarse aquí.` });
        continue;
      }

      // Borrado explícito.
      if (['x', 'si', 'sí', 'true', '1'].includes(eliminar)) {
        if (!usuario) {
          summary.errores++;
          summary.resultados.push({ fila: i, accion: 'error', detalle: 'Para eliminar se requiere el "usuario".' });
          continue;
        }
        summary.eliminar++;
        summary.resultados.push({ fila: i, accion: 'eliminar', detalle: `Se eliminará el propietario ${usuario}.` });
        ops.push(async () => { await this.users.remove(usuario); });
        continue;
      }

      // Validaciones.
      if (!usuario && !nombre) {
        summary.errores++;
        summary.resultados.push({ fila: i, accion: 'error', detalle: 'Falta el nombre (requerido para crear).' });
        continue;
      }

      // DTO común. rol SIEMPRE "propietario" (no se permite cambiarlo por Excel).
      const dto = {
        email, nombre, rol: 'propietario',
        documentType, documentNumber, phone,
        conjunto, parcela, placa1, placa2, fechaIngreso,
      };

      if (usuario) {
        // Actualizar.
        const dup = this.norm(usuario);
        if (usernamesEnArchivo.has(dup)) {
          summary.errores++;
          summary.resultados.push({ fila: i, accion: 'error', detalle: `"${usuario}" está repetido en el archivo.` });
          continue;
        }
        usernamesEnArchivo.add(dup);
        summary.actualizar++;
        summary.resultados.push({ fila: i, accion: 'actualizar', detalle: `Actualizar ${usuario}: ${nombre || '(sin nombre)'}.` });
        ops.push(async () => { await this.users.update(usuario, dto); });
      } else {
        // Crear: genera username desde el nombre.
        const nuevoUsuario = this.generarUsuario(nombre);
        if (!nuevoUsuario) {
          summary.errores++;
          summary.resultados.push({ fila: i, accion: 'error', detalle: `El nombre "${nombre}" no genera un usuario válido.` });
          continue;
        }
        const dup = this.norm(nuevoUsuario);
        if (usernamesEnArchivo.has(dup) || rolesByUsername.has(dup)) {
          summary.errores++;
          summary.resultados.push({ fila: i, accion: 'error', detalle: `El usuario "${nuevoUsuario}" (de "${nombre}") ya existe o está repetido.` });
          continue;
        }
        usernamesEnArchivo.add(dup);
        summary.crear++;
        summary.resultados.push({ fila: i, accion: 'crear', detalle: `Crear ${nuevoUsuario}: ${nombre}.` });
        ops.push(async () => { await this.users.create({ ...dto, usuario: nuevoUsuario }); });
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
