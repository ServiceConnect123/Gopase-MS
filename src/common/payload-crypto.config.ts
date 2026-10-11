// ==========================================
// Configuración del cifrado de payload
// ==========================================
// Rutas EXCLUIDAS del cifrado request/response. Son endpoints que manejan
// binarios grandes (Excel/imágenes en base64) o respuestas no-JSON (HTML del
// QR). Deben coincidir EXACTAMENTE con la lista del frontend (dataService) para
// que ambos lados estén alineados.
//
// La exclusión se evalúa por prefijo del path (startsWith sobre la ruta sin
// query string).

export const PAYLOAD_ENC_EXCLUDED_PATHS: string[] = [
  '/payments/import',          // cubre /payments/import y /payments/import-template
  '/users/import',             // cubre /users/import y /users/import-template
  '/reports/finance-import',
  '/reports/finance-template',
  '/drive/upload',
  '/payments/analyze-receipt',
  '/whatsapp',                 // QR (JSON con PNG base64) + qr/view (HTML)
];

/** ¿La ruta está excluida del cifrado de payload? */
export function isPayloadEncExcluded(path: string): boolean {
  const p = String(path || '').split('?')[0];
  return PAYLOAD_ENC_EXCLUDED_PATHS.some((ex) => p.startsWith(ex));
}
