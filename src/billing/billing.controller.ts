import { Body, Controller, Delete, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { BillingService } from './billing.service';
import { EpaycoService } from './epayco.service';
import { AppConfigService } from './app-config.service';
import { Public } from '../auth/public.decorator';
import { SuperAdminGuard } from '../activity-audit/integrations/nest/super-admin.guard';

/** Facturación SaaS: pagos del conjunto hacia el superAdmin (RTDB mirror/facturas). */
@ApiTags('billing')
@Controller('billing')
export class BillingController {
  constructor(
    private readonly billing: BillingService,
    private readonly epayco: EpaycoService,
    private readonly appConfig: AppConfigService,
  ) {}

  @ApiOperation({ summary: 'Config de facturación (carpeta de Drive para comprobantes)' })
  @Get('config')
  config() {
    return {
      success: true,
      driveFolderId: this.billing.getDriveFolderId(),
      driveFolderName: this.billing.getDriveFolderName(),
    };
  }

  @ApiOperation({ summary: 'Lista de facturas (opcionalmente por conjunto)' })
  @ApiQuery({ name: 'conjunto', required: false })
  @Get()
  async list(@Query('conjunto') conjunto?: string) {
    const data = await this.billing.list(conjunto || '');
    return { success: true, data };
  }

  @ApiOperation({ summary: 'Crear factura (la crea el admin; queda pendiente)' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        conjunto: { type: 'string' },
        monto: { type: 'number', description: 'monto transferido (pagado) ahora' },
        montoObjetivo: { type: 'number', description: 'monto que debe pagar (precio del plan)' },
        planIdSolicitado: { type: 'string', description: 'si es una solicitud de cambio/activación de plan' },
        ciclo: { type: 'string', enum: ['mensual', 'anual'], description: 'ciclo de la suscripción' },
        moneda: { type: 'string', example: 'COP' },
        periodo: { type: 'string', example: '2026-02' },
        concepto: { type: 'string' },
        comprobanteUrl: { type: 'string', description: 'URL del comprobante (Drive)' },
        creadoPor: { type: 'string' },
        creadoPorNombre: { type: 'string' },
      },
      required: ['conjunto', 'monto'],
    },
  })
  @Post()
  async create(@Body() body: any) {
    return this.billing.create(body);
  }

  @ApiOperation({ summary: 'Confirmar/Rechazar/Devolver una factura (superAdmin)' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        estado: { type: 'string', enum: ['confirmada', 'rechazada', 'devuelta'] },
        revisadoPor: { type: 'string' },
        nota: { type: 'string', description: 'motivo; en devuelta, el faltante' },
      },
      required: ['estado'],
    },
  })
  @Post(':id/review')
  async review(@Param('id') id: string, @Body() body: any) {
    return this.billing.review(id, body);
  }

  @ApiOperation({ summary: 'Anexar comprobante del pago restante (admin, factura devuelta)' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        comprobanteUrl: { type: 'string' },
        montoAdicional: { type: 'number', description: 'monto del pago restante anexado' },
      },
      required: ['comprobanteUrl'],
    },
  })
  @Post(':id/comprobante')
  async addComprobante(@Param('id') id: string, @Body() body: any) {
    return this.billing.addComprobante(id, body);
  }

  @ApiOperation({ summary: 'Eliminar factura' })
  @Delete(':id')
  async remove(@Param('id') id: string) {
    return this.billing.remove(id);
  }

  @ApiOperation({ summary: 'Estado de suscripción de un conjunto (alDia/bloqueado/pagadoHasta)' })
  @ApiQuery({ name: 'conjunto', required: true })
  @Get('subscription')
  async subscription(@Query('conjunto') conjunto: string) {
    return this.billing.getEstadoSuscripcion(conjunto || '');
  }

  @ApiOperation({ summary: 'Recalcular bloqueos de todos los conjuntos (manual, para pruebas del cron)' })
  @Post('subscription/recompute')
  async recompute() {
    return this.billing.recomputarBloqueos();
  }

  @ApiOperation({ summary: 'Indica si ePayco está completamente configurado (público, para que el admin decida si mostrar el botón de pago electrónico).' })
  @Get('epayco/status')
  async epaycoStatus() {
    const cfg = await this.appConfig.getEpaycoConfigForUI();
    return { success: true, configured: cfg.configured };
  }

  // ===========================================================================
  // ePayco — configuración (solo superAdmin)
  // ===========================================================================

  @ApiOperation({
    summary: 'Obtiene la configuración de ePayco (superAdmin). La privateKey se enmascara.',
  })
  @UseGuards(SuperAdminGuard)
  @Get('epayco/config')
  async getEpaycoConfig() {
    const data = await this.appConfig.getEpaycoConfigForUI();
    return { success: true, data };
  }

  @ApiOperation({
    summary: 'Guarda la configuración de ePayco en RTDB (superAdmin). Activa desde la UI sin redesplegar.',
    description:
      'Persiste publicKey, privateKey, test y webhookBase en mirror/appConfig/epayco. ' +
      'Si privateKey llega vacía, conserva la guardada (no la borra). ' +
      'Las env vars EPAYCO_* siguen como fallback si el nodo RTDB no existe.',
  })
  @UseGuards(SuperAdminGuard)
  @Put('epayco/config')
  async saveEpaycoConfig(@Body() body: any) {
    const dto = {
      publicKey:   String(body?.publicKey   ?? '').trim(),
      privateKey:  String(body?.privateKey  ?? '').trim(),
      test:        body?.test === false || body?.test === 'false' ? false : true,
      webhookBase: String(body?.webhookBase ?? '').trim(),
    };
    return this.appConfig.saveEpaycoConfig(dto);
  }

  // ===========================================================================
  // ePayco — pasarela de pago electrónico (PSE + tarjeta)
  // ===========================================================================

  @ApiOperation({
    summary: 'Crea una sesión de Smart Checkout en ePayco. El frontend usa el sessionId para abrir el modal de pago.',
    description:
      'Hace login en la API de ePayco y crea la sesión de pago con el monto del plan y ciclo del conjunto. ' +
      'Requiere EPAYCO_PUBLIC_KEY y EPAYCO_PRIVATE_KEY en las variables de entorno del servidor.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        conjunto: { type: 'string', description: 'Nombre del conjunto.' },
        planId: { type: 'string', example: 'basico', description: 'ID del plan a pagar.' },
        ciclo: { type: 'string', enum: ['mensual', 'anual'], description: 'Ciclo de facturación.' },
        adminEmail: { type: 'string', description: 'Email del administrador (opcional, para la pantalla de pago).' },
        adminNombre: { type: 'string', description: 'Nombre del administrador (opcional).' },
        adminTelefono: { type: 'string', description: 'Teléfono del administrador, sin +57 (opcional).' },
      },
      required: ['conjunto', 'planId', 'ciclo'],
    },
  })
  @Post('epayco/session')
  async epaycoSession(@Body() body: any) {
    const { conjunto, planId, ciclo, adminEmail, adminNombre, adminTelefono } = body || {};
    if (!conjunto || !planId || !ciclo) {
      return { success: false, message: 'conjunto, planId y ciclo son requeridos.' };
    }
    return this.epayco.createSession({ conjunto, planId, ciclo, adminEmail, adminNombre, adminTelefono });
  }

  @ApiOperation({
    summary: 'Webhook de confirmación de ePayco. Verifica el pago, crea la factura y extiende la suscripción.',
    description:
      'ePayco llama este endpoint cuando una transacción se completa. Verifica la autenticidad con la API ' +
      'de ePayco, luego crea y confirma la factura en RTDB (extiende pagadoHasta del conjunto). ' +
      'Debe ser público (sin JWT) para que ePayco pueda llamarlo.',
  })
  @Public()
  @Post('epayco/webhook')
  async epaycoWebhook(@Body() body: any) {
    this.billing['logger']?.log?.(`[epayco] webhook recibido: ${JSON.stringify(body || {}).slice(0, 300)}`);
    return this.epayco.handleWebhook(body || {});
  }

  @ApiOperation({
    summary: 'Verifica el estado de una transacción ePayco por su referencia (ref_payco).',
    description:
      'Consulta la API pública de ePayco para confirmar si la transacción fue aceptada. ' +
      'Útil para el frontend después del onResponse del checkout (doble verificación).',
  })
  @Get('epayco/transaction/:ref')
  async epaycoTransaction(@Param('ref') ref: string) {
    if (!ref) return { success: false, message: 'Referencia requerida.' };
    const result = await this.epayco.verifyTransaction(ref);
    return { success: true, ...result };
  }
}
