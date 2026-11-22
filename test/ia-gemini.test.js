// Cliente robusto de Gemini: reintentos, cambio de modelo, timeouts, cola y caché.
// Ejecutar: npm run test:wsp (compila y corre con el runner nativo de Node).
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const ia = require(path.join(__dirname, '../dist/ai/gemini.js'));

const ok = (text) => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }) });
const err = (status, message = '') => ({ ok: false, status, json: async () => ({ error: { message, status: '' } }) });
const base = { apiKey: 'k1', parts: [{ text: 'hola' }], esperaBaseMs: 5, models: ['m1', 'm2'] };

test('responde al primer intento', async () => {
  const llamadas = [];
  const r = await ia.generarConIA({ ...base, fetchImpl: async (u) => { llamadas.push(u); return ok('listo'); } });
  assert.deepStrictEqual([r.ok, r.text, r.model, r.intentos], [true, 'listo', 'm1', 1]);
  assert.match(llamadas[0], /models\/m1:generateContent$/); // la clave va en cabecera, no en la URL
});

test('saturado (429) reintenta y luego responde', async () => {
  let n = 0;
  const r = await ia.generarConIA({ ...base, fetchImpl: async () => (++n < 3 ? err(429, 'RESOURCE_EXHAUSTED') : ok('ya')) });
  assert.deepStrictEqual([r.ok, r.text, r.model, r.intentos], [true, 'ya', 'm1', 3]);
});

test('si un modelo sigue saturado, pasa al siguiente', async () => {
  const r = await ia.generarConIA({ ...base, fetchImpl: async (u) => (u.includes('/m1:') ? err(503) : ok('del m2')) });
  assert.deepStrictEqual([r.ok, r.model, r.intentos], [true, 'm2', 4]); // 3 intentos en m1 + 1 en m2
});

test('modelo inexistente (404) salta sin reintentar', async () => {
  const r = await ia.generarConIA({ ...base, fetchImpl: async (u) => (u.includes('/m1:') ? err(404, 'not found') : ok('x')) });
  assert.deepStrictEqual([r.ok, r.model, r.intentos], [true, 'm2', 2]);
});

test('clave inválida: corta de inmediato con motivo clave', async () => {
  const r = await ia.generarConIA({ ...base, fetchImpl: async () => err(400, 'API key not valid. Please pass a valid API key.') });
  assert.deepStrictEqual([r.ok, r.motivo, r.intentos], [false, 'clave', 1]);
  const sin = await ia.generarConIA({ ...base, apiKey: '', fetchImpl: async () => ok('x') });
  assert.strictEqual(sin.motivo, 'clave');
});

test('todo saturado: devuelve motivo saturado (no éxito vacío)', async () => {
  const r = await ia.generarConIA({ ...base, fetchImpl: async () => err(429) });
  assert.deepStrictEqual([r.ok, r.motivo], [false, 'saturado']);
  assert.match(r.message, /saturado/);
});

test('tiempo agotado por intento: pasa al siguiente modelo', async () => {
  const lento = (u, init) => new Promise((res, rej) => {
    if (u.includes('/m2:')) return res(ok('rápido'));
    init.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; rej(e); });
  });
  const r = await ia.generarConIA({ ...base, timeoutMs: 30, fetchImpl: lento });
  assert.deepStrictEqual([r.ok, r.model], [true, 'm2']);
});

test('respuesta vacía: prueba otro modelo', async () => {
  const r = await ia.generarConIA({ ...base, fetchImpl: async (u) => (u.includes('/m1:') ? ok('') : ok('lleno')) });
  assert.deepStrictEqual([r.ok, r.text], [true, 'lleno']);
});

test('cola: como máximo 2 peticiones simultáneas por clave', async () => {
  let activas = 0, max = 0;
  const lenta = async () => { activas++; max = Math.max(max, activas); await new Promise((r) => setTimeout(r, 20)); activas--; return ok('x'); };
  await Promise.all(Array.from({ length: 6 }, () => ia.generarConIA({ ...base, apiKey: 'cola', fetchImpl: lenta })));
  assert.strictEqual(max, 2);
});

test('pide JSON cuando json=true y parsea con o sin ```', async () => {
  let cuerpo;
  await ia.generarConIA({ ...base, json: true, fetchImpl: async (u, init) => { cuerpo = JSON.parse(init.body); return ok('{}'); } });
  assert.strictEqual(cuerpo.generationConfig.responseMimeType, 'application/json');
  assert.deepStrictEqual(ia.parsearJsonIA('```json\n{"monto": 60000}\n```'), { monto: 60000 });
  assert.deepStrictEqual(ia.parsearJsonIA('Aquí va: {"a":1} listo'), { a: 1 });
  assert.strictEqual(ia.parsearJsonIA('sin json'), null);
});

test('caché: guarda y expira por clave', () => {
  ia.limpiarCacheIA();
  const k = ia.claveCache('comprobante', 'monto', 'abc');
  assert.strictEqual(ia.leerCache(k), undefined);
  ia.guardarCache(k, { success: true, monto: 5 });
  assert.deepStrictEqual(ia.leerCache(k), { success: true, monto: 5 });
  assert.notStrictEqual(k, ia.claveCache('comprobante', 'forense', 'abc'));
});

test('fecha de hoy en Colombia', () => {
  assert.strictEqual(ia.hoyColombia(new Date('2026-11-23T03:00:00Z')), '22 de noviembre de 2026'); // 22:00 en Bogotá
});
