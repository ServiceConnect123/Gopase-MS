import { Body, Controller, Delete, ForbiddenException, Get, Param, Post, Put, Query, Req } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { AnunciosService } from './anuncios.service';

/**
 * Anuncios de GoPase: el superAdmin los crea y mide; cada usuario ve cada uno
 * una sola vez en un modal al entrar.
 *
 * Identidad: con el guard JWT activo se usa req.user (sub = usuario). Con el
 * guard apagado (rollout) se acepta `usuario` en query/body, como el resto de
 * endpoints durante la transición.
 */
@ApiTags('anuncios')
@Controller('anuncios')
export class AnunciosController {
  constructor(private readonly anuncios: AnunciosService) {}

  private assertSuperAdmin(req: any): void {
    const user = req?.user;
    if (user && String(user.rol || '').toLowerCase() !== 'superadmin') {
      throw new ForbiddenException('Solo el administrador general gestiona los anuncios.');
    }
  }

  /** Usuario del request: el del token si existe; si no, el que envía el cliente. */
  private usuarioDe(req: any, fallback?: string): string {
    return String(req?.user?.sub || fallback || '').trim();
  }

  @ApiOperation({ summary: 'Anuncio que el usuario aún no ha visto (o null)' })
  @ApiQuery({ name: 'usuario', required: false, description: 'Solo si el guard JWT está apagado' })
  @ApiQuery({ name: 'rol', required: false })
  @ApiQuery({ name: 'conjunto', required: false })
  @Get('pendiente')
  async pendiente(@Req() req: any, @Query('usuario') usuario?: string, @Query('rol') rol?: string, @Query('conjunto') conjunto?: string) {
    const u = this.usuarioDe(req, usuario);
    if (!u) return { success: true, data: null };
    const data = await this.anuncios.pendiente(u, String(req?.user?.rol || rol || ''), String(conjunto || ''));
    return { success: true, data };
  }

  @ApiOperation({ summary: 'Registrar que el usuario vio el anuncio (y si tocó el botón)' })
  @ApiBody({ schema: { type: 'object', properties: { clic: { type: 'boolean' }, usuario: { type: 'string' }, rol: { type: 'string' }, conjunto: { type: 'string' }, nombre: { type: 'string' } } } })
  @Post(':id/vista')
  async vista(@Req() req: any, @Param('id') id: string, @Body() body: any) {
    const u = this.usuarioDe(req, body?.usuario);
    if (!u) return { success: false, message: 'Usuario requerido.' };
    return this.anuncios.registrarVista(id, u, body?.clic === true, {
      rol: String(req?.user?.rol || body?.rol || ''),
      conjunto: String(body?.conjunto || ''),
      nombre: String(body?.nombre || ''),
    });
  }

  // ------------------------------------------------------------ superAdmin

  @ApiOperation({ summary: 'Lista de anuncios con métricas (superAdmin)' })
  @Get()
  async list(@Req() req: any) {
    this.assertSuperAdmin(req);
    const data = await this.anuncios.list();
    return { success: true, data };
  }

  @ApiOperation({ summary: 'Detalle de un anuncio: métricas y quién lo vio (superAdmin)' })
  @Get(':id')
  async detalle(@Req() req: any, @Param('id') id: string) {
    this.assertSuperAdmin(req);
    return this.anuncios.detalle(id);
  }

  @ApiOperation({ summary: 'Crear anuncio (superAdmin)' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        titulo: { type: 'string' },
        mensaje: { type: 'string' },
        imagenUrl: { type: 'string' },
        ctaTexto: { type: 'string', example: 'Seguir en TikTok' },
        ctaUrl: { type: 'string', example: 'https://www.tiktok.com/@somosgopase' },
        activo: { type: 'boolean' },
        roles: { type: 'array', items: { type: 'string', enum: ['admin', 'propietario', 'inquilino', 'vigilante'] }, description: 'vacío = todos' },
        conjuntos: { type: 'array', items: { type: 'string' }, description: 'vacío = todos' },
        desde: { type: 'string', example: '2026-12-01' },
        hasta: { type: 'string', example: '2026-12-31' },
        prioridad: { type: 'number' },
      },
      required: ['titulo'],
    },
  })
  @Post()
  async create(@Req() req: any, @Body() body: any) {
    this.assertSuperAdmin(req);
    return this.anuncios.create(body, this.usuarioDe(req, body?.autor));
  }

  @ApiOperation({ summary: 'Editar anuncio (superAdmin)' })
  @Put(':id')
  async update(@Req() req: any, @Param('id') id: string, @Body() body: any) {
    this.assertSuperAdmin(req);
    return this.anuncios.update(id, body);
  }

  @ApiOperation({ summary: 'Eliminar anuncio y sus vistas (superAdmin)' })
  @Delete(':id')
  async remove(@Req() req: any, @Param('id') id: string) {
    this.assertSuperAdmin(req);
    return this.anuncios.remove(id);
  }
}
