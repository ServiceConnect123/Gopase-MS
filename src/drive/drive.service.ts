import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Sube y elimina comprobantes en Google Drive REENVIANDO la operación al Google
 * Apps Script (mismo mecanismo que usaba el frontend). El Apps Script sube el
 * archivo con DriveApp como dueño del script, que SÍ tiene cuota de Drive (a
 * diferencia de una service account, que no tiene cuota propia).
 *
 * El frontend sigue hablando solo con el backend (/drive/upload, /drive/delete);
 * es el backend quien orquesta la llamada a Apps Script (server-side).
 *
 * Contrato hacia el frontend (igual que antes):
 *   - upload -> { success, fileUrl, directLink }
 *   - delete -> { success, message }
 *
 * Apps Script (action 'uploadImage') responde:
 *   { status:'success', fileId, fileUrl, directLink, folderId }
 * Apps Script (action 'deleteImage') responde:
 *   { status:'success', message, fileId }
 */
@Injectable()
export class DriveService {
  private readonly logger = new Logger(DriveService.name);
  private readonly scriptUrl: string;
  private readonly timeoutMs: number;

  constructor(private readonly config: ConfigService) {
    this.scriptUrl = this.config.get<string>('SCRIPT_URL', '');
    // Subir comprobantes puede tardar (imagen + cold start de Apps Script).
    this.timeoutMs = Number(this.config.get<string>('DRIVE_TIMEOUT_MS', '45000'));
    if (!this.scriptUrl) {
      this.logger.warn('SCRIPT_URL no configurada: la subida de comprobantes a Drive quedará deshabilitada.');
    }
  }

  /**
   * POST al Apps Script con timeout. Maneja el redirect 302 POST->GET de Google
   * Apps Script: si al seguir el redirect vuelve HTML (el body del POST se
   * pierde en la conversión a GET), reintenta con redirect manual y re-POST
   * directo a la URL de Location. Misma estrategia que el antiguo proxy Vercel.
   */
  private async postToScript<T = any>(body: Record<string, unknown>): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const payload = JSON.stringify(body);
    const headers = { 'Content-Type': 'text/plain;charset=utf-8' };
    try {
      // 1. POST inicial SIN seguir el redirect. Apps Script responde 302 a una
      //    URL de script.googleusercontent.com/macros/echo con el resultado.
      const res = await fetch(this.scriptUrl, {
        method: 'POST',
        redirect: 'manual',
        headers,
        body: payload,
        signal: controller.signal,
      });

      // Si no hubo redirect y ya trae JSON, úsalo.
      if (res.status >= 200 && res.status < 300) {
        const direct = this.tryParseJson(await res.text());
        if (direct !== null) return direct as T;
      }

      // 2. Seguir la Location con GET (sin body). Re-POSTear da 405 + HTML.
      const location = res.headers.get('location');
      if (!location) {
        throw new Error(`Apps Script no devolvió Location (status ${res.status}).`);
      }
      const finalRes = await fetch(location, {
        method: 'GET',
        redirect: 'follow',
        signal: controller.signal,
      });
      const finalText = await finalRes.text();
      const finalParsed = this.tryParseJson(finalText);
      if (finalParsed !== null) return finalParsed as T;

      throw new Error(`Apps Script devolvió una respuesta no-JSON: ${finalText.substring(0, 100)}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  private tryParseJson(text: string): any | null {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  /**
   * Sube una imagen (base64) a Drive vía Apps Script. Devuelve el enlace de
   * vista y el directo tal como los arma el script.
   */
  async uploadImage(
    base64Image: string,
    fileName: string,
    folderId?: string,
    mimeType = 'image/jpeg',
  ): Promise<{ success: boolean; fileUrl?: string; directLink?: string; message?: string }> {
    if (!this.scriptUrl) return { success: false, message: 'Drive no configurado en el backend (SCRIPT_URL).' };
    if (!base64Image) return { success: false, message: 'Imagen vacía.' };

    // Aceptar tanto base64 puro como data URL (el script espera base64 puro).
    const clean = base64Image.includes(',') ? base64Image.split(',').pop()! : base64Image;

    try {
      const data = await this.postToScript<any>({
        action: 'uploadImage',
        image: clean,
        fileName: fileName || `comprobante_${Date.now()}.jpg`,
        folderId: folderId || '',
        mimeType,
      });
      if (data?.status === 'success') {
        return { success: true, fileUrl: data.fileUrl, directLink: data.directLink };
      }
      return { success: false, message: data?.message || 'Apps Script no pudo subir la imagen.' };
    } catch (err: any) {
      this.logger.error(`uploadImage falló: ${err?.message}`);
      return { success: false, message: err?.message || 'Error subiendo a Drive' };
    }
  }

  /** Elimina un comprobante de Drive por URL o fileId, vía Apps Script. */
  async deleteImage(fileUrlOrId: string): Promise<{ success: boolean; message?: string }> {
    if (!fileUrlOrId) return { success: true, message: 'Sin comprobante que eliminar' };
    if (!this.scriptUrl) return { success: false, message: 'Drive no configurado en el backend (SCRIPT_URL).' };
    try {
      const data = await this.postToScript<any>({ action: 'deleteImage', fileUrl: fileUrlOrId });
      // El Apps Script es idempotente: responde success aunque no exista.
      return { success: data?.status === 'success', message: data?.message };
    } catch (err: any) {
      this.logger.error(`deleteImage falló: ${err?.message}`);
      return { success: false, message: err?.message || 'Error eliminando de Drive' };
    }
  }
}
