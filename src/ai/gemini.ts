import { createHash } from 'crypto';

/**
 * Cliente robusto de Gemini (API REST de Google AI) para la cuota gratuita.
 *
 *  - Reintentos con espera creciente ante saturación (429 / 500 / 503 / 504).
 *  - Cambio de modelo: la cuota gratuita es por modelo, así se aprovechan varias.
 *  - Tiempo máximo por intento y por petición completa (el usuario no queda colgado).
 *  - Cola por clave: pocas peticiones simultáneas por conjunto, sin ráfagas.
 *  - Errores clasificados: saturado, clave, timeout, respuesta vacía.
 *  - Caché en memoria para resultados repetidos (p. ej. el mismo comprobante).
 *
 * Proveedor intercambiable: los llamadores solo ven `generarConIA`; cambiar a otro
 * proveedor (p. ej. Claude Haiku) es implementar esta misma firma.
 */

export type MotivoIA = 'saturado' | 'clave' | 'timeout' | 'respuesta' | 'error';

export interface ParteIA {
  text?: string;
  inlineData?: { mimeType: string; data: string };
}

export interface OpcionesIA {
  apiKey: string;
  parts: ParteIA[];
  /** Modelos en orden de preferencia. */
  models?: string[];
  /** Pide respuesta JSON (responseMimeType application/json). */
  json?: boolean;
  temperature?: number;
  /** Tiempo máximo por intento (ms). */
  timeoutMs?: number;
  /** Tiempo máximo de toda la petición, con reintentos (ms). */
  deadlineMs?: number;
  /** Reintentos por modelo ante saturación. */
  reintentos?: number;
  /** Base de la espera entre reintentos (ms): base, 2·base, 4·base… */
  esperaBaseMs?: number;
  /** Inyectable en pruebas. */
  fetchImpl?: typeof fetch;
}

export interface ResultadoIA {
  ok: boolean;
  text?: string;
  model?: string;
  motivo?: MotivoIA;
  message?: string;
  intentos: number;
}

/** Modelos por defecto (se pueden cambiar con GEMINI_MODELS="a,b"). */
export const MODELOS_GEMINI = (process.env.GEMINI_MODELS || 'gemini-3.5-flash-lite,gemini-flash-latest')
  .split(',')
  .map((m) => m.trim())
  .filter(Boolean);

const MENSAJES: Record<MotivoIA, string> = {
  saturado: 'El servicio de IA está saturado en este momento.',
  clave: 'La API key de Gemini del conjunto no es válida. Revísala en Conjuntos.',
  timeout: 'La IA tardó demasiado en responder.',
  respuesta: 'La IA no devolvió una respuesta utilizable.',
  error: 'No se pudo consultar la IA.',
};
export const mensajeIA = (m?: MotivoIA) => MENSAJES[m || 'error'];

// ---------------------------------------------------------------- cola por clave
const MAX_SIMULTANEAS = Math.max(1, Number(process.env.IA_MAX_SIMULTANEAS) || 2);
const colas = new Map<string, { activas: number; espera: Array<() => void> }>();
const idClave = (k: string) => createHash('sha256').update(String(k || '')).digest('hex').slice(0, 16);

/** Ejecuta `fn` respetando el máximo de peticiones simultáneas por clave. */
export async function conCupo<T>(apiKey: string, fn: () => Promise<T>): Promise<T> {
  const id = idClave(apiKey);
  let c = colas.get(id);
  if (!c) colas.set(id, (c = { activas: 0, espera: [] }));
  const cola = c;
  if (cola.activas >= MAX_SIMULTANEAS) await new Promise<void>((r) => cola.espera.push(r));
  cola.activas++;
  try {
    return await fn();
  } finally {
    cola.activas--;
    const sig = cola.espera.shift();
    if (sig) sig();
    else if (cola.activas === 0) colas.delete(id);
  }
}

// ---------------------------------------------------------------- caché
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const CACHE_MAX = 300;
const cache = new Map<string, { t: number; valor: any }>();

export const claveCache = (...partes: string[]) => createHash('sha256').update(partes.join('\u0000')).digest('hex');

export function leerCache<T = any>(k: string): T | undefined {
  const e = cache.get(k);
  if (!e) return undefined;
  if (Date.now() - e.t > CACHE_TTL_MS) {
    cache.delete(k);
    return undefined;
  }
  cache.delete(k);
  cache.set(k, e); // LRU: lo usado pasa al final
  return e.valor as T;
}

export function guardarCache(k: string, valor: any) {
  cache.set(k, { t: Date.now(), valor });
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
}

export function limpiarCacheIA() {
  cache.clear();
}

// ---------------------------------------------------------------- utilidades
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Fecha de hoy en Colombia, en palabras ("22 de noviembre de 2026"). */
export function hoyColombia(d = new Date()): string {
  return new Intl.DateTimeFormat('es-CO', { timeZone: 'America/Bogota', day: 'numeric', month: 'long', year: 'numeric' }).format(d);
}

/** Extrae el JSON de un texto (tolera ```json … ``` alrededor). */
export function parsearJsonIA<T = any>(texto: string): T | null {
  const limpio = String(texto || '').replace(/```json\s*/gi, '').replace(/```/g, '').trim();
  try {
    return JSON.parse(limpio) as T;
  } catch {
    const m = limpio.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]) as T;
    } catch {
      return null;
    }
  }
}

/** Reduce una imagen base64 a máx. 1280 px en JPEG (menos cuota y más rápido). Si falla, devuelve la original. */
export async function reducirImagen(base64: string, max = 1280): Promise<{ data: string; mimeType: string }> {
  const data = base64.includes(',') ? base64.split(',').pop()! : base64;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const sharp = require('sharp');
    const out: Buffer = await sharp(Buffer.from(data, 'base64'))
      .rotate()
      .resize({ width: max, height: max, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 82 })
      .toBuffer();
    if (!out || !out.length) throw new Error('vacía');
    return { data: out.toString('base64'), mimeType: 'image/jpeg' };
  } catch {
    return { data, mimeType: 'image/jpeg' };
  }
}

function clasificar(status: number, cuerpo: any): MotivoIA | 'modelo' {
  const msg = String(cuerpo?.error?.message || cuerpo?.error?.status || '').toLowerCase();
  if (status === 429 || status === 500 || status === 503 || status === 504 || /resource_exhausted|unavailable|overloaded/.test(msg)) return 'saturado';
  if (status === 401 || status === 403 || /api key|api_key|permission|unauthenticated/.test(msg)) return 'clave';
  if (status === 404 || /not found|is not supported/.test(msg)) return 'modelo';
  return 'error';
}

// ---------------------------------------------------------------- llamada principal
export async function generarConIA(op: OpcionesIA): Promise<ResultadoIA> {
  const f = op.fetchImpl || fetch;
  const modelos = (op.models && op.models.length ? op.models : MODELOS_GEMINI).slice();
  const timeoutMs = op.timeoutMs ?? 20000;
  const deadline = Date.now() + (op.deadlineMs ?? 30000);
  const reintentos = op.reintentos ?? 2;
  const base = op.esperaBaseMs ?? 2000;
  let intentos = 0;
  let ultimo: MotivoIA = 'error';
  let detalle = '';

  if (!op.apiKey) return { ok: false, motivo: 'clave', message: 'El conjunto no tiene Gemini configurado.', intentos };

  const body = JSON.stringify({
    contents: [{ role: 'user', parts: op.parts }],
    generationConfig: {
      temperature: op.temperature ?? 0.2,
      ...(op.json ? { responseMimeType: 'application/json' } : {}),
    },
  });

  return conCupo(op.apiKey, async () => {
    for (const model of modelos) {
      for (let intento = 0; intento <= reintentos; intento++) {
        const restante = deadline - Date.now();
        if (restante <= 500) return { ok: false, motivo: ultimo === 'error' ? 'timeout' : ultimo, message: mensajeIA(ultimo === 'error' ? 'timeout' : ultimo), intentos };
        intentos++;
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), Math.min(timeoutMs, restante));
        try {
          const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
          const resp = await f(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': op.apiKey },
            body,
            signal: ctrl.signal,
          } as any);
          let cuerpo: any = null;
          try {
            cuerpo = await resp.json();
          } catch {
            cuerpo = null;
          }
          if (resp.ok) {
            const parts = cuerpo?.candidates?.[0]?.content?.parts || [];
            const text = parts.map((p: any) => p?.text || '').join('').trim();
            if (text) return { ok: true, text, model, intentos };
            ultimo = 'respuesta';
            detalle = cuerpo?.promptFeedback?.blockReason || cuerpo?.candidates?.[0]?.finishReason || '';
            break; // probar otro modelo
          }
          const tipo = clasificar(resp.status, cuerpo);
          detalle = String(cuerpo?.error?.message || resp.status);
          if (tipo === 'clave') return { ok: false, motivo: 'clave', message: mensajeIA('clave'), intentos };
          if (tipo === 'modelo') break;
          ultimo = tipo;
          if (tipo !== 'saturado') break;
          if (intento < reintentos) {
            const espera = base * 2 ** intento + Math.floor(Math.random() * 250);
            if (Date.now() + espera >= deadline) break;
            await dormir(espera);
          }
        } catch (e: any) {
          const abortado = e?.name === 'AbortError' || /abort/i.test(String(e?.message || ''));
          ultimo = abortado ? 'timeout' : 'error';
          detalle = String(e?.message || '');
          break; // red caída o demasiado lento: otro modelo
        } finally {
          clearTimeout(timer);
        }
      }
    }
    if (detalle) console.warn(`[ia] sin respuesta (${ultimo}) tras ${intentos} intento(s): ${detalle.slice(0, 160)}`);
    return { ok: false, motivo: ultimo, message: mensajeIA(ultimo), intentos };
  });
}
