import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { ReportsService } from './reports.service';
import { FinanceImportService } from './finance-import.service';

/** CRUD de reportes contra Firebase (RTDB). Reemplaza Sheets. */
@ApiTags('reports')
@Controller('reports')
export class ReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly financeImport: FinanceImportService,
  ) {}

  @ApiOperation({ summary: 'Lista de reportes (por conjunto y/o usuario)' })
  @ApiQuery({ name: 'conjunto', required: false })
  @ApiQuery({ name: 'usuario', required: false })
  @Get()
  async list(@Query('conjunto') conjunto?: string, @Query('usuario') usuario?: string) {
    const data = await this.reports.list({ conjunto: conjunto || '', usuario: usuario || '' });
    return { success: true, data };
  }

  @ApiOperation({ summary: 'Crear reporte' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        titulo: { type: 'string' },
        fecha: { type: 'string' },
        usuario: { type: 'string', description: 'autor (username)' },
        descripcion: { type: 'string' },
        conjunto: { type: 'string' },
        tipo: { type: 'string' },
        ubicacion: { type: 'string' },
        estado: { type: 'string' },
      },
      required: ['titulo'],
    },
  })
  @Post()
  async create(@Body() body: any) {
    return this.reports.create(body);
  }

  @ApiOperation({ summary: 'Editar reporte (merge de campos presentes)' })
  @Put(':id')
  async update(@Param('id') id: string, @Body() body: any) {
    return this.reports.update(id, body);
  }

  @ApiOperation({ summary: 'Eliminar reporte' })
  @Delete(':id')
  async remove(@Param('id') id: string) {
    return this.reports.remove(id);
  }

  // ==========================================================================
  // Import/Export de gastos e ingresos (Excel) — generado/procesado en backend
  // ==========================================================================

  @ApiOperation({
    summary: 'Descargar plantilla Excel de gastos/ingresos (crear o editar)',
    description:
      'Devuelve un .xlsx en base64. mode=create: plantilla vacía con ejemplo. ' +
      'mode=edit: la data actual del conjunto (con id) para editar y re-subir.',
  })
  @ApiQuery({ name: 'conjunto', required: true })
  @ApiQuery({ name: 'tipo', required: false, description: 'Gasto | Ingreso Extra' })
  @ApiQuery({ name: 'mode', required: false, enum: ['create', 'edit'] })
  @ApiQuery({ name: 'propietario', required: false, description: 'Filtra por propietario (username) en modo edit' })
  @Get('finance-template')
  async financeTemplate(
    @Query('conjunto') conjunto: string,
    @Query('tipo') tipo?: string,
    @Query('mode') mode?: 'create' | 'edit',
    @Query('propietario') propietario?: string,
  ) {
    const buffer = await this.financeImport.generateTemplate({
      conjunto: conjunto || '',
      tipo,
      mode: mode === 'edit' ? 'edit' : 'create',
      propietario: propietario || '',
    });
    const nombre = `gopase_${mode === 'edit' ? 'editar' : 'plantilla'}_gastos_ingresos.xlsx`;
    return {
      success: true,
      fileName: nombre,
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      base64: buffer.toString('base64'),
    };
  }

  @ApiOperation({
    summary: 'Importar gastos/ingresos desde Excel (upsert por id, borrado por marca)',
    description:
      'Recibe el .xlsx en base64. dryRun=true devuelve el resumen sin aplicar (preview). ' +
      'dryRun=false aplica los cambios si no hay errores de validación.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        conjunto: { type: 'string' },
        fileBase64: { type: 'string' },
        dryRun: { type: 'boolean' },
      },
      required: ['conjunto', 'fileBase64'],
    },
  })
  @Post('finance-import')
  async financeImportFile(
    @Body() body: { conjunto: string; fileBase64: string; dryRun?: boolean },
  ) {
    const summary = await this.financeImport.processImport({
      conjunto: body.conjunto || '',
      fileBase64: body.fileBase64 || '',
      dryRun: body.dryRun !== false, // por defecto dry-run (seguro)
    });
    return { success: summary.errores === 0, summary };
  }
}
