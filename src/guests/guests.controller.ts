import { Body, Controller, Delete, ForbiddenException, Get, NotFoundException, Param, Post, Put, Query, Req } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { FirebaseService } from '../firebase/firebase.service';
import { Public } from '../auth/public.decorator';
import { assertConjuntoPermitido } from '../auth/wsp-access.guard';
import { conjuntoPropioDelRequest } from '../auth/conjunto-scope';
import { GuestsService } from './guests.service';

const rolDe = (req: any) => String(req?.user?.rol || '').toLowerCase();
const esResidente = (req: any) => ['propietario', 'inquilino'].includes(rolDe(req));
const esPorteria = (req: any) => ['vigilante', 'admin', 'superadmin'].includes(rolDe(req));

/**
 * Invitados (RTDB mirror/invitados) y su QR de acceso.
 *
 *   - Residente (propietario o arrendatario): ve, crea, comparte y anula SUS invitados.
 *   - Portería y administración: ven los de SU conjunto, validan el QR y registran la entrada.
 *   - Invitado: sin sesión, con su enlace firmado (GET /guests/acceso?c=&s=).
 * Si el guard JWT está apagado (sin req.user) no se restringe, como en el resto del rollout.
 */
@ApiTags('guests')
@Controller('guests')
export class GuestsController {
  constructor(
    private readonly guests: GuestsService,
    private readonly firebase: FirebaseService,
  ) {}

  /** El residente solo toca sus invitados; portería/admin, los de su conjunto. */
  private async invitadoPermitido(req: any, inv: any, quien: 'residente' | 'porteria' | 'ambos'): Promise<void> {
    if (!req?.user) return;
    if (esResidente(req) && quien !== 'porteria') {
      if (String(inv.propietario || '').toLowerCase() !== String(req.user.sub || '').toLowerCase()) {
        throw new ForbiddenException('Este invitado no es tuyo.');
      }
      return;
    }
    const permitido = quien === 'residente' ? ['admin', 'superadmin'].includes(rolDe(req)) : esPorteria(req);
    if (!permitido) throw new ForbiddenException('No tienes permiso para esta acción.');
    await assertConjuntoPermitido(req, this.firebase, await this.guests.conjuntoDelInvitado(inv));
  }

  @ApiOperation({ summary: 'Lista de invitados (residente: los suyos; portería/admin: los de su conjunto)' })
  @ApiQuery({ name: 'propietario', required: false })
  @ApiQuery({ name: 'conjunto', required: false, description: 'Solo superAdmin' })
  @Get()
  async list(@Req() req: any, @Query('propietario') propietario?: string, @Query('conjunto') conjunto?: string) {
    let filtros: { propietario?: string; conjunto?: string } = { propietario: propietario || '' };
    if (req?.user) {
      if (esResidente(req)) filtros = { propietario: String(req.user.sub || '') };
      else if (rolDe(req) === 'superadmin') filtros = { propietario: propietario || '', conjunto: conjunto || '' };
      else filtros = { propietario: propietario || '', conjunto: String((await conjuntoPropioDelRequest(req, this.firebase)) || '') };
    }
    const data = await this.guests.list(filtros);
    return { success: true, data };
  }

  @ApiOperation({ summary: 'Enlace público del invitado: su QR mientras sirve (sin sesión)' })
  @Public()
  @Get('acceso')
  async acceso(@Query('c') c: string, @Query('s') s: string) {
    return this.guests.acceso(c || '', s || '');
  }

  @ApiOperation({ summary: 'Portería: validar el QR (o el código) de un invitado' })
  @Get('validar/:codigo')
  async validar(@Req() req: any, @Param('codigo') codigo: string) {
    if (req?.user && !esPorteria(req)) throw new ForbiddenException('Solo la portería y la administración validan invitados.');
    const inv = await this.guests.porCodigo(codigo);
    if (!inv) return { success: false, motivo: 'no_existe', message: 'No hay ningún invitado con ese código.' };
    await this.invitadoPermitido(req, inv, 'porteria');
    return { success: true, data: await this.guests.paraPorteria(inv) };
  }

  @ApiOperation({ summary: 'Portería: registrar la entrada con el QR (lo deja usado)' })
  @Post('validar/:codigo/ingreso')
  async ingreso(@Req() req: any, @Param('codigo') codigo: string) {
    if (req?.user && !esPorteria(req)) throw new ForbiddenException('Solo la portería y la administración registran entradas.');
    const inv = await this.guests.porCodigo(codigo);
    if (!inv) throw new NotFoundException('No hay ningún invitado con ese código.');
    await this.invitadoPermitido(req, inv, 'porteria');
    return this.guests.registrarIngresoQr(inv, String(req?.user?.sub || 'porteria'));
  }

  @ApiOperation({ summary: 'Registrar invitado (con QR de acceso salvo generarQr=false)' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        nombre: { type: 'string' },
        placa: { type: 'string' },
        fecha: { type: 'string', example: '2026-11-21' },
        propietario: { type: 'string', description: 'username del anfitrión (lo toma del token si es residente)' },
        nota: { type: 'string' },
        generarQr: { type: 'boolean', default: true },
      },
      required: ['nombre', 'fecha'],
    },
  })
  @Post()
  async create(@Req() req: any, @Body() body: any) {
    const dto = { ...(body || {}) };
    if (req?.user && esResidente(req)) dto.propietario = String(req.user.sub || '');
    return this.guests.create(dto);
  }

  @ApiOperation({ summary: 'QR del invitado para compartir: imagen, código, enlace y mensaje de WhatsApp' })
  @Get(':id/qr')
  async qr(@Req() req: any, @Param('id') id: string) {
    const inv = await this.guests.getById(id);
    if (!inv) throw new NotFoundException('El invitado no existe.');
    await this.invitadoPermitido(req, inv, 'residente');
    return this.guests.compartir(id);
  }

  @ApiOperation({ summary: 'Anular el QR del invitado' })
  @Post(':id/anular-qr')
  async anular(@Req() req: any, @Param('id') id: string) {
    const inv = await this.guests.getById(id);
    if (!inv) throw new NotFoundException('El invitado no existe.');
    await this.invitadoPermitido(req, inv, 'residente');
    return this.guests.anularQr(id);
  }

  @ApiOperation({ summary: 'Actualizar invitado (p. ej. marcar ingreso: estado + hora)' })
  @Put(':id')
  async update(@Param('id') id: string, @Body() body: any) {
    return this.guests.update(id, body);
  }

  @ApiOperation({ summary: 'Eliminar invitado' })
  @Delete(':id')
  async remove(@Param('id') id: string) {
    return this.guests.remove(id);
  }
}
