/**
 * Descifrado de contraseñas compatible con el esquema del Apps Script de goPase.
 *
 * El frontend cifra con `encriptarAES` (realmente XOR + IV) y guarda en la hoja
 * el formato "base64(iv):base64(contenido)". El backend replica el MISMO
 * algoritmo para poder recuperar la contraseña real durante la migración a
 * Firebase Auth (la contraseña es reversible, no un hash).
 *
 * Soporta los mismos formatos legacy que `passwordMatches` del Apps Script:
 *   1. XOR+IV  -> "base64:base64"
 *   2. base64 simple
 *   3. texto plano
 */

const LOGIN_SECRET_KEY = 'SECRET_KEY_CONJUNTOS_APP';

/** base64 -> "binary string" (cada char = 1 byte 0-255), igual que ISO-8859-1. */
function b64ToBinary(b64: string): string {
  return Buffer.from(b64, 'base64').toString('binary');
}

/** Descifra el formato XOR+IV "base64(iv):base64(contenido)". */
function desencriptarXOR(textoEncriptado: string): string {
  try {
    if (!textoEncriptado || textoEncriptado.indexOf(':') === -1) return textoEncriptado;
    const parts = textoEncriptado.split(':');
    const iv = b64ToBinary(parts[0]);
    const encryptedStr = b64ToBinary(parts[1]);

    let out = '';
    for (let i = 0; i < encryptedStr.length; i++) {
      const charCode = encryptedStr.charCodeAt(i);
      const keyChar = LOGIN_SECRET_KEY.charCodeAt(i % LOGIN_SECRET_KEY.length);
      const ivChar = iv.charCodeAt(i % iv.length);
      out += String.fromCharCode(charCode ^ keyChar ^ ivChar);
    }
    // out es UTF-8 en bytes -> decodificar a string real (equivale a decodeURIComponent(escape(out))).
    return Buffer.from(out, 'binary').toString('utf8');
  } catch {
    return textoEncriptado;
  }
}

/** base64 simple -> texto (legacy). Si no es base64 válido, devuelve el input. */
function base64DecodeSafe(str: string): string {
  try {
    return Buffer.from(str, 'base64').toString('utf8');
  } catch {
    return str;
  }
}

/**
 * Recupera la contraseña en claro a partir del valor guardado en la hoja.
 * Prueba los formatos en el mismo orden que el Apps Script.
 * Devuelve '' si no hay contraseña.
 */
export function recoverPassword(stored: string): string {
  const s = (stored ?? '').toString().trim();
  if (!s) return '';

  // 1. XOR+IV (formato "base64:base64").
  if (s.indexOf(':') !== -1) {
    const dec = desencriptarXOR(s);
    if (dec && dec !== s) return dec;
  }

  // 2. base64 simple (legacy). Solo si parece base64.
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(s) && s.length >= 4) {
    const dec = base64DecodeSafe(s);
    // Heurística: si el decodificado es imprimible y distinto, úsalo.
    if (dec && dec !== s && /^[\x20-\x7E]+$/.test(dec)) return dec;
  }

  // 3. Texto plano.
  return s;
}
