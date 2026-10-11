// ==========================================
// Interceptor global de cifrado de payload (ofuscación)
// ==========================================
// Centraliza el cifrado request/response para TODOS los endpoints JSON, sin
// tocar cada controller. Controlado por la env PAYLOAD_ENCRYPTION_ENABLED:
// si no es 'true', es passthrough total (rollout seguro, como el guard JWT).
//
// Protocolo del "sobre":
//   - Request:  el cliente envía  { "enc": "base64(iv):base64(data)" } como body.
//               El interceptor lo descifra y repone req.body = JSON original
//               ANTES de que el controller (y el AuditInterceptor) lo lean.
//   - Response: el interceptor cifra el JSON de salida y responde { "enc": "..." }.
//
// Compatibilidad: si el flag está activo pero el request NO viene cifrado (body
// sin `enc`), se procesa igual en claro (no rompe clientes viejos). Las rutas
// binarias (Excel/imágenes/QR) están excluidas por isPayloadEncExcluded.

import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Observable, map } from 'rxjs';
import { encryptPayload, decryptPayload } from './payload-crypto.util';
import { isPayloadEncExcluded } from './payload-crypto.config';

@Injectable()
export class PayloadCryptoInterceptor implements NestInterceptor {
  constructor(private readonly config: ConfigService) {}

  private get enabled(): boolean {
    return this.config.get<string>('PAYLOAD_ENCRYPTION_ENABLED', 'false') === 'true';
  }

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (ctx.getType() !== 'http' || !this.enabled) return next.handle();

    const req = ctx.switchToHttp().getRequest();
    const path = String(req?.route?.path ?? req?.originalUrl ?? req?.url ?? '');

    // Rutas binarias / no-JSON: no se cifran en ningún sentido.
    if (isPayloadEncExcluded(path)) return next.handle();

    // 1) DESCIFRAR el request: si el body viene como sobre { enc }, reponerlo.
    const body = req?.body;
    if (body && typeof body === 'object' && typeof body.enc === 'string') {
      const plain = decryptPayload(body.enc);
      if (plain != null) {
        try {
          req.body = plain.length ? JSON.parse(plain) : {};
        } catch {
          // Si no era JSON, dejar el texto plano tal cual.
          req.body = plain;
        }
      }
    }

    // ¿El cliente entiende cifrado? Solo ciframos la respuesta si lo indicó con
    // X-Enc. Así un cliente viejo (sin el header) recibe la respuesta en claro y
    // no se rompe, aunque el flag global del backend esté activo.
    const clientWantsEnc =
      String(req?.headers?.['x-enc'] ?? '') === '1' ||
      (typeof body === 'object' && body !== null && typeof (body as any).enc === 'string');
    if (!clientWantsEnc) return next.handle();

    // 2) CIFRAR la response: envolver el JSON de salida en { enc }.
    return next.handle().pipe(
      map((data) => {
        // Solo cifra respuestas serializables a JSON. undefined/null pasan igual.
        if (data === undefined || data === null) return data;
        try {
          const json = JSON.stringify(data);
          return { enc: encryptPayload(json) };
        } catch {
          // No serializable (p. ej. Buffer/stream): devolver tal cual.
          return data;
        }
      }),
    );
  }
}
