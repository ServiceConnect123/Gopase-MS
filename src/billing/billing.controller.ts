import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { BillingService } from './billing.service';

/** Facturación SaaS: pagos del conjunto hacia el superAdmin (RTDB mirror/facturas). */
@ApiTags('billing')
@Controller('billing')
export class BillingController {
  constructor(private readonly billing: BillingService) {}

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
}
