import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, Put, Query, Req } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { FirebaseService } from '../firebase/firebase.service';
import { conjuntoPropioDelRequest } from '../auth/conjunto-scope';
import { PagosWspService } from './pagos-wsp.service';

const rolDe = (req: any) => String(req?.user?.rol || '').toLowerCase();

/**
 * Pagos por WhatsApp.
 *   - Configuración e historial: el admin de SU conjunto; el superAdmin indica `conjunto`.
 *   - Estado (¿está activo?): cualquier usuario con sesión, de su conjunto (para la
 *     tarjeta "Paga por WhatsApp" con la plantilla del residente).
 */
@ApiTags('pagos-whatsapp')
@Controller('pagos-whatsapp')
export class PagosWspController {
  constructor(
    private readonly pagosWsp: PagosWspService,
    private readonly firebase: FirebaseService,
  ) {}

  private async conjuntoAdmin(req: any, pedido?: string): Promise<string> {
    if (req?.user) {
      const rol = rolDe(req);
      if (rol !== 'admin' && rol !== 'superadmin') throw new ForbiddenException('Solo la administración configura los pagos por WhatsApp.');
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

  @ApiOperation({ summary: 'Configuración de pagos por WhatsApp del conjunto' })
  @Get('config')
  async config(@Req() req: any, @Query('conjunto') conjunto?: string) {
    const c = await this.conjuntoAdmin(req, conjunto);
    return { success: true, conjunto: c, config: await this.pagosWsp.getConfig(c) };
  }

  @ApiOperation({ summary: 'Guardar configuración (si cambia el enlace del grupo, el número vinculado se une)' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        grupo: { type: 'boolean' },
        chat: { type: 'boolean' },
        grupoEnlace: { type: 'string', description: 'https://chat.whatsapp.com/…' },
        fondo: { type: 'string' },
        conjunto: { type: 'string', description: 'Solo superAdmin' },
      },
    },
  })
  @Put('config')
  async guardar(@Req() req: any, @Body() body: any) {
    const c = await this.conjuntoAdmin(req, body?.conjunto);
    return this.pagosWsp.guardarConfig(
      c,
      {
        grupo: typeof body?.grupo === 'boolean' ? body.grupo : undefined,
        chat: typeof body?.chat === 'boolean' ? body.chat : undefined,
        grupoEnlace: typeof body?.grupoEnlace === 'string' ? body.grupoEnlace : undefined,
        fondo: typeof body?.fondo === 'string' ? body.fondo : undefined,
      },
      String(req?.user?.sub || 'admin'),
    );
  }

  @ApiOperation({ summary: 'Últimos mensajes #pago procesados (registrados, rechazados, duplicados)' })
  @Get('historial')
  async historial(@Req() req: any, @Query('conjunto') conjunto?: string) {
    const c = await this.conjuntoAdmin(req, conjunto);
    const [data, alerta] = await Promise.all([this.pagosWsp.historial(c), this.pagosWsp.alerta(c)]);
    return { success: true, data, alerta };
  }

  @ApiOperation({ summary: 'Marcar como visto el aviso de mensajes sin leer' })
  @Delete('alerta')
  async borrarAlerta(@Req() req: any, @Query('conjunto') conjunto?: string) {
    const c = await this.conjuntoAdmin(req, conjunto);
    await this.pagosWsp.borrarAlerta(c);
    return { success: true };
  }

  @ApiOperation({ summary: '¿El conjunto recibe pagos por WhatsApp? (para la tarjeta del residente)' })
  @Get('estado')
  async estado(@Req() req: any, @Query('conjunto') conjunto?: string) {
    let c = String(conjunto || '').trim();
    if (req?.user && rolDe(req) !== 'superadmin') c = String((await conjuntoPropioDelRequest(req, this.firebase)) || '');
    if (!c) return { success: true, grupo: false, chat: false, grupoNombre: '' };
    const cfg = await this.pagosWsp.getConfig(c);
    return { success: true, grupo: !!(cfg.grupo && cfg.grupoJid), chat: !!cfg.chat, grupoNombre: cfg.grupo ? cfg.grupoNombre : '' };
  }
}
