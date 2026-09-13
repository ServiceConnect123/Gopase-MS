import { Injectable, Logger } from '@nestjs/common';
import { google, drive_v3 } from 'googleapis';
import { Readable } from 'stream';
import { FirebaseService } from '../firebase/firebase.service';

/**
 * Sube y elimina comprobantes en Google Drive usando la MISMA service account
 * de Firebase (FIREBASE_SERVICE_ACCOUNT). Reemplaza el flujo que hacía el
 * frontend contra Apps Script (action uploadImage/deleteImage).
 *
 * IMPORTANTE: para que la service account pueda escribir en la carpeta de cada
 * conjunto, esa carpeta de Drive debe estar COMPARTIDA con el email de la
 * service account (client_email) como Editor. Si no, Drive responde 404/403.
 *
 * Contrato replicado del Apps Script:
 *   - upload -> { success, fileUrl, directLink }
 *       fileUrl:    enlace de vista (webViewLink)
 *       directLink: enlace directo visualizable (uc?export=view&id=<fileId>)
 *   - delete -> { success, message }
 */
@Injectable()
export class DriveService {
  private readonly logger = new Logger(DriveService.name);
  private drive: drive_v3.Drive | null = null;

  constructor(private readonly firebase: FirebaseService) {}

  /** Crea (una vez) el cliente de Drive con la service account de Firebase. */
  private getDrive(): drive_v3.Drive | null {
    if (this.drive) return this.drive;
    const sa = this.firebase.getServiceAccount();
    if (!sa || !sa.clientEmail || !sa.privateKey) {
      this.logger.warn('Drive deshabilitado: sin credenciales de service account.');
      return null;
    }
    const auth = new google.auth.JWT({
      email: sa.clientEmail,
      key: sa.privateKey,
      scopes: ['https://www.googleapis.com/auth/drive'],
    });
    this.drive = google.drive({ version: 'v3', auth });
    return this.drive;
  }

  /** Email de la service account, para instruir al usuario a compartir la carpeta. */
  getServiceAccountEmail(): string {
    return this.firebase.getServiceAccount()?.clientEmail || '';
  }

  /** Extrae el fileId de una URL de Drive (uc?id=, /d/<id>/, lh3, ...) o crudo. */
  private extractFileId(raw: string): string {
    const s = String(raw || '').trim();
    if (!s) return '';
    // uc?id=<id> o ?id=<id>
    let m = s.match(/[?&]id=([a-zA-Z0-9_-]+)/);
    if (m) return m[1];
    // /d/<id>/
    m = s.match(/\/d\/([a-zA-Z0-9_-]+)/);
    if (m) return m[1];
    // lh3.googleusercontent.com/d/<id>
    m = s.match(/googleusercontent\.com\/d\/([a-zA-Z0-9_-]+)/);
    if (m) return m[1];
    // Si ya parece un id crudo.
    if (/^[a-zA-Z0-9_-]{20,}$/.test(s)) return s;
    return '';
  }

  private directLink(fileId: string): string {
    return `https://drive.google.com/uc?export=view&id=${fileId}`;
  }

  /**
   * Sube una imagen (base64, sin el prefijo data:) a la carpeta indicada.
   * Devuelve el enlace de vista y el directo.
   */
  async uploadImage(
    base64Image: string,
    fileName: string,
    folderId?: string,
    mimeType = 'image/jpeg',
  ): Promise<{ success: boolean; fileUrl?: string; directLink?: string; message?: string }> {
    const drive = this.getDrive();
    if (!drive) return { success: false, message: 'Drive no configurado en el backend.' };
    if (!base64Image) return { success: false, message: 'Imagen vacía.' };

    try {
      // Aceptar tanto base64 puro como data URL.
      const clean = base64Image.includes(',') ? base64Image.split(',').pop()! : base64Image;
      const buffer = Buffer.from(clean, 'base64');
      const stream = Readable.from(buffer);

      const requestBody: drive_v3.Schema$File = { name: fileName };
      if (folderId) requestBody.parents = [folderId];

      const res = await drive.files.create({
        requestBody,
        media: { mimeType, body: stream },
        fields: 'id, webViewLink',
        supportsAllDrives: true,
      });

      const fileId = res.data.id || '';
      if (!fileId) return { success: false, message: 'Drive no devolvió el id del archivo.' };

      // Hacer el archivo visible por enlace (lectura pública), como el flujo previo.
      try {
        await drive.permissions.create({
          fileId,
          requestBody: { role: 'reader', type: 'anyone' },
          supportsAllDrives: true,
        });
      } catch (permErr: any) {
        this.logger.warn(`No se pudo hacer público ${fileId}: ${permErr?.message || permErr}`);
      }

      return {
        success: true,
        fileUrl: res.data.webViewLink || this.directLink(fileId),
        directLink: this.directLink(fileId),
      };
    } catch (err: any) {
      const msg = err?.errors?.[0]?.message || err?.message || 'Error subiendo a Drive';
      this.logger.error(`uploadImage falló: ${msg}`);
      return { success: false, message: msg };
    }
  }

  /** Elimina un comprobante de Drive por URL o fileId. */
  async deleteImage(fileUrlOrId: string): Promise<{ success: boolean; message?: string }> {
    if (!fileUrlOrId) return { success: true, message: 'Sin comprobante que eliminar' };
    const drive = this.getDrive();
    if (!drive) return { success: false, message: 'Drive no configurado en el backend.' };

    const fileId = this.extractFileId(fileUrlOrId);
    if (!fileId) return { success: false, message: 'No se pudo extraer el id del archivo.' };

    try {
      await drive.files.delete({ fileId, supportsAllDrives: true });
      return { success: true, message: 'Comprobante eliminado.' };
    } catch (err: any) {
      // Si ya no existe, lo tratamos como éxito idempotente.
      if (err?.code === 404) return { success: true, message: 'El comprobante ya no existía.' };
      const msg = err?.errors?.[0]?.message || err?.message || 'Error eliminando de Drive';
      this.logger.error(`deleteImage falló: ${msg}`);
      return { success: false, message: msg };
    }
  }
}
