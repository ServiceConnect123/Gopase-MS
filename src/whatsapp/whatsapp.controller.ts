import { Controller, Get, Header, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { WhatsappService } from './whatsapp.service';
import { Public } from '../auth/public.decorator';
import { FirebaseService } from '../firebase/firebase.service';
import { assertConjuntoPermitido, WspAccessGuard } from '../auth/wsp-access.guard';

@ApiTags('whatsapp')
@Controller('whatsapp')
// Solo `status` es público. QR, código de vinculación, relogin y unlink exigen
// JWT de admin del conjunto (o superAdmin): antes cualquiera podía desvincular
// el WhatsApp de un conjunto y vincular SU número en su lugar. Sin conjunto =
// sesión global de goPase => solo superAdmin.
@UseGuards(WspAccessGuard)
export class WhatsappController {
  constructor(
    private readonly whatsapp: WhatsappService,
    private readonly firebase: FirebaseService,
  ) {}

  /**
   * Estado de la conexión de WhatsApp para un conjunto.
   * Si no se pasa `conjunto`, consulta la sesión por defecto (número global).
   */
  @ApiOperation({ summary: 'Estado de la conexión de WhatsApp (por conjunto)' })
  @ApiQuery({ name: 'conjunto', required: false })
  @Public()
  @Get('status')
  status(@Query('conjunto') conjunto?: string) {
    return {
      ready: this.whatsapp.isReady(conjunto),
      conjunto: conjunto || null,
      timestamp: new Date().toISOString(),
    };
  }

  /** Devuelve el QR actual en JSON (string crudo + PNG en base64) por conjunto. */
  @ApiOperation({ summary: 'QR actual en JSON (string + PNG base64) por conjunto' })
  @ApiQuery({ name: 'conjunto', required: false })
  @Get('qr')
  async qr(@Req() req: any, @Query('conjunto') conjunto?: string) {
    await assertConjuntoPermitido(req, this.firebase, conjunto);
    let data: Awaited<ReturnType<typeof this.whatsapp.getQr>> = null;
    try {
      data = await this.whatsapp.getQr(conjunto);
    } catch (e: any) {
      // Errores de descifrado WebSocket durante reconexión (Unsupported state,
      // Connection Closed). No son accionables: el socket se recupera solo.
      return {
        ready: false,
        conjunto: conjunto || null,
        message: 'Reconectando WhatsApp... Vuelve a consultar en unos segundos.',
      };
    }
    if (!data) {
      const ready = this.whatsapp.isReady(conjunto);
      return {
        ready,
        conjunto: conjunto || null,
        message: ready
          ? 'WhatsApp ya está conectado. No hay QR pendiente.'
          : 'No hay QR disponible todavía. Espera unos segundos y vuelve a consultar.',
      };
    }
    return data;
  }

  /**
   * Devuelve un CÓDIGO de emparejamiento (8 caracteres) para vincular por
   * número de teléfono, sin escanear QR. Útil cuando el admin abre la app en el
   * mismo teléfono donde tiene WhatsApp.
   *
   * El admin lo ingresa en: WhatsApp > Dispositivos vinculados > Vincular con
   * número de teléfono.
   */
  @ApiOperation({
    summary: 'Código de emparejamiento por número (alternativa al QR)',
    description:
      'Genera un código de 8 caracteres para vincular WhatsApp sin QR. Requiere el número en formato internacional.',
  })
  @ApiQuery({ name: 'conjunto', required: false })
  @ApiQuery({ name: 'phone', required: true, description: 'Número en formato internacional (ej: 573001112233)' })
  @Get('pairing-code')
  async pairingCode(
    @Req() req: any,
    @Query('phone') phone: string,
    @Query('conjunto') conjunto?: string,
  ) {
    await assertConjuntoPermitido(req, this.firebase, conjunto);
    if (!phone) {
      return {
        ready: false,
        code: null,
        conjunto: conjunto || null,
        message: 'Falta el parámetro "phone" (número en formato internacional).',
      };
    }
    const data = await this.whatsapp.getPairingCode(conjunto, phone);
    return { ...data, conjunto: conjunto || null };
  }

  /** Página HTML sencilla para escanear el QR desde el navegador. */
  @ApiOperation({ summary: 'Página HTML para escanear el QR (por conjunto)' })
  @ApiQuery({ name: 'conjunto', required: false })
  @Get('qr/view')
  @Header('Content-Type', 'text/html; charset=utf-8')
  async qrView(@Req() req: any, @Query('conjunto') conjunto?: string) {
    await assertConjuntoPermitido(req, this.firebase, conjunto);
    const data = await this.whatsapp.getQr(conjunto);
    if (this.whatsapp.isReady(conjunto)) {
      return `<html><body style="font-family:sans-serif;text-align:center;padding:40px">
        <h2>✅ WhatsApp conectado</h2>
        <p>No hay QR pendiente.</p>
      </body></html>`;
    }
    if (!data) {
      return `<html><head><meta http-equiv="refresh" content="3"></head>
        <body style="font-family:sans-serif;text-align:center;padding:40px">
        <h2>Generando QR...</h2>
        <p>Esta página se recarga sola.</p>
      </body></html>`;
    }
    return `<html><head><meta http-equiv="refresh" content="20"></head>
      <body style="font-family:sans-serif;text-align:center;padding:40px">
      <h2>Escanea este QR con WhatsApp</h2>
      <p>WhatsApp &gt; Dispositivos vinculados &gt; Vincular un dispositivo</p>
      <img src="${data.pngDataUrl}" alt="QR" style="width:300px;height:300px"/>
      <p style="color:#888">La página se recarga cada 20s para refrescar el QR.</p>
    </body></html>`;
  }

  /**
   * Cierra la sesión del conjunto, limpia las credenciales y genera un QR nuevo
   * para vincular OTRO número de WhatsApp.
   */
  @ApiOperation({
    summary: 'Reinicia la sesión y genera un QR nuevo (por conjunto)',
    description:
      'Cierra la sesión del conjunto, limpia credenciales y genera un QR para vincular otro número.',
  })
  @ApiQuery({ name: 'conjunto', required: false })
  @Post('relogin')
  async relogin(@Req() req: any, @Query('conjunto') conjunto?: string) {
    await assertConjuntoPermitido(req, this.firebase, conjunto);
    try {
      await this.whatsapp.relogin(conjunto);
    } catch (e: any) {
      // Baileys lanza Connection Closed / Timed Out al cerrar el socket durante
      // el relogin. Son esperados y no impiden que el QR nuevo se genere.
      // Los silenciamos para no contaminar Sentry con errores no accionables.
    }
    return {
      ok: true,
      conjunto: conjunto || null,
      message:
        'Sesión reiniciada. Consulta GET /whatsapp/qr para escanear el nuevo QR.',
    };
  }

  /**
   * Desvincula el WhatsApp del conjunto: cierra la sesión, borra el registro de
   * vinculación y la deja apagada (sin generar un QR nuevo).
   */
  @ApiOperation({
    summary: 'Desvincula el WhatsApp del conjunto (apaga la sesión)',
    description:
      'Cierra la sesión del conjunto, borra sus credenciales y la deja apagada. No genera QR nuevo.',
  })
  @ApiQuery({ name: 'conjunto', required: false })
  @Post('unlink')
  async unlink(@Req() req: any, @Query('conjunto') conjunto?: string) {
    await assertConjuntoPermitido(req, this.firebase, conjunto);
    await this.whatsapp.unlink(conjunto);
    return {
      ok: true,
      conjunto: conjunto || null,
      message: 'WhatsApp desvinculado del conjunto.',
    };
  }
}
