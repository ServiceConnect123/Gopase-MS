import { Body, Controller, Delete, ForbiddenException, Get, Param, Post, Put, Query, Req } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { FirebaseService } from '../firebase/firebase.service';
import { assertConjuntoPermitido } from '../auth/wsp-access.guard';
import { TenantInput, TenantsService } from './tenants.service';

/**
 * Inquilinos (rol "inquilino") de una unidad.
 *
 * Quién los gestiona:
 *   - el PROPIETARIO: solo los suyos (el propietario sale del token).
 *   - el ADMIN del conjunto / superAdmin: los de cualquier propietario de su
 *     conjunto, indicando ?propietario= (o "propietario" en el body).
 * Si el guard JWT está apagado (sin req.user) se exige el propietario explícito,
 * igual que el resto de endpoints durante el rollout.
 */
@ApiTags('tenants')
@Controller('tenants')
export class TenantsController {
  constructor(
    private readonly tenants: TenantsService,
    private readonly firebase: FirebaseService,
  ) {}

  /** Propietario sobre el que actúa la petición, validando permisos. */
  private async propietarioDe(req: any, explicito?: string): Promise<string> {
    const user = req?.user;
    const pedido = String(explicito || '').trim();
    if (!user) {
      if (!pedido) throw new ForbiddenException('Indica el propietario.');
      return pedido;
    }
    const rol = String(user.rol || '').toLowerCase();
    if (rol === 'propietario') return String(user.sub || '');
    if (rol === 'admin' || rol === 'superadmin') {
      if (!pedido) throw new ForbiddenException('Indica el propietario.');
      const usuarios = (await this.firebase.liveVal<Record<string, any>>('mirror/usuarios')) || {};
      const owner = usuarios[pedido.replace(/[.#$/\[\]]/g, '_')];
      await assertConjuntoPermitido(req, this.firebase, String(owner?.conjunto || ''));
      return pedido;
    }
    throw new ForbiddenException('Solo el propietario de la unidad puede gestionar sus inquilinos.');
  }

  @ApiOperation({ summary: 'Arriendo de quien inició sesión (solo inquilinos)' })
  @Get('me')
  async me(@Req() req: any, @Query('usuario') usuario?: string) {
    const quien = String(req?.user?.sub || usuario || '');
    const data = quien ? await this.tenants.miArriendo(quien) : null;
    return { success: !!data, data };
  }

  @ApiOperation({ summary: 'Inquilinos de un propietario' })
  @ApiQuery({ name: 'propietario', required: false, description: 'Solo admin/superAdmin; el propietario usa su token' })
  @Get()
  async listar(@Req() req: any, @Query('propietario') propietario?: string) {
    const p = await this.propietarioDe(req, propietario);
    return { success: true, data: await this.tenants.listar(p) };
  }

  @ApiOperation({ summary: 'Registrar un inquilino (crea su cuenta y le envía el acceso por WhatsApp)' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        propietario: { type: 'string', description: 'Solo admin/superAdmin' },
        nombre: { type: 'string' },
        documentType: { type: 'string' },
        documentNumber: { type: 'string' },
        phone: { type: 'string' },
        email: { type: 'string' },
        placa1: { type: 'string' },
        placa2: { type: 'string' },
        inicio: { type: 'string', example: '2026-12-01' },
        fin: { type: 'string', example: '2027-11-30', description: 'Vacío = sin fecha de fin' },
        pagaAdministracion: { type: 'boolean' },
        puedeReservar: { type: 'boolean' },
        enviarAcceso: { type: 'boolean', default: true },
      },
      required: ['nombre', 'phone', 'inicio'],
    },
  })
  @Post()
  async crear(@Req() req: any, @Body() body: TenantInput & { propietario?: string }) {
    const p = await this.propietarioDe(req, body?.propietario);
    return this.tenants.crear(p, body || {});
  }

  @ApiOperation({ summary: 'Editar datos, fechas o permisos de un inquilino' })
  @Put(':usuario')
  async actualizar(@Req() req: any, @Param('usuario') usuario: string, @Body() body: TenantInput & { propietario?: string }) {
    const p = await this.propietarioDe(req, body?.propietario);
    return this.tenants.actualizar(p, usuario, body || {});
  }

  @ApiOperation({ summary: 'Retirar el acceso de un inquilino' })
  @Post(':usuario/revocar')
  async revocar(@Req() req: any, @Param('usuario') usuario: string, @Body() body: { propietario?: string }) {
    const p = await this.propietarioDe(req, body?.propietario);
    return this.tenants.setRevocado(p, usuario, true);
  }

  @ApiOperation({ summary: 'Devolver el acceso a un inquilino' })
  @Post(':usuario/reactivar')
  async reactivar(@Req() req: any, @Param('usuario') usuario: string, @Body() body: { propietario?: string }) {
    const p = await this.propietarioDe(req, body?.propietario);
    return this.tenants.setRevocado(p, usuario, false);
  }

  @ApiOperation({ summary: 'Reenviar usuario y contraseña temporal por WhatsApp' })
  @Post(':usuario/enviar-acceso')
  async enviarAcceso(@Req() req: any, @Param('usuario') usuario: string, @Body() body: { propietario?: string }) {
    const p = await this.propietarioDe(req, body?.propietario);
    return this.tenants.enviarAcceso(p, usuario);
  }

  @ApiOperation({ summary: 'Eliminar un inquilino (borra su cuenta)' })
  @Delete(':usuario')
  async eliminar(@Req() req: any, @Param('usuario') usuario: string, @Query('propietario') propietario?: string) {
    const p = await this.propietarioDe(req, propietario);
    return this.tenants.eliminar(p, usuario);
  }
}
