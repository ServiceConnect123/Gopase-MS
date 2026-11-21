// "Al día" de los propietarios: la lista de Pagos debe dar lo MISMO que el
// reporte al día (que usan Home del vigilante y del admin).
// Ejecutar: npm run test:wsp (compila y corre con el runner nativo de Node).
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { PaymentsService } = require(path.join(__dirname, '../dist/payments/payments.service.js'));

const MONTHS = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
];

// Mes relativo a hoy (0 = actual, 1 = anterior...), con su año propio.
const mes = (offset) => {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth() - offset, 1);
  return { nombre: MONTHS[d.getMonth()], anio: d.getFullYear() };
};
const pago = (usuario, offset, estado = 'Confirmado') => {
  const m = mes(offset);
  return { usuario, concepto: `Administración ${m.nombre} ${m.anio}`, valor: 100000, estado, fecha: '', referencia: '' };
};

function fakeFirebase(usuarios, pagos) {
  const toObj = (arr) => Object.fromEntries(arr.map((v, i) => [`k${i}`, v]));
  const data = { mirror: { usuarios: toObj(usuarios), pagos: toObj(pagos), conjuntos: {} } };
  const at = (p) => String(p || '').split('/').filter(Boolean).reduce((o, k) => (o == null ? undefined : o[k]), data);
  return {
    isEnabled: () => true,
    liveValues: async (p) => Object.values(at(p) || {}),
    liveVal: async (p) => at(p) ?? null,
    db: () => ({ ref: (p = '') => ({ get: async () => { const v = at(p); return { exists: () => v !== undefined, val: () => v }; } }) }),
  };
}

const CONJ = 'Villa Test';
const prop = (usuario) => ({ usuario, nombre: usuario, rol: 'propietario', conjunto: CONJ, parcela: usuario, fechaIngreso: '' });

function escenario(diasGracia) {
  const usuarios = [
    prop('todo_pago'), // M-2, M-1 y actual
    prop('sin_actual'), // M-2 y M-1, no el actual: depende de la gracia
    prop('debe_m2'), // pagó M-1 y el actual, pero NO M-2 (antes Pagos lo daba al día)
    prop('debe_m1'), // pagó M-2, no M-1
    prop('nada'),
    { ...prop('vigilante1'), rol: 'vigilante' }, // no cuenta
  ];
  const pagos = [
    pago('todo_pago', 2), pago('todo_pago', 1), pago('todo_pago', 0),
    pago('sin_actual', 2), pago('sin_actual', 1),
    pago('debe_m2', 1), pago('debe_m2', 0),
    pago('debe_m1', 2),
    pago('nada', 1, 'Pendiente'), // pendiente no cuenta como pagado
  ];
  const properties = { getDiasGraciaPropietario: async () => diasGracia };
  return new PaymentsService(fakeFirebase(usuarios, pagos), properties, {}, {});
}

for (const diasGracia of [0, 180]) {
  test(`Pagos y el reporte al día coinciden (gracia ${diasGracia} días)`, async () => {
    const svc = escenario(diasGracia);
    const reporte = await svc.getAlDiaReport(CONJ, false);
    const lista = await svc.getAdminList(CONJ, new Date().getFullYear(), false);
    const enReporte = Object.fromEntries(reporte.propietarios.map((p) => [p.usuario, p.alDia]));
    const enPagos = Object.fromEntries(lista.map((p) => [p.username, p.isAlDia]));
    assert.deepStrictEqual(enPagos, enReporte);

    assert.strictEqual(enPagos.todo_pago, true);
    assert.strictEqual(enPagos.debe_m2, false, 'sin M-2 está en mora aunque haya pagado meses posteriores');
    assert.strictEqual(enPagos.debe_m1, false);
    assert.strictEqual(enPagos.nada, false);
    // Con 180 días de gracia el mes actual aún no se exige; con 0, sí (salvo el día 1).
    if (diasGracia === 180) assert.strictEqual(enPagos.sin_actual, true);
    if (diasGracia === 0 && new Date().getDate() > 1) assert.strictEqual(enPagos.sin_actual, false);
  });
}

test('el estado al día no cambia con el año elegido en Pagos', async () => {
  const svc = escenario(180);
  const anio = new Date().getFullYear();
  const actual = await svc.getAdminList(CONJ, anio, false);
  const anterior = await svc.getAdminList(CONJ, anio - 1, false);
  const mapa = (l) => Object.fromEntries(l.map((p) => [p.username, p.isAlDia]));
  assert.deepStrictEqual(mapa(anterior), mapa(actual));
});
