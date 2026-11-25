/**
 * Reglas de validación de pagos ePayco (puras, sin red, para poder probarlas).
 *
 * Antes:
 *  - El webhook solo validaba la firma SI venía `x_signature`: omitiéndola se
 *    activaba cualquier plan para cualquier conjunto.
 *  - /epayco/confirm aceptaba cualquier referencia aceptada, aunque fuera de otro
 *    conjunto, de otro plan o de un monto menor, y la misma referencia podía
 *    usarse en varios conjuntos.
 */

const norm = (s: unknown) => String(s ?? '').trim().toLowerCase();

/** Datos de la transacción según la API de validación de ePayco. */
export interface TransaccionEpayco {
  accepted: boolean;
  monto: number;
  message: string;
  /** x_extra1 = conjunto, x_extra2 = planId (los fija el checkout). */
  conjunto?: string;
  planId?: string;
}

export type Decision = { ok: true } | { ok: false; motivo: string };

/** La firma del webhook es obligatoria fuera del modo prueba. */
export function firmaWebhookValida(opts: {
  test: boolean;
  configurada: boolean;
  firmaRecibida: string;
  firmaValida: boolean;
}): Decision {
  if (opts.test) return { ok: true };
  if (!opts.configurada) return { ok: false, motivo: 'ePayco sin customerId/pKey: no se puede validar la firma.' };
  if (!String(opts.firmaRecibida || '').trim()) return { ok: false, motivo: 'Falta la firma de seguridad.' };
  return opts.firmaValida ? { ok: true } : { ok: false, motivo: 'Firma de seguridad inválida.' };
}

/**
 * La transacción verificada en ePayco corresponde a lo que se quiere activar:
 * aceptada, del mismo conjunto y plan (si ePayco los devuelve) y con un monto
 * no menor al esperado (si se conoce).
 */
export function transaccionCorresponde(
  tx: TransaccionEpayco,
  pedido: { conjunto: string; planId: string; montoEsperado?: number },
): Decision {
  if (!tx.accepted) return { ok: false, motivo: `El pago no está aceptado en ePayco (${tx.message}).` };
  if (tx.conjunto && norm(tx.conjunto) !== norm(pedido.conjunto)) {
    return { ok: false, motivo: 'La referencia de pago es de otro conjunto.' };
  }
  if (tx.planId && norm(tx.planId) !== norm(pedido.planId)) {
    return { ok: false, motivo: 'La referencia de pago es de otro plan.' };
  }
  const esperado = Number(pedido.montoEsperado || 0);
  if (esperado > 0 && Number(tx.monto || 0) + 0.5 < esperado) {
    return { ok: false, motivo: 'El monto pagado es menor al del plan.' };
  }
  return { ok: true };
}

/** Key segura de RTDB para registrar referencias ya usadas. */
export const refKey = (ref: string) => String(ref ?? '').trim().replace(/[.#$/\[\]]/g, '_');
