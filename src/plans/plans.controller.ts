import { Body, Controller, Delete, ForbiddenException, Get, Param, Post, Put, Query, Req } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/public.decorator';
import { PlansService } from './plans.service';

/** Catálogo de planes SaaS + asignación de plan a conjuntos (RTDB mirror/planes). */
@ApiTags('plans')
@Controller('plans')
export class PlansController {
  constructor(private readonly plans: PlansService) {}

  /**
   * Las escrituras del catálogo (precios, planes especiales, asignaciones y
   * unidades de un conjunto) son solo del superAdmin: definen lo que se cobra.
   * Si el guard JWT está apagado (no hay req.user) no se restringe, igual que
   * el resto de guards durante el rollout.
   */
  private assertSuperAdmin(req: any): void {
    const user = req?.user;
    if (user && String(user.rol || '').toLowerCase() !== 'superadmin') {
      throw new ForbiddenException('Solo el administrador general puede modificar los planes.');
    }
  }

  @ApiOperation({ summary: 'Catálogo público de planes base con precios por número de unidades (landing)' })
  @Public()
  @Get('catalogo')
  async catalogo() {
    const data = await this.plans.catalogoPublico();
    return { success: true, data };
  }

  @ApiOperation({ summary: 'Catálogo de planes (base + especiales del conjunto si se pasa; con conjunto, precios calculados para su tamaño)' })
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
  async createEspecial(@Body() body: any, @Req() req: any) {
    this.assertSuperAdmin(req);
    return this.plans.createEspecial(body);
  }

  @ApiOperation({ summary: 'Guardar el número de unidades (apartamentos/casas) de un conjunto' })
  @ApiBody({ schema: { type: 'object', properties: { conjunto: { type: 'string' }, unidades: { type: 'number' } }, required: ['conjunto', 'unidades'] } })
  @Put('unidades')
  async setUnidades(@Body() body: { conjunto: string; unidades: number }, @Req() req: any) {
    this.assertSuperAdmin(req);
    return this.plans.setUnidades(body?.conjunto || '', body?.unidades);
  }

  @ApiOperation({ summary: 'Editar un plan (base: precio, descripción y rangos por unidades; especial: también módulos)' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        nombre: { type: 'string' },
        descripcion: { type: 'string' },
        precioMensual: { type: 'number' },
        descuentoAnual: { type: 'number' },
        rangos: {
          type: 'array',
          items: { type: 'object', properties: { hasta: { type: 'number' }, precioMensual: { type: 'number' } } },
          example: [{ hasta: 50, precioMensual: 99000 }, { hasta: 150, precioMensual: 130000 }, { hasta: 300, precioMensual: 180000 }],
        },
        modulos: { type: 'array', items: { type: 'string' } },
      },
    },
  })
  @Put(':id')
  async update(@Param('id') id: string, @Body() body: any, @Req() req: any) {
    this.assertSuperAdmin(req);
    return this.plans.update(id, body);
  }

  @ApiOperation({ summary: 'Asignar un plan a un conjunto' })
  @ApiBody({ schema: { type: 'object', properties: { conjunto: { type: 'string' }, planId: { type: 'string' } }, required: ['conjunto', 'planId'] } })
  @Post('assign')
  async assign(@Body() body: { conjunto: string; planId: string }, @Req() req: any) {
    this.assertSuperAdmin(req);
    return this.plans.assign(body?.conjunto || '', body?.planId || '');
  }

  @ApiOperation({ summary: 'Eliminar un plan (los base no se pueden eliminar)' })
  @Delete(':id')
  async remove(@Param('id') id: string, @Req() req: any) {
    this.assertSuperAdmin(req);
    return this.plans.remove(id);
  }
}
