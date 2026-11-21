// Precios de los planes según el número de unidades del conjunto.
// Ejecutar: npm run test:wsp (compila y corre con el runner nativo de Node).
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const {
  RANGOS_DEFAULT,
  normUnidades,
  normRangos,
  validarRangos,
  precioPara,
  montoPorCiclo,
} = require(path.join(__dirname, '../dist/plans/pricing.js'));

const premium = { precioMensual: 360000, rangos: RANGOS_DEFAULT.premium, esEspecial: false };

test('cada rango cobra su precio, incluidos los bordes', () => {
  assert.deepStrictEqual(precioPara(premium, 1), { precioMensual: 270000, aLaMedida: false, rango: { desde: 1, hasta: 50 } });
  assert.strictEqual(precioPara(premium, 50).precioMensual, 270000);
  assert.deepStrictEqual(precioPara(premium, 51), { precioMensual: 360000, aLaMedida: false, rango: { desde: 51, hasta: 150 } });
  assert.strictEqual(precioPara(premium, 150).precioMensual, 360000);
  assert.strictEqual(precioPara(premium, 151).precioMensual, 500000);
  assert.strictEqual(precioPara(premium, 300).precioMensual, 500000);
});

test('más de 300 unidades es a la medida', () => {
  assert.deepStrictEqual(precioPara(premium, 301), { precioMensual: 0, aLaMedida: true, rango: null });
});

test('conjunto sin unidades usa el precio de referencia del plan', () => {
  assert.deepStrictEqual(precioPara(premium, 0), { precioMensual: 360000, aLaMedida: false, rango: null });
  assert.strictEqual(precioPara(premium, undefined).precioMensual, 360000);
  assert.strictEqual(precioPara(premium, 'abc').precioMensual, 360000);
});

test('los planes especiales cobran su precio fijo aunque tengan unidades', () => {
  const especial = { precioMensual: 250000, rangos: RANGOS_DEFAULT.premium, esEspecial: true };
  assert.strictEqual(precioPara(especial, 20).precioMensual, 250000);
  assert.strictEqual(precioPara(especial, 900).aLaMedida, false);
});

test('rangos que vienen de RTDB como objeto y desordenados', () => {
  const plan = { precioMensual: 1, rangos: { 0: { hasta: 300, precioMensual: 3 }, 1: { hasta: 50, precioMensual: 1 } } };
  assert.strictEqual(precioPara(plan, 10).precioMensual, 1);
  assert.strictEqual(precioPara(plan, 60).precioMensual, 3);
});

test('normUnidades acepta solo enteros 1..10000', () => {
  assert.strictEqual(normUnidades('120'), 120);
  assert.strictEqual(normUnidades(12.7), 12);
  assert.strictEqual(normUnidades(0), 0);
  assert.strictEqual(normUnidades(-5), 0);
  assert.strictEqual(normUnidades(10001), 0);
  assert.strictEqual(normUnidades(''), 0);
});

test('validarRangos rechaza tablas vacías, precios en 0 y máximos repetidos', () => {
  assert.strictEqual(validarRangos(RANGOS_DEFAULT.basico), null);
  assert.ok(validarRangos([]));
  assert.ok(validarRangos([{ hasta: 50, precioMensual: 0 }]));
  assert.ok(validarRangos([{ hasta: 50, precioMensual: 1 }, { hasta: 50, precioMensual: 2 }]));
  assert.strictEqual(normRangos([{ hasta: 50, precioMensual: 1 }, { hasta: 50, precioMensual: 2 }]).length, 1);
});

test('montoPorCiclo aplica el descuento anual', () => {
  assert.strictEqual(montoPorCiclo(130000, 'mensual', 0.1), 130000);
  assert.strictEqual(montoPorCiclo(130000, 'anual', 0.1), 1404000);
  assert.strictEqual(montoPorCiclo(130000, 'anual', 0), 1560000);
  assert.strictEqual(montoPorCiclo(130000, 'anual', undefined), 1404000);
});

const { claveUnidad, contarUnidades, unidadesInfo } = require(path.join(__dirname, '../dist/plans/pricing.js'));

test('claveUnidad trata igual "Casa 5", "casa #5" y "5"', () => {
  assert.strictEqual(claveUnidad('Casa 5'), '5');
  assert.strictEqual(claveUnidad('casa #5'), '5');
  assert.strictEqual(claveUnidad('Torre 1 Apto 101'), claveUnidad('T1-101'.replace('T', '')));
  assert.strictEqual(claveUnidad('Apartamento 302-B'), '302b');
  assert.strictEqual(claveUnidad(''), '');
});

test('contarUnidades: solo propietarios, parcelas repetidas cuentan una vez, sin parcela cuenta aparte', () => {
  const usuarios = [
    { rol: 'propietario', parcela: 'Casa 5' },
    { rol: 'Propietario', parcela: 'casa #5' }, // misma unidad
    { rol: 'propietario', parcela: '6' },
    { rol: 'propietario', parcela: '' }, // sin parcela: cuenta
    { rol: 'propietario' }, // sin parcela: cuenta
    { rol: 'vigilante', parcela: '7' }, // no es propietario
    { rol: 'admin', parcela: '8' },
  ];
  assert.strictEqual(contarUnidades(usuarios), 4);
  assert.strictEqual(contarUnidades([]), 0);
});

test('se cobra con el mayor entre declaradas y reales', () => {
  assert.deepStrictEqual(unidadesInfo(40, 63), { declaradas: 40, reales: 63, efectivas: 63 });
  assert.deepStrictEqual(unidadesInfo(120, 30), { declaradas: 120, reales: 30, efectivas: 120 });
  assert.deepStrictEqual(unidadesInfo(0, 25), { declaradas: 0, reales: 25, efectivas: 25 });
  // 40 declaradas pero 63 reales: pasa del rango "Hasta 50" a "51–150".
  assert.strictEqual(precioPara(premium, unidadesInfo(40, 63).efectivas).precioMensual, 360000);
});
