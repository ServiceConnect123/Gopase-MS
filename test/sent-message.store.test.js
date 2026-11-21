// Pruebas del SentMessageStore con un Firebase RTDB simulado en memoria.
// Ejecutar: npm run test:wsp (compila y corre con el runner nativo de Node).
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { SentMessageStore, fechaBucket, MSG_STORE_ROOT, ENTREGA_ROOT, WA_STATUS } = require(
  path.join(__dirname, '../dist/whatsapp/sent-message.store.js'),
);

function fakeFirebase() {
  const data = {};
  let updates = 0;
  const getAt = (p) => p.split('/').filter(Boolean).reduce((o, k) => (o == null ? undefined : o[k]), data);
  const setAt = (p, v) => {
    const ks = p.split('/').filter(Boolean);
    let o = data;
    for (const k of ks.slice(0, -1)) o = o[k] ??= {};
    if (v === null) delete o[ks.at(-1)];
    else o[ks.at(-1)] = JSON.parse(JSON.stringify(v));
  };
  return {
    data,
    get updates() { return updates; },
    isEnabled: () => true,
    db: () => ({
      ref: (p = '') => ({
        get: async () => { const v = getAt(p); return { exists: () => v !== undefined, val: () => v }; },
        update: async (vals) => { updates++; for (const [k, v] of Object.entries(vals)) setAt(p ? `${p}/${k}` : k, v); },
        remove: async () => setAt(p, null),
      }),
    }),
  };
}
const logger = { warn() {}, debug() {}, log() {} };

test('tras un reinicio, el reenvío devuelve el mensaje real (no vacío)', async () => {
  const fb = fakeFirebase();
  const a = new SentMessageStore(fb, logger, { flushMs: 10 });
  const message = { extendedTextMessage: { text: 'Tienes 3 pagos pendientes' } };
  a.registrarEnvio({ sesion: 'villa mayra', conjunto: 'villa mayra', to: '573000000000@s.whatsapp.net', id: 'ABC', message, tipo: 'texto' });
  await a.flush();
  // Proceso nuevo (memoria vacía): debe encontrarlo en RTDB.
  const b = new SentMessageStore(fb, logger);
  const got = await b.get('villa mayra', 'ABC');
  assert.deepStrictEqual(got, message);
});

test('mensaje inexistente => undefined (Baileys no reenvía nada)', async () => {
  const b = new SentMessageStore(fakeFirebase(), logger);
  assert.strictEqual(await b.get('villa mayra', 'NO-EXISTE'), undefined);
});

test('imágenes: se guardan sin miniatura y conservan las llaves binarias', async () => {
  const fb = fakeFirebase();
  const a = new SentMessageStore(fb, logger);
  const message = { imageMessage: { url: 'https://x', mediaKey: Buffer.from([1, 2, 3]), jpegThumbnail: Buffer.alloc(5000), caption: 'Recibo' } };
  a.registrarEnvio({ sesion: 's', conjunto: 's', to: 't', id: 'IMG', message, tipo: 'imagen' });
  await a.flush();
  const got = await new SentMessageStore(fb, logger).get('s', 'IMG');
  assert.ok(Buffer.isBuffer(got.imageMessage.mediaKey));
  assert.deepStrictEqual([...got.imageMessage.mediaKey], [1, 2, 3]);
  assert.strictEqual(got.imageMessage.jpegThumbnail, undefined);
  assert.strictEqual(got.imageMessage.caption, 'Recibo');
});

test('estados: avanzan y no retroceden; se escriben en lote', async () => {
  const fb = fakeFirebase();
  const s = new SentMessageStore(fb, logger);
  const now = Date.now();
  s.registrarEnvio({ sesion: 's', conjunto: 'c', to: 't', id: 'M1', message: { conversation: 'hola' }, tipo: 'texto', ts: now });
  assert.strictEqual(s.actualizarEstado('M1', WA_STATUS.DELIVERY_ACK).estado, 'entregado');
  assert.strictEqual(s.actualizarEstado('M1', WA_STATUS.ERROR), null, 'un error no pisa una entrega');
  assert.strictEqual(s.actualizarEstado('M1', WA_STATUS.READ).estado, 'leido');
  assert.strictEqual(s.actualizarEstado('M1', WA_STATUS.DELIVERY_ACK), null);
  assert.strictEqual(s.actualizarEstado('OTRO', WA_STATUS.READ), null, 'ids ajenos se ignoran');
  await s.flush();
  assert.strictEqual(fb.updates, 1, 'todo en una sola escritura');
  const rec = fb.data[ENTREGA_ROOT][fechaBucket(now)].M1;
  assert.strictEqual(rec.estado, 'leido');
  assert.ok(rec.entregadoEn && rec.leidoEn);
  const lista = await s.listar(fechaBucket(now), 'c');
  assert.strictEqual(lista.length, 1);
  assert.strictEqual((await s.listar(fechaBucket(now), 'otro')).length, 0);
});

test('revisar: reenvía a los 30 min, máximo 2 veces, y marca sin_entregar a las 6 h', () => {
  const s = new SentMessageStore(fakeFirebase(), logger);
  const t0 = Date.now();
  s.registrarEnvio({ sesion: 's', conjunto: 'c', to: 't', id: 'M2', message: { conversation: 'x' }, tipo: 'texto', ts: t0 });
  assert.strictEqual(s.revisar(t0 + 10 * 60_000).length, 0);
  assert.deepStrictEqual(s.revisar(t0 + 31 * 60_000).map((e) => e.id), ['M2']);
  s.marcarReintento('M2');
  assert.strictEqual(s.revisar(t0 + 40 * 60_000).length, 0);
  assert.strictEqual(s.revisar(t0 + 61 * 60_000).length, 1);
  s.marcarReintento('M2');
  assert.strictEqual(s.revisar(t0 + 120 * 60_000).length, 0, 'tope de reintentos');
  s.revisar(t0 + 7 * 3600_000);
  // Si el recibo llega tarde, igual pasa a entregado.
  assert.strictEqual(s.actualizarEstado('M2', WA_STATUS.DELIVERY_ACK).estado, 'entregado');
});

test('error del servidor: se reenvía y vuelve a "enviado"', () => {
  const s = new SentMessageStore(fakeFirebase(), logger);
  s.registrarEnvio({ sesion: 's', conjunto: 'c', to: 't', id: 'M3', message: { conversation: 'x' }, tipo: 'texto' });
  assert.strictEqual(s.actualizarEstado('M3', WA_STATUS.ERROR, '479').estado, 'error');
  assert.deepStrictEqual(s.revisar().map((e) => e.id), ['M3']);
  s.marcarReintento('M3');
  assert.strictEqual(s.revisar().length, 0);
});

test('tras reinicio se recargan las entregas pendientes y los recibos siguen aplicando', async () => {
  const fb = fakeFirebase();
  const a = new SentMessageStore(fb, logger);
  a.registrarEnvio({ sesion: 's', conjunto: 'c', to: 't', id: 'M4', message: { conversation: 'x' }, tipo: 'texto' });
  await a.flush();
  const b = new SentMessageStore(fb, logger);
  assert.strictEqual(b.actualizarEstado('M4', WA_STATUS.DELIVERY_ACK), null);
  assert.strictEqual(await b.cargarRecientes(), 1);
  assert.strictEqual(b.actualizarEstado('M4', WA_STATUS.DELIVERY_ACK).estado, 'entregado');
});

test('limpieza: borra días vencidos y conserva los recientes', async () => {
  const fb = fakeFirebase();
  const now = Date.now();
  const s = new SentMessageStore(fb, logger);
  s.registrarEnvio({ sesion: 's', conjunto: 'c', to: 't', id: 'NEW', message: { conversation: 'x' }, tipo: 'texto', ts: now });
  s.registrarEnvio({ sesion: 's', conjunto: 'c', to: 't', id: 'OLD', message: { conversation: 'x' }, tipo: 'texto', ts: now - 5 * 86400_000 });
  await s.flush();
  await s.limpiarViejos(now);
  assert.ok(fb.data[MSG_STORE_ROOT][fechaBucket(now)]);
  assert.strictEqual(fb.data[MSG_STORE_ROOT][fechaBucket(now - 5 * 86400_000)], undefined);
});
