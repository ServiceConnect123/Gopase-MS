import { Body, Controller, Post } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { DriveService } from './drive.service';

/**
 * Subida/eliminación de comprobantes en Google Drive desde el backend.
 * El backend reenvía al Apps Script (que sube con DriveApp, con cuota del dueño
 * del script). El frontend solo habla con estos endpoints, nunca con Apps Script.
 */
@ApiTags('drive')
@Controller('drive')
export class DriveController {
  constructor(private readonly drive: DriveService) {}

  @ApiOperation({ summary: 'Subir comprobante (imagen base64) a Drive' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        image: { type: 'string', description: 'Imagen en base64 (con o sin prefijo data:)' },
        fileName: { type: 'string' },
        folderId: { type: 'string', description: 'driveFolderId del conjunto' },
        mimeType: { type: 'string', example: 'image/jpeg' },
      },
      required: ['image', 'fileName'],
    },
  })
  @Post('upload')
  async upload(
    @Body() body: { image: string; fileName: string; folderId?: string; mimeType?: string },
  ) {
    return this.drive.uploadImage(
      body.image,
      body.fileName || `comprobante_${Date.now()}.jpg`,
      body.folderId,
      body.mimeType || (String(body.fileName || '').endsWith('.png') ? 'image/png' : 'image/jpeg'),
    );
  }

  @ApiOperation({ summary: 'Eliminar comprobante de Drive (por URL o fileId)' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: { fileUrl: { type: 'string' } },
      required: ['fileUrl'],
    },
  })
  @Post('delete')
  async remove(@Body() body: { fileUrl: string }) {
    return this.drive.deleteImage(body.fileUrl);
  }
}
