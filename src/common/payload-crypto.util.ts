// ==========================================
// Cifrado de payload (ofuscación XOR+IV)
// ==========================================
// MISMO esquema que el frontend (encriptarAES/desencriptarAES): XOR triple
// (dato ^ clave ^ IV) con el resultado en "base64(iv):base64(contenido)".
//
// IMPORTANTE: esto es OFUSCACIÓN, no seguridad fuerte. La clave es estática y
// compartida con el cliente (una app pública), así que un atacante puede
// extraerla. La seguridad real la dan HTTPS (en tránsito) y el JWT (acceso).
// El objetivo aquí es que el tráfico no se vea en claro al inspeccionarlo.

const SECRET_KEY = 'SECRET_KEY_CONJUNTOS_APP';
const IV_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** base64 <-> "binary string" (1 char = 1 byte), equivalente a atob/btoa. */
function toB64(binary: string): string {
  return Buffer.from(binary, 'binary').toString('base64');
}
function fromB64(b64: string): string {
  return Buffer.from(b64, 'base64').toString('binary');
}

/** IV aleatorio de n caracteres (igual que generateIV del frontend). */
function genIV(n: number): string {
  let r = '';
  for (let i = 0; i < n; i++) {
    r += IV_CHARS[Math.floor(Math.random() * IV_CHARS.length)];
  }
  return r;
}

/**
 * Cifra un texto (normalmente JSON) al formato "base64(iv):base64(contenido)".
 * Espejo exacto de encriptarAES del frontend.
 */
export function encryptPayload(texto: string): string {
  const iv = genIV(16);
  // texto -> UTF-8 en bytes (binary string), igual que unescape(encodeURIComponent).
  const utf8 = Buffer.from(String(texto ?? ''), 'utf8').toString('binary');
  let enc = '';
  for (let i = 0; i < utf8.length; i++) {
    const x =
      utf8.charCodeAt(i) ^
      SECRET_KEY.charCodeAt(i % SECRET_KEY.length) ^
      iv.charCodeAt(i % iv.length);
    enc += String.fromCharCode(x);
  }
  return `${toB64(iv)}:${toB64(enc)}`;
}

/**
 * Descifra el formato "base64(iv):base64(contenido)" a su texto original.
 * Devuelve null si el formato no es válido (para que el llamador decida).
 */
export function decryptPayload(encriptado: string): string | null {
  const s = String(encriptado ?? '');
  if (s.indexOf(':') === -1) return null;
  try {
    const [ivB64, contentB64] = s.split(':');
    const iv = fromB64(ivB64);
    const enc = fromB64(contentB64);
    let out = '';
    for (let i = 0; i < enc.length; i++) {
      const x =
        enc.charCodeAt(i) ^
        SECRET_KEY.charCodeAt(i % SECRET_KEY.length) ^
        iv.charCodeAt(i % iv.length);
      out += String.fromCharCode(x);
    }
    // out es UTF-8 en bytes -> string real.
    return Buffer.from(out, 'binary').toString('utf8');
  } catch {
    return null;
  }
}
