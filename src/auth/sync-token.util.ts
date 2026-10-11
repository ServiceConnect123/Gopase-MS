import { UnauthorizedException } from '@nestjs/common';
import { recoverPassword } from './password.util';

/**
 * Verifica el header `x-sync-token` de las rutas internas (sync, migración,
 * set-password). El cliente envía el token CIFRADO con el mismo esquema XOR+IV
 * de las contraseñas (encriptarAES); aquí se descifra antes de comparar con el
 * valor esperado (SYNC_TOKEN).
 *
 * Reglas:
 *  - Si `expected` (SYNC_TOKEN) está vacío, no se exige nada (modo abierto, solo
 *    pruebas). En QA/PRD debe configurarse.
 *  - Se acepta tanto el token cifrado (preferido) como el valor en claro, para
 *    no romper clientes/ops que aún no cifren. El descifrado de un valor en
 *    claro devuelve el mismo valor, así que la comparación sigue funcionando.
 *
 * @param received  Valor recibido en el header `x-sync-token` (cifrado o claro).
 * @param expected  Valor esperado (de la env SYNC_TOKEN).
 */
export function assertSyncToken(received: string | undefined, expected: string): void {
  if (!expected) return; // no configurado => abierto (solo pruebas)
  const raw = (received ?? '').toString();
  // recoverPassword descifra XOR+IV; si viene en claro, lo devuelve igual.
  const decrypted = recoverPassword(raw);
  if (decrypted !== expected && raw !== expected) {
    throw new UnauthorizedException('Token inválido.');
  }
}
