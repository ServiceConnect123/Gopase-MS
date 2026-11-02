import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { PlansService } from './plans.service';

/** Catálogo de planes SaaS + asignación de plan a conjuntos (RTDB mirror/planes). */
@ApiTags('plans')
@Controller('plans')
export class PlansController {
  constructor(private readonly plans: PlansService) {}

  @ApiOperation({ summary: 'Catálogo de planes (base + especiales del conjunto si se pasa)' })
  @ApiQuery({ name: 'conjunto', required: false, description: 'Filtra especiales por conjunto dueño' })
  @Get()
  async list(@Query('conjunto') conjunto?: string) {
    const data = await this.plans.list(conjunto || '');
    return { success: true, data };
  }

  @ApiOperation({ summary: 'Plan efectivo de un conjunto (default básico si no tiene)' })
  @ApiQuery({ name: 'conjunto', required: true })
  @Get('of-conjunto')
  async ofConjunto(@Query('conjunto') conjunto: string) {
    const plan = await this.plans.getPlanDeConjunto(conjunto || '');
    return { success: true, plan };
  }

  @ApiOperation({ summary: 'Crear plan especial (clona un plan base con precio custom)' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        nombre: { type: 'string' },
        baseId: { type: 'string', enum: ['basico', 'medio', 'premium'] },
        precioMensual: { type: 'number' },
        conjunto: { type: 'string', description: 'conjunto dueño (solo él lo verá)' },
        moneda: { type: 'string', example: 'COP' },
        descripcion: { type: 'string' },
        descuentoAnual: { type: 'number', example: 0.1 },
      },
      required: ['nombre', 'baseId', 'precioMensual'],
    },
  })
  @Post('especial')
  async createEspecial(@Body() body: any) {
    return this.plans.createEspecial(body);
  }

  @ApiOperation({ summary: 'Editar un plan (base: solo precio/descripción; especial: también módulos)' })
  @Put(':id')
  async update(@Param('id') id: string, @Body() body: any) {
    return this.plans.update(id, body);
  }

  @ApiOperation({ summary: 'Asignar un plan a un conjunto' })
  @ApiBody({ schema: { type: 'object', properties: { conjunto: { type: 'string' }, planId: { type: 'string' } }, required: ['conjunto', 'planId'] } })
  @Post('assign')
  async assign(@Body() body: { conjunto: string; planId: string }) {
    return this.plans.assign(body?.conjunto || '', body?.planId || '');
  }

  @ApiOperation({ summary: 'Eliminar un plan (los base no se pueden eliminar)' })
  @Delete(':id')
  async remove(@Param('id') id: string) {
    return this.plans.remove(id);
  }
}
