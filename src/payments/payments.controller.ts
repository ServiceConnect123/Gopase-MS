import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
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
}
