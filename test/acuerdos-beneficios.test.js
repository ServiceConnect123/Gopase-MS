// Acuerdos (cobertura de meses, incumplimiento) y beneficios de meses.
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
    liveValues: async (p) => Object.values(getAt(p) || {}),
    db: () => ({
      ref: (p = '') => ({
        get: async () => { const v = getAt(p); return { exists: () => v !== undefined, val: () => v }; },
        update: async (vals) => { for (const [k, v] of Object.entries(vals)) setAt(p ? `${p}/${k}` : k, v); },
      }),
    }),
  };
}
const svc = (fb) => new PaymentsService(fb, {}, {}, {});
const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
const hoy = new Date();
const Y = hoy.getFullYear();
const pagosDe = (fb, u) => Object.values(fb.data.mirror.pagos || {}).filter((p) => p.usuario === u);
const confirmados = (fb, u) => pagosDe(fb, u).filter((p) => p.estado === 'Confirmado').map((p) => p.concepto).sort();

const base = (extraAcuerdo = {}) => ({
  mirror: {
    usuarios: { uid1: { usuario: 'carlos', conjunto: 'C', fechaIngreso: `01/01/${Y}` } },
    conjuntos: { c: { nombre: 'C', cuotaMonto: '100000' } },
    pagos: {
      p0: { id: 'p0', usuario: 'carlos', concepto: `Administración Enero ${Y}`, valor: '100000', estado: 'Confirmado', referencia: '', tipoRecaudo: 'Administración' },
    },
    acuerdos: {
      agr_1: {
        id: 'agr_1', usuario: 'carlos', conjunto: 'C', estado: 'activo', abonoInicialEstado: 'pendiente', abonoInicialMonto: 60000,
        mesesCubiertos: [{ mes: 'Febrero', anio: Y, monto: 100000 }, { mes: 'Marzo', anio: Y, monto: 100000 }, { mes: 'Abril', anio: Y, monto: 100000 }],
        cuotas: [{ n: 1, monto: 120000, estado: 'pendiente' }, { n: 2, monto: 120000, estado: 'pendiente' }],
        ...extraAcuerdo,
      },
    },
    beneficios: {},
  },
});

test('CA1: al acogerse, los meses del acuerdo quedan al día (sin dinero duplicado) y el abono queda por confirmar', async () => {
  const fb = fakeFirebase(base());
  const r = await svc(fb).acogerseAcuerdo({ acuerdoId: 'agr_1', usuario: 'carlos', comprobanteUrl: 'https://x/img.jpg' });
  assert.ok(r.success, r.message);
  assert.deepStrictEqual(r.mesesCubiertos, [`Febrero ${Y}`, `Marzo ${Y}`, `Abril ${Y}`]);
  const conf = confirmados(fb, 'carlos');
  for (const m of ['Enero', 'Febrero', 'Marzo', 'Abril']) assert.ok(conf.includes(`Administración ${m} ${Y}`), m);
  const cubiertos = pagosDe(fb, 'carlos').filter((p) => p.cubiertoPorAcuerdo);
  assert.strictEqual(cubiertos.length, 3);
  assert.ok(cubiertos.every((p) => p.valor === '0'), 'los meses cubiertos no suman dinero');
  const abono = pagosDe(fb, 'carlos').find((p) => p.concepto === 'Abono inicial acuerdo de pago');
  assert.strictEqual(abono.estado, 'Pendiente');
  assert.strictEqual(fb.data.mirror.acuerdos.agr_1.abonoInicialEstado, 'en_revision');
});

test('acogerse sin comprobante, o dos veces, se rechaza; otro usuario no puede acogerse', async () => {
  const fb = fakeFirebase(base());
  const s = svc(fb);
  assert.strictEqual((await s.acogerseAcuerdo({ acuerdoId: 'agr_1', usuario: 'carlos' })).success, false);
  assert.strictEqual((await s.acogerseAcuerdo({ acuerdoId: 'agr_1', usuario: 'otro', comprobanteUrl: 'u' })).success, false);
  assert.ok((await s.acogerseAcuerdo({ acuerdoId: 'agr_1', usuario: 'carlos', comprobanteUrl: 'u' })).success);
  assert.strictEqual((await s.acogerseAcuerdo({ acuerdoId: 'agr_1', usuario: 'carlos', comprobanteUrl: 'u' })).success, false);
  assert.strictEqual(pagosDe(fb, 'carlos').filter((p) => p.cubiertoPorAcuerdo).length, 3, 'no duplica la cobertura');
});

test('rechazar el abono deshace la cobertura de meses', async () => {
  const fb = fakeFirebase(base());
  const s = svc(fb);
  const r = await s.acogerseAcuerdo({ acuerdoId: 'agr_1', usuario: 'carlos', comprobanteUrl: 'u' });
  const rev = await s.reviewPayment({ id: r.pagoId, estado: 'Rechazado' });
  assert.match(rev.reservaMsg, /3 mes\(es\) vuelven a mora/);
  assert.strictEqual(pagosDe(fb, 'carlos').filter((p) => p.cubiertoPorAcuerdo).length, 0);
  assert.strictEqual(fb.data.mirror.acuerdos.agr_1.abonoInicialEstado, 'pendiente');
});

test('CA2: finalizar por incumplimiento conserva los meses que cubre lo pagado y el resto vuelve a mora', async () => {
  const fb = fakeFirebase(base());
  const s = svc(fb);
  const r = await s.acogerseAcuerdo({ acuerdoId: 'agr_1', usuario: 'carlos', comprobanteUrl: 'u' });
  await s.reviewPayment({ id: r.pagoId, estado: 'Confirmado' }); // abono 60.000
  await s.createPayments({ usuario: 'carlos', montoPerMonth: 120000, year: Y, estado: 'Confirmado', referencia: 'ACUERDO:agr_1 | CUOTA:1', concepto: 'c1' });
  // Pagado: 60.000 + 120.000 = 180.000 => alcanza para Febrero (100.000), no para Marzo.
  const inc = await s.incumplirAcuerdo({ acuerdoId: 'agr_1', motivo: '2 cuotas sin pagar' });
  assert.ok(inc.success);
  assert.deepStrictEqual(inc.conservados, [`Febrero ${Y}`]);
  assert.deepStrictEqual(inc.revertidos.sort(), [`Abril ${Y}`, `Marzo ${Y}`]);
  const conf = confirmados(fb, 'carlos');
  assert.ok(conf.includes(`Administración Febrero ${Y}`));
  assert.ok(!conf.includes(`Administración Marzo ${Y}`));
  const a = fb.data.mirror.acuerdos.agr_1;
  assert.strictEqual(a.estado, 'incumplido');
  assert.strictEqual(a.motivoIncumplimiento, '2 cuotas sin pagar');
  assert.strictEqual((await s.incumplirAcuerdo({ acuerdoId: 'agr_1' })).success, false, 'no se finaliza dos veces');
});

test('CA4/CA5: aprobar el pago de un beneficio cubre N meses desde el último mes pagado', async () => {
  const seed = base();
  seed.mirror.beneficios.b1 = { id: 'b1', nombre: 'Trimestre', tipo: 'plan_meses', mesesCubiertos: 3, montoPago: 250000, solicitantes: ['carlos'], aprobados: [], solicitudes: [{ usuario: 'carlos', pagoId: 'pb', estado: 'pendiente' }] };
  seed.mirror.pagos.pb = { id: 'pb', usuario: 'carlos', concepto: 'Beneficio: Trimestre', valor: '250000', estado: 'Pendiente', referencia: 'IMG:u | BENEFICIO:b1', conjunto: 'C', tipoRecaudo: 'Administración' };
  const fb = fakeFirebase(seed);
  const rev = await svc(fb).reviewPayment({ id: 'pb', estado: 'Confirmado' });
  assert.ok(rev.success);
  // Pagado hasta Enero => cubre Febrero, Marzo y Abril.
  assert.match(rev.reservaMsg, new RegExp(`Febrero ${Y} a Abril ${Y}`));
  const conf = confirmados(fb, 'carlos');
  for (const m of ['Febrero', 'Marzo', 'Abril']) assert.ok(conf.includes(`Administración ${m} ${Y}`), m);
  const del = pagosDe(fb, 'carlos').filter((p) => String(p.referencia).includes('BENEFICIO:b1'));
  assert.strictEqual(del.reduce((t, p) => t + Number(p.valor), 0), 250000, 'el monto se reparte sin duplicarse');
  const b = fb.data.mirror.beneficios.b1;
  assert.deepStrictEqual(b.aprobados, ['carlos']);
  assert.strictEqual(b.solicitudes[0].estado, 'aprobada');
  // Idempotente: aprobar otra vez no crea más meses.
  await svc(fb).reviewPayment({ id: 'pb', estado: 'Confirmado' });
  assert.strictEqual(pagosDe(fb, 'carlos').filter((p) => String(p.referencia).includes('BENEFICIO:b1')).length, 3);
});

test('rechazar el pago de un beneficio marca la solicitud como rechazada', async () => {
  const seed = base();
  seed.mirror.beneficios.b1 = { id: 'b1', tipo: 'plan_meses', mesesCubiertos: 2, solicitantes: ['carlos'], solicitudes: [{ usuario: 'carlos', pagoId: 'pb', estado: 'pendiente' }] };
  seed.mirror.pagos.pb = { id: 'pb', usuario: 'carlos', concepto: 'Beneficio', valor: '100', estado: 'Pendiente', referencia: 'BENEFICIO:b1' };
  const fb = fakeFirebase(seed);
  await svc(fb).reviewPayment({ id: 'pb', estado: 'Rechazado' });
  assert.strictEqual(fb.data.mirror.beneficios.b1.solicitudes[0].estado, 'rechazada');
  assert.deepStrictEqual(fb.data.mirror.beneficios.b1.solicitantes, []);
});
