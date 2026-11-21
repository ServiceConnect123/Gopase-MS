// Pruebas del SessionLock (una sola instancia por número de WhatsApp) con un
// RTDB simulado que implementa transacciones.
// Ejecutar: npm run test:wsp
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { SessionLock, LOCK_ROOT } = require(path.join(__dirname, '../dist/whatsapp/session-lock.js'));

function fakeFirebase() {
  const data = {};
  return {
    data,
    isEnabled: () => true,
    db: () => ({
      ref: (p) => ({
        transaction: async (fn) => {
          const next = fn(data[p] === undefined ? null : JSON.parse(JSON.stringify(data[p])));
          if (next === undefined) return { committed: false, snapshot: { val: () => data[p] ?? null } };
          if (next === null) delete data[p];
          else data[p] = next;
          return { committed: true, snapshot: { val: () => data[p] ?? null } };
        },
      }),
    }),
  };
}
const logger = { warn() {}, log() {}, error() {} };

test('una instancia tiene el candado; la otra espera hasta que lo libere', async () => {
  const fb = fakeFirebase();
  const vieja = new SessionLock(fb, logger, 45_000, 'vieja');
  const nueva = new SessionLock(fb, logger, 45_000, 'nueva');
  assert.strictEqual(await vieja.acquire('session:villa mayra'), true);
  assert.strictEqual(await nueva.acquire('session:villa mayra'), false);
  // Otra sesión (otro conjunto) es independiente.
  assert.strictEqual(await nueva.acquire('session'), true);
  await vieja.release('session:villa mayra');
  assert.strictEqual(await nueva.acquire('session:villa mayra'), true);
  assert.strictEqual(fb.data[`${LOCK_ROOT}/session:villa mayra`].owner, 'nueva');
});

test('si la dueña muere sin liberar, el candado vence y otra lo toma', async () => {
  const fb = fakeFirebase();
  let t = 1_000_000;
  const now = () => t;
  const a = new SessionLock(fb, logger, 45_000, 'a');
  const b = new SessionLock(fb, logger, 45_000, 'b');
  assert.strictEqual(await a.acquire('session', now), true);
  t += 30_000;
  assert.strictEqual(await b.acquire('session', now), false);
  t += 16_000; // 46 s sin renovar
  assert.strictEqual(await b.acquire('session', now), true);
  // La vieja detecta que lo perdió al renovar.
  assert.strictEqual(await a.renew('session', now), false);
  // Y liberar no borra el candado ajeno.
  await a.release('session');
  assert.strictEqual(fb.data[`${LOCK_ROOT}/session`].owner, 'b');
});

test('renovar mantiene el candado vigente', async () => {
  const fb = fakeFirebase();
  let t = 0;
  const now = () => t;
  const a = new SessionLock(fb, logger, 45_000, 'a');
  const b = new SessionLock(fb, logger, 45_000, 'b');
  await a.acquire('session', now);
  for (let i = 0; i < 5; i++) {
    t += 15_000;
    assert.strictEqual(await a.renew('session', now), true);
    assert.strictEqual(await b.acquire('session', now), false);
  }
});

test('sin Firebase no hay con quién competir', async () => {
  const lock = new SessionLock({ isEnabled: () => false, db: () => null }, logger);
  assert.strictEqual(await lock.acquire('session'), true);
  assert.strictEqual(await lock.renew('session'), true);
});

test('error de red al tomar => no conecta (más seguro esperar)', async () => {
  const fb = { isEnabled: () => true, db: () => ({ ref: () => ({ transaction: async () => { throw new Error('red'); } }) }) };
  const lock = new SessionLock(fb, logger);
  assert.strictEqual(await lock.acquire('session'), false);
  assert.strictEqual(await lock.renew('session'), true, 'renovar con error de red no suelta el candado');
});
