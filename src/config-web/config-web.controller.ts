import { Controller, Get, Logger } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/public.decorator';

/**
 * Entrega al cliente (app web/móvil) la configuración de Firebase para WEB, que
 * se usa para inicializar Firebase Analytics. Así la config vive solo en el
 * backend (env GOOGLE_JSON) y cambia por ambiente (QA/prod) sin recompilar la app.
 *
 * IMPORTANTE: GOOGLE_JSON debe contener el `firebaseConfig` WEB (apiKey,
 * authDomain, projectId, appId, measurementId...), NO la service account (admin).
 * Solo se exponen las claves del config web; cualquier otro campo se descarta.
 * Estas claves web no son secretas (viajan al navegador por diseño de Firebase).
 */
@Public()
@ApiTags('config')
@Controller('config')
export class ConfigWebController {
  private readonly logger = new Logger(ConfigWebController.name);
  // Solo estos campos se devuelven al cliente (whitelist del firebaseConfig web).
  private static readonly CAMPOS = [
    'apiKey',
    'authDomain',
    'databaseURL',
    'projectId',
    'storageBucket',
    'messagingSenderId',
    'appId',
    'measurementId',
  ] as const;

  // Cachea el parseo (la env no cambia en caliente). { ...config, configured }.
  private cache: { configured: boolean; config: Record<string, string> } | null = null;

  @ApiOperation({
    summary: 'Config de Firebase Web para el cliente (Analytics). Solo campos del firebaseConfig web.',
  })
  @Get('firebase-web')
  firebaseWeb() {
    if (!this.cache) this.cache = this.build();
    // `configured:false` => la app sabe que Analytics no está disponible y no rompe.
    return { success: true, ...this.cache };
  }

  private build(): { configured: boolean; config: Record<string, string> } {
    const raw = process.env.GOOGLE_JSON || '';
    if (!raw.trim()) {
      this.logger.warn('GOOGLE_JSON no configurada: /config/firebase-web responde sin config.');
      return { configured: false, config: {} };
    }
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch (e: any) {
      this.logger.error(`GOOGLE_JSON no es un JSON válido: ${e?.message}`);
      return { configured: false, config: {} };
    }
    // Defensa: si viene una service account por error, NO exponerla.
    if (parsed && (parsed.type === 'service_account' || parsed.private_key)) {
      this.logger.error('GOOGLE_JSON parece una service account (admin); no se expone. Usa el firebaseConfig web.');
      return { configured: false, config: {} };
    }
    const config: Record<string, string> = {};
    for (const k of ConfigWebController.CAMPOS) {
      if (parsed?.[k] != null && String(parsed[k]).trim()) config[k] = String(parsed[k]);
    }
    // Sin apiKey o appId el SDK web no inicializa; se informa como no configurado.
    const configured = !!config.apiKey && !!config.appId;
    if (!configured) {
      this.logger.warn('GOOGLE_JSON sin apiKey/appId válidos para el firebaseConfig web.');
    }
    return { configured, config };
  }
}
