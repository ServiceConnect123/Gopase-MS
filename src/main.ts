import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { json, urlencoded } from 'express';
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

  // Subir el límite del body: los comprobantes llegan como imagen en base64
  // (POST /drive/upload), que supera el default de Express (100kb).
  app.use(json({ limit: '15mb' }));
  app.use(urlencoded({ limit: '15mb', extended: true }));

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
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'x-api-key', 'x-sync-token', 'accept'],
  });

  // Swagger / OpenAPI en /docs (y el JSON en /docs-json).
  const swaggerConfig = new DocumentBuilder()
    .setTitle('wspsend-ms API')
    .setDescription(
      'Microservicio de goPase: notificaciones por WhatsApp (recordatorios de ' +
        'pago, recibos), gestión de la sesión de WhatsApp y sincronización ' +
        'Google Sheets -> Realtime Database.',
    )
    .setVersion('1.0')
    .addTag('notifications', 'Recordatorios de cobro y envío de recibos')
    .addTag('whatsapp', 'Estado y gestión de la sesión de WhatsApp (QR, relogin)')
    .addTag('sync', 'Sincronización Sheets -> Realtime Database (migración)')
    .addTag('auth', 'Migración de usuarios de Sheets a Firebase Auth')
    .addTag('home', 'Dashboard de la pantalla Home (data ya calculada)')
    .addTag('profile', 'Perfil de usuario contra Firebase (RTDB + Auth)')
    .addTag('payments', 'Lecturas y cálculos de Pagos (data ya calculada, RTDB)')
    .addTag('users', 'CRUD de usuarios contra Firebase (RTDB + Auth)')
    .addTag('properties', 'CRUD de propiedades/conjuntos (RTDB, sin claves sensibles)')
    .addTag('zones', 'CRUD de zonas comunes (RTDB)')
    .addTag('reservations', 'CRUD de reservas de zonas comunes (RTDB)')
    .addTag('roles', 'CRUD de roles global (RTDB)')
    // Header opcional que protege los endpoints de sincronización.
    .addApiKey(
      { type: 'apiKey', name: 'x-sync-token', in: 'header' },
      'sync-token',
    )
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('docs', app, document, {
    customSiteTitle: 'wspsend-ms API Docs',
    swaggerOptions: { persistAuthorization: true },
  });

  const port = process.env.PORT || 3001;
  await app.listen(port);
  Logger.log(`wspsend-ms escuchando en el puerto ${port}`, 'Bootstrap');
  Logger.log(`Swagger disponible en /docs`, 'Bootstrap');
}
bootstrap();
