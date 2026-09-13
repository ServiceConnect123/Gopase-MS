import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { PaymentsService } from './payments.service';

/**
 * Lecturas de la pantalla de Pagos (data ya calculada). El frontend solo pinta.
 * Lee de Firebase RTDB (mirror/). No usa Sheets.
 */
@ApiTags('payments')
@Controller('payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

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
      meses: string[];
      year: number;
      estado: string;
      referencia?: string;
      conjunto?: string;
      conjuntoId?: string;
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
}
