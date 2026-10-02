import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { PaymentsService } from './payments.service';
import { PaymentsImportService } from './payments-import.service';

/**
 * Lecturas de la pantalla de Pagos (data ya calculada). El frontend solo pinta.
 * Lee de Firebase RTDB (mirror/). No usa Sheets.
 */
@ApiTags('payments')
@Controller('payments')
export class PaymentsController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly paymentsImport: PaymentsImportService,
  ) {}

  // ==========================================================================
  // Carga masiva de PAGOS (Excel, una hoja por propietario)
  // ==========================================================================

  @ApiOperation({
    summary: 'Descargar plantilla Excel de pagos (una hoja por propietario)',
    description:
      'mode=edit: cada hoja trae TODOS los pagos del propietario (todos los años). ' +
      'mode=create: hojas con una fila de ejemplo. Edición directa, sin OCR ni Mercado Pago.',
  })
  @ApiQuery({ name: 'conjunto', required: false })
  @ApiQuery({ name: 'superAdmin', required: false, type: Boolean })
  @ApiQuery({ name: 'mode', required: false, enum: ['create', 'edit'] })
  @Get('import-template')
  async importTemplate(
    @Query('conjunto') conjunto?: string,
    @Query('superAdmin') superAdmin?: string,
    @Query('mode') mode?: 'create' | 'edit',
  ) {
    const buffer = await this.paymentsImport.generateTemplate({
      conjunto: conjunto || '',
      isSuperAdmin: superAdmin === 'true',
      mode: mode === 'create' ? 'create' : 'edit',
    });
    return {
      success: true,
      fileName: `gopase_pagos.xlsx`,
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      base64: buffer.toString('base64'),
    };
  }

  @ApiOperation({
    summary: 'Importar pagos desde Excel (crear/actualizar/eliminar en bloque)',
    description:
      'dryRun=true devuelve el resumen sin aplicar (preview). dryRun=false aplica si no hay errores. ' +
      'Edición directa sobre los pagos; no pasa por Mercado Pago ni OCR.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        conjunto: { type: 'string' },
        superAdmin: { type: 'boolean' },
        fileBase64: { type: 'string' },
        dryRun: { type: 'boolean' },
      },
      required: ['fileBase64'],
    },
  })
  @Post('import')
  async importFile(
    @Body()
    body: { conjunto?: string; superAdmin?: boolean; fileBase64: string; dryRun?: boolean },
  ) {
    const summary = await this.paymentsImport.processImport({
      conjunto: body.conjunto || '',
      isSuperAdmin: body.superAdmin === true,
      fileBase64: body.fileBase64 || '',
      dryRun: body.dryRun !== false, // por defecto dry-run (seguro)
    });
    return { success: summary.errores === 0, summary };
  }

  @ApiOperation({ summary: 'Lista de propietarios con estado de pago (vista admin)' })
  @ApiQuery({ name: 'conjunto', required: false })
  @ApiQuery({ name: 'year', required: false, type: Number })
  @ApiQuery({ name: 'superAdmin', required: false, type: Boolean })
  @Get('admin-list')
  async adminList(
    @Query('conjunto') conjunto?: string,
    @Query('year') year?: string,
    @Query('superAdmin') superAdmin?: string,
  ) {
    const data = await this.payments.getAdminList(
      conjunto || '',
      year ? parseInt(year, 10) : new Date().getFullYear(),
      superAdmin === 'true',
    );
    return { success: true, data };
  }

  @ApiOperation({ summary: 'Estado de pago mes a mes de un usuario' })
  @ApiQuery({ name: 'username', required: true })
  @ApiQuery({ name: 'year', required: false, type: Number })
  @Get('user-months')
  async userMonths(@Query('username') username: string, @Query('year') year?: string) {
    const data = await this.payments.getUserMonths(
      username || '',
      year ? parseInt(year, 10) : new Date().getFullYear(),
    );
    return { success: true, data };
  }

  @ApiOperation({ summary: 'Pagos crudos del conjunto en el año (vista admin, lista de pagos)' })
  @ApiQuery({ name: 'conjunto', required: false })
  @ApiQuery({ name: 'year', required: false, type: Number })
  @ApiQuery({ name: 'superAdmin', required: false, type: Boolean })
  @Get('list')
  async list(
    @Query('conjunto') conjunto?: string,
    @Query('year') year?: string,
    @Query('superAdmin') superAdmin?: string,
  ) {
    const data = await this.payments.getPaymentsList(
      conjunto || '',
      year ? parseInt(year, 10) : new Date().getFullYear(),
      superAdmin === 'true',
    );
    return { success: true, data };
  }

  @ApiOperation({ summary: 'Pagos de un propietario (su propia vista)' })
  @ApiQuery({ name: 'username', required: true })
  @ApiQuery({ name: 'year', required: false, type: Number })
  @Get('owner')
  async owner(@Query('username') username: string, @Query('year') year?: string) {
    const data = await this.payments.getOwnerPayments(
      username || '',
      year ? parseInt(year, 10) : new Date().getFullYear(),
    );
    return { success: true, data };
  }

  @ApiOperation({ summary: 'Deudores de un mes (con teléfono) para recordatorios' })
  @ApiQuery({ name: 'conjunto', required: false })
  @ApiQuery({ name: 'month', required: true })
  @ApiQuery({ name: 'year', required: false, type: Number })
  @ApiQuery({ name: 'onlyWithPhone', required: false, type: Boolean })
  @Get('debtors')
  async debtors(
    @Query('month') month: string,
    @Query('conjunto') conjunto?: string,
    @Query('year') year?: string,
    @Query('onlyWithPhone') onlyWithPhone?: string,
  ) {
    const data = await this.payments.getDebtors(
      conjunto || '',
      month || '',
      year ? parseInt(year, 10) : new Date().getFullYear(),
      onlyWithPhone !== 'false',
    );
    return { success: true, data };
  }

  @ApiOperation({
    summary: 'Resumen financiero del año (desglose mensual + totales + saldo de caja con arrastre)',
    description: 'Calcula en backend lo que kpi.tsx hacía en cliente. El saldo de caja arrastra el saldo acumulado de años anteriores.',
  })
  @ApiQuery({ name: 'conjunto', required: false })
  @ApiQuery({ name: 'year', required: false, type: Number })
  @ApiQuery({ name: 'superAdmin', required: false, type: Boolean })
  @Get('finance-summary')
  async financeSummary(
    @Query('conjunto') conjunto?: string,
    @Query('year') year?: string,
    @Query('superAdmin') superAdmin?: string,
  ) {
    const data = await this.payments.getFinanceSummary(
      conjunto || '',
      year ? parseInt(year, 10) : new Date().getFullYear(),
      superAdmin === 'true',
    );
    return { success: true, ...data };
  }

  @ApiOperation({
    summary: 'Marca/desmarca un pago como duplicado validado (no vuelve al reporte)',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: { id: { type: 'string' }, ok: { type: 'boolean' } },
      required: ['id'],
    },
  })
  @Post('duplicates/validate')
  async validateDuplicate(@Body() body: { id: string; ok?: boolean }) {
    return this.payments.setDuplicateOk(body.id, body.ok !== false);
  }

  @ApiOperation({ summary: 'Pagos duplicados por (usuario+mes+año) para auditar' })
  @ApiQuery({ name: 'conjunto', required: false })
  @ApiQuery({ name: 'year', required: false, type: Number, description: 'year<=0 = todos los años' })
  @ApiQuery({ name: 'superAdmin', required: false, type: Boolean })
  @Get('duplicates')
  async duplicates(
    @Query('conjunto') conjunto?: string,
    @Query('year') year?: string,
    @Query('superAdmin') superAdmin?: string,
  ) {
    const data = await this.payments.getDuplicatePayments(
      conjunto || '',
      year !== undefined ? parseInt(year, 10) : new Date().getFullYear(),
      superAdmin === 'true',
    );
    return { success: true, data };
  }

  // ==================== ESCRITURAS (Fase 2) ====================

  @ApiOperation({ summary: 'Crear pago(s) de administración (uno por mes)' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        usuario: { type: 'string' },
        montoPerMonth: { type: 'string' },
        meses: { type: 'array', items: { type: 'string' } },
        year: { type: 'number' },
        estado: { type: 'string', example: 'Confirmado' },
        referencia: { type: 'string' },
        conjunto: { type: 'string' },
        conjuntoId: { type: 'string' },
      },
      required: ['usuario', 'montoPerMonth', 'meses', 'year', 'estado'],
    },
  })
  @Post()
  async create(
    @Body()
    body: {
      usuario: string;
      montoPerMonth: string | number;
      meses?: string[];
      year: number;
      estado: string;
      referencia?: string;
      conjunto?: string;
      conjuntoId?: string;
      concepto?: string;
    },
  ) {
    return this.payments.createPayments({
      usuario: body.usuario,
      montoPerMonth: body.montoPerMonth,
      meses: body.meses || [],
      year: body.year || new Date().getFullYear(),
      estado: body.estado,
      referencia: body.referencia || '',
      conjunto: body.conjunto,
      conjuntoId: body.conjuntoId,
      concepto: body.concepto,
    });
  }

  @ApiOperation({ summary: 'Editar un pago existente' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        usuario: { type: 'string' },
        concepto: { type: 'string' },
        valor: { type: 'string' },
        fecha: { type: 'string' },
        estado: { type: 'string' },
        referencia: { type: 'string' },
      },
    },
  })
  @Put(':id')
  async update(@Param('id') id: string, @Body() body: Record<string, any>) {
    return this.payments.updatePayment(id, body);
  }

  @ApiOperation({ summary: 'Eliminar un pago' })
  @Delete(':id')
  async remove(@Param('id') id: string) {
    return this.payments.deletePayment(id);
  }

  @ApiOperation({ summary: 'Aprobar/Rechazar un pago (actualiza reserva vinculada)' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        estado: { type: 'string', enum: ['Confirmado', 'Rechazado'] },
        valor: { type: 'string' },
        referencia: { type: 'string' },
      },
      required: ['id', 'estado'],
    },
  })
  @Post('review')
  async review(
    @Body() body: { id: string; estado: 'Confirmado' | 'Rechazado'; valor?: string | number; referencia?: string },
  ) {
    return this.payments.reviewPayment(body);
  }

  @ApiOperation({ summary: 'Analizar comprobante con IA (Gemini); la clave no sale al cliente' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        conjunto: { type: 'string' },
        imageBase64: { type: 'string' },
        soloExtraerMonto: { type: 'boolean' },
      },
      required: ['conjunto', 'imageBase64'],
    },
  })
  @Post('analyze-receipt')
  async analyzeReceipt(
    @Body() body: { conjunto: string; imageBase64: string; soloExtraerMonto?: boolean },
  ) {
    return this.payments.analyzeReceipt(body);
  }

  @ApiOperation({
    summary: 'Chat financiero con IA (Gemini); la clave del conjunto no sale al cliente',
    description:
      'Responde preguntas de finanzas del conjunto. El cliente envía el conjunto, la pregunta ' +
      'y un contexto financiero ya resumido; el backend usa la geminiKey del conjunto.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        conjunto: { type: 'string' },
        question: { type: 'string', description: 'Pregunta del usuario. Vacío = análisis general.' },
        context: { type: 'string', description: 'Contexto financiero ya resumido (datos del conjunto).' },
      },
      required: ['conjunto'],
    },
  })
  @Post('finance-chat')
  async financeChat(
    @Body() body: { conjunto: string; question?: string; context?: string },
  ) {
    return this.payments.financeChat(body);
  }

  @ApiOperation({ summary: 'Crear preferencia de Mercado Pago; la clave no sale al cliente' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        conjunto: { type: 'string' },
        usuario: { type: 'string' },
        nombre: { type: 'string' },
        meses: { type: 'array', items: { type: 'string' } },
        monto: { type: 'number' },
        concepto: { type: 'string' },
        preferredMethod: { type: 'string', example: 'nequi' },
      },
      required: ['conjunto', 'usuario'],
    },
  })
  @Post('preference')
  async preference(
    @Body()
    body: {
      conjunto: string;
      usuario: string;
      nombre?: string;
      meses?: string[];
      monto?: number;
      concepto?: string;
      preferredMethod?: string;
    },
  ) {
    return this.payments.createPreference(body);
  }
}
