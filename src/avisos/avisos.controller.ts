import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, NotFoundException, Param, Post, Put, Query, Req } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { FirebaseService } from '../firebase/firebase.service';
import { assertConjuntoPermitido } from '../auth/wsp-access.guard';
import { conjuntoPropioDelRequest } from '../auth/conjunto-scope';
import { AvisosService } from './avisos.service';

const rolDe = (req: any) => String(req?.user?.rol || '').toLowerCase();

/**
 * Avisos con la marca del conjunto. Solo administración: el admin trabaja sobre
 * SU conjunto; el superAdmin indica `conjunto`. Si el guard JWT está apagado (sin
 * req.user) se usa el conjunto que venga, como en el resto del rollout.
 */
@ApiTags('avisos')
@Controller('avisos')
export class AvisosController {
  constructor(
    private readonly avisos: AvisosService,
    private readonly firebase: FirebaseService,
  ) {}

  /** Conjunto sobre el que se trabaja, o error si el rol no puede. */
  private async conjuntoDe(req: any, pedido?: string): Promise<string> {
    if (req?.user) {
      const rol = rolDe(req);
      if (rol !== 'admin' && rol !== 'superadmin') throw new ForbiddenException('Solo la administración crea avisos.');
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

  private autor(req: any, body?: any) {
    return {
      usuario: String(req?.user?.sub || body?.autor || ''),
      nombre: String(req?.user?.nombre || body?.autorNombre || req?.user?.sub || ''),
    };
  }

  /** El aviso existe y es del conjunto del usuario. */
  private async avisoPermitido(req: any, id: string): Promise<any> {
    const aviso = await this.avisos.getById(id);
    if (!aviso) throw new NotFoundException('El aviso no existe.');
    if (req?.user) {
      const rol = rolDe(req);
      if (rol !== 'admin' && rol !== 'superadmin') throw new ForbiddenException('Solo la administración gestiona avisos.');
      await assertConjuntoPermitido(req, this.firebase, aviso.conjunto);
    }
    return aviso;
  }

  @ApiOperation({ summary: 'Plantillas de aviso disponibles (campos de cada una)' })
  @Get('plantillas')
  plantillas() {
    return { success: true, data: this.avisos.plantillas() };
  }

  @ApiOperation({ summary: 'Marca del conjunto: logos, administradora y colores' })
  @ApiQuery({ name: 'conjunto', required: false, description: 'Solo superAdmin' })
  @Get('marca')
  async marca(@Req() req: any, @Query('conjunto') conjunto?: string) {
    const data = await this.avisos.marca(await this.conjuntoDe(req, conjunto));
    if (!data) throw new NotFoundException('El conjunto no existe.');
    return { success: true, data };
  }

  @ApiOperation({ summary: 'Guardar la marca del conjunto (logos en base64; "" quita el logo)' })
  @Put('marca')
  async guardarMarca(@Req() req: any, @Body() body: any) {
    return this.avisos.guardarMarca(await this.conjuntoDe(req, body?.conjunto), body || {});
  }

  @ApiOperation({ summary: 'Vista previa del aviso como imagen PNG (data URL)' })
  @ApiBody({ schema: { type: 'object', properties: { plantilla: { type: 'string' }, campos: { type: 'object' }, formato: { type: 'string' }, diseno: { type: 'string' }, color: { type: 'string' } } } })
  @Post('vista-previa')
  async vistaPrevia(@Req() req: any, @Body() body: any) {
    return this.avisos.vistaPrevia(await this.conjuntoDe(req, body?.conjunto), body || {});
  }

  @ApiOperation({ summary: 'Avisos del conjunto (borradores y publicados)' })
  @ApiQuery({ name: 'conjunto', required: false, description: 'Solo superAdmin' })
  @Get()
  async list(@Req() req: any, @Query('conjunto') conjunto?: string) {
    const data = await this.avisos.list(await this.conjuntoDe(req, conjunto));
    return { success: true, data };
  }

  @ApiOperation({ summary: 'Crear borrador de aviso' })
  @Post()
  async crear(@Req() req: any, @Body() body: any) {
    return this.avisos.guardar(await this.conjuntoDe(req, body?.conjunto), body || {}, this.autor(req, body));
  }

  @ApiOperation({ summary: 'Editar aviso' })
  @Put(':id')
  async editar(@Req() req: any, @Param('id') id: string, @Body() body: any) {
    const aviso = await this.avisoPermitido(req, id);
    return this.avisos.guardar(aviso.conjunto, body || {}, this.autor(req, body), id);
  }

  @ApiOperation({ summary: 'Publicar el aviso en Noticias (imagen en Drive)' })
  @Post(':id/publicar')
  async publicar(@Req() req: any, @Param('id') id: string, @Body() body: any) {
    await this.avisoPermitido(req, id);
    return this.avisos.publicar(id, this.autor(req, body));
  }

  @ApiOperation({ summary: 'Eliminar aviso (la noticia publicada se borra desde Noticias)' })
  @Delete(':id')
  async eliminar(@Req() req: any, @Param('id') id: string) {
    await this.avisoPermitido(req, id);
    return this.avisos.remove(id);
  }
}
