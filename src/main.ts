import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module';

/**
 * Errores no capturados que provienen de Baileys/WebSocket (p. ej. fallos de
 * descifrado del protocolo Noise: "Unsupported state or unable to authenticate
 * data") ocurren en callbacks asíncronos del socket y, si no se manejan, matan
 * el proceso. En Render eso provoca un ciclo de reinicios. Los registramos y
 * mantenemos el proceso vivo: la lógica de reconexión de WhatsappService se
 * encarga de restablecer la sesión.
 */
function installGlobalErrorHandlers() {
  const log = new Logger('Process');

  process.on('uncaughtException', (err: any) => {
    log.error(`uncaughtException: ${err?.message}`, err?.stack);
    // No hacemos process.exit: dejamos que el servicio siga y reconecte.
  });

  process.on('unhandledRejection', (reason: any) => {
    const msg = reason?.message || String(reason);
    log.error(`unhandledRejection: ${msg}`);
  });
}

async function bootstrap() {
  installGlobalErrorHandlers();

  const app = await NestFactory.create(AppModule);

  // CORS: permitir que el frontend (gopasehome.site y previews) consuma la API.
  // CORS_ORIGINS puede ser una lista separada por comas; si no se define, se
  // permiten los orígenes conocidos de goPase.
  const configured = (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  const defaultOrigins = [
    'https://www.gopasehome.site',
    'https://gopasehome.site',
    'https://gopase.vercel.app',
    'http://localhost:8081',
    'http://localhost:19006',
  ];
  const allowed = configured.length > 0 ? configured : defaultOrigins;

  app.enableCors({
    origin: (origin, callback) => {
      // Permitir peticiones sin origin (curl, apps móviles nativas) y las de la lista.
      if (!origin || allowed.includes(origin)) {
        callback(null, true);
      } else {
        callback(null, true); // permisivo: el servicio no maneja datos sensibles por sesión
      }
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'x-api-key'],
  });

  const port = process.env.PORT || 3001;
  await app.listen(port);
  Logger.log(`wspsend-ms escuchando en el puerto ${port}`, 'Bootstrap');
}
bootstrap();
