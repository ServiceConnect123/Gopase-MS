import { Controller, Get, Header, Post } from '@nestjs/common';
import { WhatsappService } from './whatsapp.service';

@Controller('whatsapp')
export class WhatsappController {
  constructor(private readonly whatsapp: WhatsappService) {}

  /** Estado de la conexión de WhatsApp. */
  @Get('status')
  status() {
    return {
      ready: this.whatsapp.isReady(),
      timestamp: new Date().toISOString(),
    };
  }

  /** Devuelve el QR actual en JSON (string crudo + PNG en base64). */
  @Get('qr')
  async qr() {
    const data = await this.whatsapp.getQr();
    if (!data) {
      return {
        ready: this.whatsapp.isReady(),
        message: this.whatsapp.isReady()
          ? 'WhatsApp ya está conectado. No hay QR pendiente.'
          : 'No hay QR disponible todavía. Espera unos segundos o usa /whatsapp/relogin.',
      };
    }
    return data;
  }

  /** Página HTML sencilla para escanear el QR desde el navegador. */
  @Get('qr/view')
  @Header('Content-Type', 'text/html; charset=utf-8')
  async qrView() {
    const data = await this.whatsapp.getQr();
    if (this.whatsapp.isReady()) {
      return `<html><body style="font-family:sans-serif;text-align:center;padding:40px">
        <h2>✅ WhatsApp conectado</h2>
        <p>No hay QR pendiente.</p>
      </body></html>`;
    }
    if (!data) {
      return `<html><head><meta http-equiv="refresh" content="3"></head>
        <body style="font-family:sans-serif;text-align:center;padding:40px">
        <h2>Generando QR...</h2>
        <p>Esta página se recarga sola. Si no aparece, usa POST /whatsapp/relogin.</p>
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
   * Cierra la sesión actual, limpia las credenciales y genera un QR nuevo
   * para vincular OTRO número de WhatsApp. Luego abre /whatsapp/qr/view.
   */
  @Post('relogin')
  async relogin() {
    await this.whatsapp.relogin();
    return {
      ok: true,
      message:
        'Sesión reiniciada. Abre GET /whatsapp/qr/view para escanear el nuevo QR.',
    };
  }
}
