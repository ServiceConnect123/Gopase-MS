import { Controller, Get, Header, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { WhatsappService } from './whatsapp.service';

@ApiTags('whatsapp')
@Controller('whatsapp')
export class WhatsappController {
  constructor(private readonly whatsapp: WhatsappService) {}

  /**
   * Estado de la conexión de WhatsApp para un conjunto.
   * Si no se pasa `conjunto`, consulta la sesión por defecto (número global).
   */
  @ApiOperation({ summary: 'Estado de la conexión de WhatsApp (por conjunto)' })
  @ApiQuery({ name: 'conjunto', required: false })
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
  async qr(@Query('conjunto') conjunto?: string) {
    const data = await this.whatsapp.getQr(conjunto);
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

  /** Página HTML sencilla para escanear el QR desde el navegador. */
  @ApiOperation({ summary: 'Página HTML para escanear el QR (por conjunto)' })
  @ApiQuery({ name: 'conjunto', required: false })
  @Get('qr/view')
  @Header('Content-Type', 'text/html; charset=utf-8')
  async qrView(@Query('conjunto') conjunto?: string) {
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
  async relogin(@Query('conjunto') conjunto?: string) {
    await this.whatsapp.relogin(conjunto);
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
  async unlink(@Query('conjunto') conjunto?: string) {
    await this.whatsapp.unlink(conjunto);
    return {
      ok: true,
      conjunto: conjunto || null,
      message: 'WhatsApp desvinculado del conjunto.',
    };
  }
}
