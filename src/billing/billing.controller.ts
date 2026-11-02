import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { BillingService } from './billing.service';

/** Facturación SaaS: pagos del conjunto hacia el superAdmin (RTDB mirror/facturas). */
@ApiTags('billing')
@Controller('billing')
export class BillingController {
  constructor(private readonly billing: BillingService) {}

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
        monto: { type: 'number', description: 'monto libre según el plan del conjunto' },
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

  @ApiOperation({ summary: 'Confirmar/Rechazar una factura (superAdmin)' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        estado: { type: 'string', enum: ['confirmada', 'rechazada'] },
        revisadoPor: { type: 'string' },
        nota: { type: 'string' },
      },
      required: ['estado'],
    },
  })
  @Post(':id/review')
  async review(@Param('id') id: string, @Body() body: any) {
    return this.billing.review(id, body);
  }

  @ApiOperation({ summary: 'Eliminar factura' })
  @Delete(':id')
  async remove(@Param('id') id: string) {
    return this.billing.remove(id);
  }
}
