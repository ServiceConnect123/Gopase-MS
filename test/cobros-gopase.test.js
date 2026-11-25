// Cobros de la plataforma: cuentas de GoPase y medios de pago habilitados.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const r = require(path.join(__dirname, '../dist/cuota/cuota.rules.js'));
const a = require(path.join(__dirname, '../dist/billing/app-config.service.js'));

test('la cuenta única antigua (datosPago) pasa a ser la cuenta principal', () => {
  const b = a.cuentaDeDatosPago({ tipo: 'cuenta', banco: 'Bancolombia', numeroCuenta: '123-456789-12', tipoCuenta: 'corriente', titular: 'GoPase SAS' });
  assert.strictEqual(b.tipo, 'banco');
  assert.strictEqual(b.banco, 'bancolombia');
  assert.strictEqual(b.numero, '12345678912');
  assert.strictEqual(b.tipoCuenta, 'Corriente');
  assert.strictEqual(b.principal, true);
  const k = a.cuentaDeDatosPago({ tipo: 'breb', llave: '3104211537', titular: 'Wilmer' });
  assert.strictEqual(k.tipo, 'breb');
  assert.strictEqual(k.tipoLlave, 'Celular');
  assert.strictEqual(a.cuentaDeDatosPago(null), null);
  assert.strictEqual(a.cuentaDeDatosPago({ tipo: 'breb', llave: '' }), null);
});

test('bancoPorNombre reconoce nombres libres', () => {
  assert.strictEqual(r.bancoPorNombre('Banco de Bogotá'), 'bogota');
  assert.strictEqual(r.bancoPorNombre('davivienda'), 'davivienda');
  assert.strictEqual(r.bancoPorNombre('Nequi'), 'nequi');
  assert.strictEqual(r.bancoPorNombre('Banco Inventado XYZ'), '');
});

test('agregar, hacer principal, desactivar y eliminar cuentas', () => {
  let res = r.opGuardarMetodo([], { tipo: 'breb', llave: '3104211537', titular: 'GoPase' }, undefined, 'g1');
  assert.ok(res.ok);
  assert.strictEqual(res.lista[0].principal, true, 'la primera es principal');
  res = r.opGuardarMetodo(res.lista, { tipo: 'banco', banco: 'bancolombia', numero: '20931234567', nit: '901234567', titular: 'GoPase', principal: true }, undefined, 'g2');
  assert.ok(res.ok);
  assert.deepStrictEqual(res.lista.map((m) => [m.id, m.principal]), [['g1', false], ['g2', true]]);
  const dup = r.opGuardarMetodo(res.lista, { tipo: 'breb', llave: ' 310 4211537 ', titular: 'X' }, undefined, 'g3');
  assert.strictEqual(dup.ok, false);

  const off = r.opCambiarMetodo(res.lista, 'g2', { activo: false }, 'los conjuntos');
  assert.ok(off.ok);
  assert.match(off.aviso, /Bre-B/);
  assert.strictEqual(off.lista.find((m) => m.id === 'g1').principal, true);
  const unico = r.opCambiarMetodo(off.lista, 'g1', { activo: false }, 'los conjuntos');
  assert.strictEqual(unico.ok, false);
  assert.match(unico.message, /los conjuntos/);
  assert.strictEqual(r.opEliminarMetodo(off.lista, 'g1').ok, false, 'no se elimina el único activo');
  assert.ok(r.opEliminarMetodo(off.lista, 'g2').ok);
});

test('la cuenta principal se guarda también con la forma antigua', () => {
  const lista = [
    r.normalizarMetodo({ id: 'g1', tipo: 'breb', llave: 'pagos@gopase.co', titular: 'GoPase', activo: true, principal: false }),
    r.normalizarMetodo({ id: 'g2', tipo: 'banco', banco: 'davivienda', numero: '0550123456', nit: '901', titular: 'GoPase SAS', activo: true, principal: true }),
  ];
  assert.deepStrictEqual(a.datosPagoDeCuentas(lista), { tipo: 'cuenta', llave: '', banco: 'Davivienda', numeroCuenta: '0550123456', tipoCuenta: 'ahorro', titular: 'GoPase SAS' });
  assert.strictEqual(a.datosPagoDeCuentas([]), null);
});

test('medios: lo no guardado queda habilitado', () => {
  assert.deepStrictEqual(a.normalizarMedios(null), { tarjeta: true, pse: true, nequi: true, transferencia: true });
  assert.deepStrictEqual(a.normalizarMedios({ nequi: false }), { tarjeta: true, pse: true, nequi: false, transferencia: true });
});
