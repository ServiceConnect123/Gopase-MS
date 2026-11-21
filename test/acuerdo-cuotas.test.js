// Pagos de cuotas de acuerdos: Pagos y Acuerdos deben quedar sincronizados.
// Ejecutar: npm run test:wsp (compila y corre con el runner nativo de Node).
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { PaymentsService } = require(path.join(__dirname, '../dist/payments/payments.service.js'));

function fakeFirebase(seed) {
  const data = JSON.parse(JSON.stringify(seed));
  const parts = (p) => String(p || '').split('/').filter(Boolean);
  const getAt = (p) => parts(p).reduce((o, k) => (o == null ? undefined : o[k]), data);
  const setAt = (p, v) => {
    const ks = parts(p);
    let o = data;
    for (const k of ks.slice(0, -1)) o = o[k] ??= {};
    if (v === null) delete o[ks.at(-1)];
    else o[ks.at(-1)] = JSON.parse(JSON.stringify(v));
  };
  return {
    data,
    isEnabled: () => true,
    db: () => ({
      ref: (p = '') => ({
        get: async () => { const v = getAt(p); return { exists: () => v !== undefined, val: () => v }; },
        update: async (vals) => { for (const [k, v] of Object.entries(vals)) setAt(p ? `${p}/${k}` : k, v); },
      }),
    }),
  };
}

const acuerdo = () => ({
  mirror: {
    acuerdos: {
      agr_1: {
        id: 'agr_1', estado: 'activo', saldoPendiente: 720000,
        cuotas: [
          { n: 1, monto: 240000, estado: 'pagado', pagoId: 'x1' },
          { n: 2, monto: 240000, estado: 'pendiente', pagoId: null },
          { n: 3, monto: 240000, estado: 'pendiente', pagoId: null },
        ],
      },
    },
    pagos: {},
  },
});
const svc = (fb) => new PaymentsService(fb, {}, {}, {});
const cuota = (fb, n) => fb.data.mirror.acuerdos.agr_1.cuotas[n - 1];

test('el propietario reporta la cuota: queda en revisión y el pago en Pagos como Pendiente', async () => {
  const fb = fakeFirebase(acuerdo());
  const r = await svc(fb).createPayments({
    usuario: 'carlos', montoPerMonth: 240000, year: 2026, estado: 'Pendiente',
    referencia: 'IMG:https://x | ACUERDO:agr_1 | CUOTA:2', concepto: 'Acuerdo de pago · cuota 2 de 3',
  });
  assert.ok(r.success);
  const pago = fb.data.mirror.pagos[r.ids[0]];
  assert.strictEqual(pago.estado, 'Pendiente');
  assert.strictEqual(pago.concepto, 'Acuerdo de pago · cuota 2 de 3');
  assert.strictEqual(cuota(fb, 2).estado, 'en_revision');
  assert.strictEqual(cuota(fb, 2).pagoId, r.ids[0]);
  assert.strictEqual(fb.data.mirror.acuerdos.agr_1.saldoPendiente, 480000, 'en revisión aún cuenta en el saldo');
});

test('confirmar en Pagos marca la cuota pagada y recalcula el saldo', async () => {
  const fb = fakeFirebase(acuerdo());
  const s = svc(fb);
  const r = await s.createPayments({ usuario: 'carlos', montoPerMonth: 240000, year: 2026, estado: 'Pendiente', referencia: 'ACUERDO:agr_1 | CUOTA:2', concepto: 'c' });
  const rev = await s.reviewPayment({ id: r.ids[0], estado: 'Confirmado' });
  assert.ok(rev.success);
  assert.match(rev.reservaMsg, /Cuota 2 del acuerdo pagada/);
  assert.strictEqual(cuota(fb, 2).estado, 'pagado');
  assert.strictEqual(fb.data.mirror.acuerdos.agr_1.saldoPendiente, 240000);
  assert.strictEqual(fb.data.mirror.acuerdos.agr_1.estado, 'activo');
  // No toca el abono inicial.
  assert.strictEqual(fb.data.mirror.acuerdos.agr_1.abonoInicialEstado, undefined);
});

test('rechazar en Pagos devuelve la cuota a pendiente', async () => {
  const fb = fakeFirebase(acuerdo());
  const s = svc(fb);
  const r = await s.createPayments({ usuario: 'carlos', montoPerMonth: 240000, year: 2026, estado: 'Pendiente', referencia: 'ACUERDO:agr_1 | CUOTA:3', concepto: 'c' });
  await s.reviewPayment({ id: r.ids[0], estado: 'Rechazado' });
  assert.strictEqual(cuota(fb, 3).estado, 'pendiente');
  assert.strictEqual(cuota(fb, 3).pagoId, null);
});

test('el admin registra las cuotas ya confirmadas: la última liquida el acuerdo', async () => {
  const fb = fakeFirebase(acuerdo());
  const s = svc(fb);
  await s.createPayments({ usuario: 'carlos', montoPerMonth: 240000, year: 2026, estado: 'Confirmado', referencia: 'ACUERDO:agr_1 | CUOTA:2', concepto: 'c' });
  assert.strictEqual(fb.data.mirror.acuerdos.agr_1.estado, 'activo');
  await s.createPayments({ usuario: 'carlos', montoPerMonth: 240000, year: 2026, estado: 'Confirmado', referencia: 'ACUERDO:agr_1 | CUOTA:3', concepto: 'c' });
  assert.strictEqual(cuota(fb, 3).estado, 'pagado');
  assert.strictEqual(fb.data.mirror.acuerdos.agr_1.saldoPendiente, 0);
  assert.strictEqual(fb.data.mirror.acuerdos.agr_1.estado, 'liquidado');
});

test('el abono inicial (sin CUOTA) sigue activando el acuerdo como antes', async () => {
  const seed = acuerdo();
  seed.mirror.acuerdos.agr_1.abonoInicialEstado = 'en_revision';
  const fb = fakeFirebase(seed);
  const s = svc(fb);
  const r = await s.createPayments({ usuario: 'carlos', montoPerMonth: 360000, year: 2026, estado: 'Pendiente', referencia: 'ACUERDO:agr_1', concepto: 'Abono inicial' });
  await s.reviewPayment({ id: r.ids[0], estado: 'Confirmado' });
  assert.strictEqual(fb.data.mirror.acuerdos.agr_1.abonoInicialEstado, 'aceptado');
  assert.strictEqual(cuota(fb, 2).estado, 'pendiente');
});
