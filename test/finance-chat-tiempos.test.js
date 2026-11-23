// Chat de finanzas: con Gemini saturado o lento debe responder SIEMPRE antes de
// ~45 s (el iPhone corta la petición a los ~60 s con "Load failed") y probar el
// otro modelo antes de esperar.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const Module = require('module');

// Genkit simulado: cada llamada ejecuta el comportamiento que defina la prueba.
let comportamiento = async () => ({ text: 'ok' });
const llamadas = [];
const fakeGenkit = {
  genkit: () => ({
    defineTool: () => ({}),
    generate: (opts) => {
      llamadas.push(opts.model);
      return comportamiento(opts);
    },
  }),
  // z de zod: cualquier propiedad o llamada devuelve el mismo objeto encadenable.
  z: (() => { const f = new Proxy(function () {}, { get: () => f, apply: () => f }); return f; })(),
};
const fakeGoogle = { googleAI: Object.assign(() => ({}), { model: (m) => m }) };
const origLoad = Module._load;
Module._load = function (req, ...rest) {
  if (req === 'genkit') return fakeGenkit;
  if (req === '@genkit-ai/google-genai') return fakeGoogle;
  return origLoad.call(this, req, ...rest);
};

process.env.GEMINI_CHAT_MODELS = 'modelo-a,modelo-b';
const { runFinanceChat } = require(path.join(__dirname, '../dist/payments/finance-chat.ai.js'));

const params = (k) => ({ apiKey: `k-${k}`, conjunto: 'X', year: 2026, question: '¿Cuántos pagaron?', history: [], context: '', loadOwners: async () => [] });
const err503 = () => Object.assign(new Error('UNAVAILABLE: [503 Service Unavailable] high demand'), { status: 503 });

test('si el primer modelo está saturado, prueba el segundo de inmediato', async () => {
  llamadas.length = 0;
  comportamiento = async (o) => {
    if (o.model === 'modelo-a') throw err503();
    return { text: 'respuesta de b' };
  };
  const t0 = Date.now();
  const r = await runFinanceChat(params(1));
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.text, 'respuesta de b');
  assert.deepStrictEqual(llamadas, ['modelo-a', 'modelo-b']);
  assert.ok(Date.now() - t0 < 1000, 'sin esperas innecesarias');
});

test('si todo está saturado, responde con el aviso (no se queda colgado)', async () => {
  llamadas.length = 0;
  comportamiento = async () => { throw err503(); };
  const t0 = Date.now();
  const r = await runFinanceChat(params(2));
  assert.strictEqual(r.success, false);
  assert.match(r.message, /saturado/);
  assert.ok(Date.now() - t0 < 45000);
  assert.ok(llamadas.length >= 4, 'reintenta en rondas');
});

test('una llamada que no responde se corta y se prueba el otro modelo', { timeout: 60000 }, async () => {
  llamadas.length = 0;
  comportamiento = (o) => {
    if (o.model === 'modelo-a') {
      // Cuelga hasta que la aborten.
      return new Promise((_, rej) => o.abortSignal?.addEventListener('abort', () => rej(new Error('aborted'))));
    }
    return Promise.resolve({ text: 'b respondió' });
  };
  const t0 = Date.now();
  const r = await runFinanceChat(params(3));
  const dur = Date.now() - t0;
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.text, 'b respondió');
  assert.ok(dur < 20000, `tardó ${dur} ms`);
});
