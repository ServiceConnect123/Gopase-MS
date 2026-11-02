import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { FundsService } from './funds.service';

/** CRUD de tipos de recaudo (fondos) por conjunto. RTDB mirror/tipos_recaudo. */
@ApiTags('funds')
@Controller('funds')
export class FundsController {
  constructor(private readonly funds: FundsService) {}

  @ApiOperation({ summary: 'Lista de tipos de recaudo (siembra "Administración" por conjunto)' })
  @ApiQuery({ name: 'conjunto', required: false })
  @Get()
  async list(@Query('conjunto') conjunto?: string) {
    const data = await this.funds.list(conjunto || '');
    return { success: true, data };
  }

  @ApiOperation({ summary: 'Crear tipo de recaudo' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        conjunto: { type: 'string' },
        nombre: { type: 'string' },
        visibleParaPropietario: { type: 'boolean' },
        metaMensual: { type: 'number' },
        cajaPropia: { type: 'boolean', description: 'si true, es una caja separada (saldo propio)' },
      },
      required: ['conjunto', 'nombre'],
    },
  })
  @Post()
  async create(@Body() body: any) {
    return this.funds.create(body);
  }

  @ApiOperation({ summary: 'Editar tipo de recaudo' })
  @Put(':id')
  async update(@Param('id') id: string, @Body() body: any) {
    return this.funds.update(id, body);
  }

  @ApiOperation({ summary: 'Eliminar tipo de recaudo (no el por defecto)' })
  @Delete(':id')
  async remove(@Param('id') id: string) {
    return this.funds.remove(id);
  }
}
