import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, Param, Post, Put, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { FirebaseService } from '../firebase/firebase.service';
import { conjuntoPropioDelRequest } from '../auth/conjunto-scope';
import { CuotaService } from './cuota.service';

/**
 * Cuota de administración: tarifas (base + diferenciales), asignación por
 * unidad y métodos de recaudo. Solo la administración: el admin, sobre su
 * conjunto; el superAdmin, sobre el que indique.
 */
@ApiTags('cuota')
@Controller('cuota')
export class CuotaController {
  constructor(
    private readonly cuota: CuotaService,
    private readonly firebase: FirebaseService,
  ) {}

  private async conjuntoAdmin(req: any, pedido?: string): Promise<string> {
    if (req?.user) {
      const rol = String(req.user.rol || '').toLowerCase();
      if (rol !== 'admin' && rol !== 'superadmin') throw new ForbiddenException('Solo la administración configura la cuota.');
      if (rol === 'admin') {
        const propio = String((await conjuntoPropioDelRequest(req, this.firebase)) || '');
        if (!propio) throw new ForbiddenException('Tu usuario no tiene conjunto.');
        return propio;
      }
    }
    const c = String(pedido || '').trim();
    if (!c) throw new BadRequestException('Indica el conjunto.');
    return c;
  }

  @ApiOperation({ summary: 'Tarifas (con unidades por tarifa), recaudo esperado y métodos de recaudo del conjunto' })
  @Get('config')
  async config(@Req() req: any, @Query('conjunto') conjunto?: string) {
    return this.cuota.getConfig(await this.conjuntoAdmin(req, conjunto));
  }

  @ApiOperation({ summary: 'Valor de la tarifa base (la cuota del conjunto)' })
  @Put('base')
  async base(@Req() req: any, @Body() body: any) {
    return this.cuota.setBase(await this.conjuntoAdmin(req, body?.conjunto), body?.valor);
  }

  @ApiOperation({ summary: 'Crear tarifa diferencial' })
  @Post('tarifas')
  async crearTarifa(@Req() req: any, @Body() body: any) {
    return this.cuota.guardarTarifa(await this.conjuntoAdmin(req, body?.conjunto), body);
  }

  @ApiOperation({ summary: 'Editar tarifa (nombre, valor, descripción, activo). Al desactivarla sus unidades pasan a la base.' })
  @Put('tarifas/:id')
  async editarTarifa(@Req() req: any, @Param('id') id: string, @Body() body: any) {
    return this.cuota.guardarTarifa(await this.conjuntoAdmin(req, body?.conjunto), body, id);
  }

  @ApiOperation({ summary: 'Asignar la tarifa de una unidad/propietario (tarifaId vacío = tarifa base)' })
  @Put('asignar')
  async asignar(@Req() req: any, @Body() body: any) {
    const usuario = String(body?.usuario || '').trim();
    if (!usuario) throw new BadRequestException('Indica el usuario.');
    return this.cuota.asignar(await this.conjuntoAdmin(req, body?.conjunto), usuario, body?.tarifaId);
  }

  @ApiOperation({ summary: 'Agregar método de recaudo (Bre-B o cuenta bancaria)' })
  @Post('metodos')
  async crearMetodo(@Req() req: any, @Body() body: any) {
    return this.cuota.guardarMetodo(await this.conjuntoAdmin(req, body?.conjunto), body);
  }

  @ApiOperation({ summary: 'Editar datos de un método de recaudo' })
  @Put('metodos/:id')
  async editarMetodo(@Req() req: any, @Param('id') id: string, @Body() body: any) {
    return this.cuota.guardarMetodo(await this.conjuntoAdmin(req, body?.conjunto), body, id);
  }

  @ApiOperation({ summary: 'Activar/desactivar o marcar como principal' })
  @Put('metodos/:id/estado')
  async estadoMetodo(@Req() req: any, @Param('id') id: string, @Body() body: any) {
    const patch: { activo?: boolean; principal?: boolean } = {};
    if (typeof body?.activo === 'boolean') patch.activo = body.activo;
    if (body?.principal === true) patch.principal = true;
    return this.cuota.cambiarMetodo(await this.conjuntoAdmin(req, body?.conjunto), id, patch);
  }

  @ApiOperation({ summary: 'Eliminar método de recaudo' })
  @Delete('metodos/:id')
  async eliminarMetodo(@Req() req: any, @Param('id') id: string, @Query('conjunto') conjunto?: string) {
    return this.cuota.eliminarMetodo(await this.conjuntoAdmin(req, conjunto), id);
  }
}
