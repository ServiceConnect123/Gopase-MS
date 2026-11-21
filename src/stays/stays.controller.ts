import { Body, Controller, ForbiddenException, Get, NotFoundException, Param, Post, Put, Query, Req } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { FirebaseService } from '../firebase/firebase.service';
import { Public } from '../auth/public.decorator';
import { assertConjuntoPermitido } from '../auth/wsp-access.guard';
import { conjuntoPropioDelRequest } from '../auth/conjunto-scope';
import { StaysService } from './stays.service';

const rolDe = (req: any) => String(req?.user?.rol || '').toLowerCase();
const esAdmin = (req: any) => ['admin', 'superadmin'].includes(rolDe(req));

/**
 * Estadías cortas (alquiler por días).
 *
 *   - Propietario: registra, ve, cancela y reenvía el acceso de SUS estadías.
 *   - Admin del conjunto: configura, aprueba/rechaza y ve todas las del conjunto.
 *   - Vigilante (y admin): ve las de hoy, busca por código y registra entrada/salida.
 *   - Huésped: sin sesión, con el enlace temporal (GET /stays/acceso?token=).
 *
 * Si el guard JWT está apagado (sin req.user) no se restringe por rol, igual que
 * el resto de endpoints durante el rollout; los del propietario exigen ?propietario=.
 */
@ApiTags('stays')
@Controller('stays')
export class StaysController {
  constructor(
    private readonly stays: StaysService,
    private readonly firebase: FirebaseService,
  ) {}

  /** Propietario sobre el que actúa (el del token; sin token, el explícito). */
  private propietarioDe(req: any, explicito?: string): string {
    if (!req?.user) {
      if (!explicito) throw new ForbiddenException('Indica el propietario.');
      return explicito;
    }
    if (rolDe(req) !== 'propietario') throw new ForbiddenException('Solo el propietario de la unidad registra estadías cortas.');
    return String(req.user.sub || '');
  }

  /** Estadía existente sobre la que puede actuar quien llama (propietario dueño o staff del conjunto). */
  private async estadiaPermitida(req: any, id: string, roles: Array<'propietario' | 'staff' | 'vigilante'>): Promise<any> {
    const e = await this.stays.getById(id);
    if (!e) throw new NotFoundException('La estadía no existe.');
    if (!req?.user) return e;
    const rol = rolDe(req);
    if (rol === 'propietario' && roles.includes('propietario')) {
      if (String(req.user.sub || '').toLowerCase() !== String(e.propietario || '').toLowerCase()) {
        throw new ForbiddenException('Esta estadía no es de tu unidad.');
      }
      return e;
    }
    const staff = (rol === 'admin' || rol === 'superadmin') && roles.includes('staff');
    const vig = (rol === 'vigilante' || rol === 'admin' || rol === 'superadmin') && roles.includes('vigilante');
    if (staff || vig) {
      await assertConjuntoPermitido(req, this.firebase, e.conjunto);
      return e;
    }
    throw new ForbiddenException('No tienes permiso para esta acción.');
  }

  private async conjuntoDe(req: any, conjunto?: string): Promise<string> {
    const pedido = String(conjunto || '').trim() || String((await conjuntoPropioDelRequest(req, this.firebase)) || '');
    if (req?.user) await assertConjuntoPermitido(req, this.firebase, pedido);
    return pedido;
  }

  // ----- Configuración -----

  @ApiOperation({ summary: 'Configuración de estadías cortas del conjunto' })
  @ApiQuery({ name: 'conjunto', required: false })
  @Get('config')
  async getConfig(@Req() req: any, @Query('conjunto') conjunto?: string) {
    const c = await this.conjuntoDe(req, conjunto);
    return { success: true, data: await this.stays.getConfig(c) };
  }

  @ApiOperation({ summary: 'Guardar la configuración de estadías cortas (admin)' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        conjunto: { type: 'string' },
        permitidas: { type: 'boolean' },
        requiereAprobacion: { type: 'boolean' },
        maxNoches: { type: 'number' },
        maxAcompanantes: { type: 'number' },
        reglas: { type: 'string' },
      },
    },
  })
  @Put('config')
  async setConfig(@Req() req: any, @Body() body: any) {
    if (req?.user && !esAdmin(req)) throw new ForbiddenException('Solo la administración configura las estadías cortas.');
    const c = await this.conjuntoDe(req, body?.conjunto);
    return this.stays.setConfig(c, body || {});
  }

  // ----- Propietario -----

  @ApiOperation({ summary: 'Estadías cortas del propietario' })
  @Get('mine')
  async mine(@Req() req: any, @Query('propietario') propietario?: string) {
    return { success: true, data: await this.stays.dePropietario(this.propietarioDe(req, propietario)) };
  }

  @ApiOperation({ summary: 'Registrar una estadía corta (huésped por días)' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        nombre: { type: 'string' },
        documentType: { type: 'string' },
        documentNumber: { type: 'string' },
        phone: { type: 'string' },
        placa: { type: 'string' },
        acompanantes: { type: 'number' },
        llegada: { type: 'string', example: '2026-12-20' },
        salida: { type: 'string', example: '2026-12-23' },
        nota: { type: 'string' },
      },
      required: ['nombre', 'phone', 'llegada', 'salida'],
    },
  })
  @Post()
  async crear(@Req() req: any, @Body() body: any) {
    return this.stays.crear(this.propietarioDe(req, body?.propietario), body || {});
  }

  @ApiOperation({ summary: 'Cancelar una estadía (propietario o admin)' })
  @Post(':id/cancelar')
  async cancelar(@Req() req: any, @Param('id') id: string) {
    await this.estadiaPermitida(req, id, ['propietario', 'staff']);
    return this.stays.cancelar(id);
  }

  @ApiOperation({ summary: 'Enviar de nuevo el acceso al huésped (genera un enlace nuevo)' })
  @Post(':id/reenviar')
  async reenviar(@Req() req: any, @Param('id') id: string) {
    await this.estadiaPermitida(req, id, ['propietario', 'staff']);
    return this.stays.reenviar(id);
  }

  // ----- Administración y portería -----

  @ApiOperation({ summary: 'Estadías del conjunto (pendientes, de hoy o todas)' })
  @ApiQuery({ name: 'vista', required: false, enum: ['pendientes', 'hoy', 'todas'] })
  @Get()
  async listar(@Req() req: any, @Query('conjunto') conjunto?: string, @Query('vista') vista?: string) {
    const rol = rolDe(req);
    if (req?.user && !['admin', 'superadmin', 'vigilante'].includes(rol)) {
      throw new ForbiddenException('Solo la administración y la portería ven las estadías del conjunto.');
    }
    const v = vista === 'pendientes' || vista === 'hoy' ? vista : 'todas';
    const c = rol === 'superadmin' && !conjunto ? '' : await this.conjuntoDe(req, conjunto);
    return { success: true, data: await this.stays.deConjunto(c, v) };
  }

  @ApiOperation({ summary: 'Buscar una estadía por el código del huésped (portería)' })
  @Get('codigo/:codigo')
  async porCodigo(@Req() req: any, @Param('codigo') codigo: string) {
    if (req?.user && !['admin', 'superadmin', 'vigilante'].includes(rolDe(req))) {
      throw new ForbiddenException('Solo la portería y la administración.');
    }
    const e = await this.stays.porCodigo(codigo);
    if (!e) return { success: false, message: 'No hay ninguna estadía con ese código.' };
    if (req?.user) await assertConjuntoPermitido(req, this.firebase, e.conjunto);
    return { success: true, data: e };
  }

  @ApiOperation({ summary: 'Aprobar una estadía (admin): envía el acceso al huésped' })
  @Post(':id/aprobar')
  async aprobar(@Req() req: any, @Param('id') id: string) {
    await this.estadiaPermitida(req, id, ['staff']);
    return this.stays.aprobar(id, String(req?.user?.sub || 'admin'));
  }

  @ApiOperation({ summary: 'Rechazar una estadía (admin) con un motivo' })
  @Post(':id/rechazar')
  async rechazar(@Req() req: any, @Param('id') id: string, @Body() body: { motivo?: string }) {
    await this.estadiaPermitida(req, id, ['staff']);
    return this.stays.rechazar(id, String(req?.user?.sub || 'admin'), body?.motivo || '');
  }

  @ApiOperation({ summary: 'Registrar la entrada del huésped (portería)' })
  @Post(':id/entrada')
  async entrada(@Req() req: any, @Param('id') id: string) {
    await this.estadiaPermitida(req, id, ['vigilante']);
    return this.stays.registrarEntrada(id, String(req?.user?.sub || 'porteria'));
  }

  @ApiOperation({ summary: 'Registrar la salida del huésped (portería): cierra su acceso' })
  @Post(':id/salida')
  async salida(@Req() req: any, @Param('id') id: string) {
    await this.estadiaPermitida(req, id, ['vigilante']);
    return this.stays.registrarSalida(id, String(req?.user?.sub || 'porteria'));
  }

  // ----- Huésped (público) -----

  @ApiOperation({ summary: 'Datos del enlace temporal del huésped (sin sesión)' })
  @Public()
  @Get('acceso')
  async acceso(@Query('token') token: string) {
    return this.stays.acceso(token || '');
  }
}
