import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { BenefitsService } from './benefits.service';

/**
 * CRUD de beneficios globales (descuentos/estímulos) contra Firebase (RTDB).
 * Ámbito: por conjunto (cada conjunto configura sus propios beneficios).
 */
@ApiTags('benefits')
@Controller('benefits')
export class BenefitsController {
  constructor(private readonly benefits: BenefitsService) {}

  @ApiOperation({ summary: 'Lista de beneficios (filtrada por conjunto)' })
  @ApiQuery({ name: 'conjunto', required: false })
  @Get()
  async list(@Query('conjunto') conjunto?: string) {
    const data = await this.benefits.list({ conjunto: conjunto || '' });
    return { success: true, data };
  }

  @ApiOperation({ summary: 'Crear beneficio' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        conjunto: { type: 'string' },
        nombre: { type: 'string' },
        descripcion: { type: 'string' },
        tipo: { type: 'string', description: 'porcentaje | monto_fijo | mes_gratis | exencion_mora' },
        valor: { type: 'number' },
        modalidad: { type: 'string', description: 'automatico | manual' },
        regla: { type: 'object', description: '{ tipo, params }' },
        aplicaA: { type: 'string', description: "'todos' o username" },
        fechaInicio: { type: 'string' },
        fechaFin: { type: 'string' },
        activo: { type: 'boolean' },
        aplicacionesMes: { type: 'number' },
        createdBy: { type: 'string' },
      },
      required: ['nombre', 'tipo'],
    },
  })
  @Post()
  async create(@Body() body: any) {
    return this.benefits.create(body);
  }

  @ApiOperation({ summary: 'Editar beneficio' })
  @Put(':id')
  async update(@Param('id') id: string, @Body() body: any) {
    return this.benefits.update(id, body);
  }

  @ApiOperation({ summary: 'Eliminar beneficio' })
  @Delete(':id')
  async remove(@Param('id') id: string) {
    return this.benefits.remove(id);
  }
}
