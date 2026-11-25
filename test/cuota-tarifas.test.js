// Tarifas por unidad y métodos de recaudo.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const r = require(path.join(__dirname, '../dist/cuota/cuota.rules.js'));
const { CuotaService } = require(path.join(__dirname, '../dist/cuota/cuota.service.js'));

const conjBase = () => ({
  id: 'c1', nombre: 'Villa Sol', cuotaMonto: '60000', llaveBreB: '3214560897',
});

test('sin métodos configurados, la llave Bre-B existente es el método principal', () => {
  const l = r.listaMetodos(conjBase());
  assert.strictEqual(l.length, 1);
  assert.strictEqual(l[0].tipo, 'breb');
  assert.strictEqual(l[0].llave, '3214560897');
  assert.strictEqual(l[0].tipoLlave, 'Celular');
  assert.strictEqual(l[0].principal, true);
  assert.deepStrictEqual(r.listaMetodos({ nombre: 'X' }), []);
});

test('la cuota actual es la tarifa base; tarifa asignada solo si está activa', () => {
  const c = Object.assign(conjBase(), { tarifas: { t1: { nombre: 'Torre B', valor: 72000, activo: true }, t2: { nombre: 'PH', valor: 110000, activo: false } } });
  assert.deepStrictEqual(r.tarifaDeUsuario(c, {}), { id: null, nombre: 'Tarifa base', valor: 60000, esBase: true });
  assert.strictEqual(r.tarifaDeUsuario(c, { tarifaId: 't1' }).valor, 72000);
  assert.strictEqual(r.tarifaDeUsuario(c, { tarifaId: 't2' }).esBase, true, 'inactiva → base');
  assert.strictEqual(r.tarifaDeUsuario(c, { tarifaId: 'nope' }).esBase, true);
});

test('validarTarifa: nombre único, no «tarifa base», valor > 0', () => {
  const ex = [{ id: 't1', nombre: 'Torre B', valor: 1, desc: '', activo: true }];
  assert.strictEqual(r.validarTarifa({ nombre: '', valor: 1 }, ex).ok, false);
  assert.strictEqual(r.validarTarifa({ nombre: 'torre b', valor: 1 }, ex).ok, false);
  assert.strictEqual(r.validarTarifa({ nombre: 'Torre B', valor: 5 }, ex, 't1').ok, true, 'editar la misma');
  assert.strictEqual(r.validarTarifa({ nombre: 'Tarifa Base', valor: 1 }, ex).ok, false);
  assert.strictEqual(r.validarTarifa({ nombre: 'Local', valor: '0' }, ex).ok, false);
  const ok = r.validarTarifa({ nombre: ' Local ', valor: '95.000', desc: 'x' }, ex);
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.tarifa.valor, 95000);
  assert.strictEqual(ok.tarifa.nombre, 'Local');
});

test('ajustarPrincipal: siempre un principal activo', () => {
  const l = [
    { id: 'a', activo: false, principal: true }, { id: 'b', activo: true, principal: false }, { id: 'c', activo: true, principal: false },
  ];
  assert.deepStrictEqual(r.ajustarPrincipal(l).map((m) => m.principal), [false, true, false]);
  assert.deepStrictEqual(r.ajustarPrincipal(l, 'c').map((m) => m.principal), [false, false, true]);
  assert.deepStrictEqual(r.ajustarPrincipal(l, 'a').map((m) => m.principal), [false, true, false], 'inactivo no puede ser principal');
});

test('destinos válidos y métodos públicos solo de los activos', () => {
  const l = [
    { id: 'a', tipo: 'breb', llave: '321', activo: true, principal: true, titular: 'X' },
    { id: 'b', tipo: 'banco', banco: 'bancolombia', numero: '2093', tipoCuenta: 'Ahorros', nit: '9', activo: true, principal: false, titular: 'X' },
    { id: 'c', tipo: 'banco', banco: 'davivienda', numero: '4588', activo: false, principal: false, titular: 'X' },
  ];
  assert.deepStrictEqual(r.destinosValidos(l), ['321', '2093']);
  const pub = r.metodosPublicos(l);
  assert.strictEqual(pub.length, 2);
  assert.strictEqual(pub[1].bancoNombre, 'Bancolombia');
  assert.strictEqual(r.llaveCompat(l), '321');
});

test('resumenTarifas cuenta unidades y recaudo esperado', () => {
  const c = Object.assign(conjBase(), { tarifas: { t1: { nombre: 'Torre B', valor: 72000, activo: true } } });
  const us = [
    { rol: 'propietario', tarifaId: 't1' }, { rol: 'propietario' }, { rol: 'propietario' },
    { rol: 'admin', parcela: 'Apto 1' }, { rol: 'admin' }, { rol: 'vigilante' }, { rol: 'inquilino', parcela: 'x' }, { rol: 'desactivado', parcela: 'y' },
  ];
  const res = r.resumenTarifas(c, us);
  assert.strictEqual(res.unidades, 4, 'propietarios + admin con unidad');
  assert.strictEqual(res.base.unidades, 3);
  assert.strictEqual(res.tarifas[0].unidades, 1);
  assert.strictEqual(res.esperado, 72000 + 3 * 60000);
});

// ---------------------------------------------------------------------------
// Servicio con Firebase simulado
// ---------------------------------------------------------------------------

function fakeFirebase(data) {
  const parts = (p) => String(p || '').split('/').filter(Boolean);
  const getAt = (p) => parts(p).reduce((o, k) => (o == null ? undefined : o[k]), data);
  const setAt = (p, v) => {
    const ks = parts(p);
    let o = data;
    ks.slice(0, -1).forEach((k) => { o[k] = o[k] || {}; o = o[k]; });
    if (v === null) delete o[ks[ks.length - 1]];
    else o[ks[ks.length - 1]] = v;
  };
  return {
    data,
    isEnabled: () => true,
    liveVal: async (p) => getAt(p) ?? null,
    liveValues: async (p) => Object.values(getAt(p) || {}),
    db: () => ({ ref: (p = '') => ({ update: async (vals) => { for (const [k, v] of Object.entries(vals)) setAt(`${p}/${k}`, v); } }) }),
  };
}

function escenario() {
  const fb = fakeFirebase({
    mirror: {
      conjuntos: { c1: conjBase() },
      usuarios: {
        ana: { usuario: 'ana', nombre: 'Ana', rol: 'propietario', conjunto: 'Villa Sol' },
        beto: { usuario: 'beto', nombre: 'Beto', rol: 'propietario', conjunto: 'Villa Sol' },
        otro: { usuario: 'otro', rol: 'propietario', conjunto: 'Otro' },
        inq: { usuario: 'inq', rol: 'inquilino', conjunto: 'Villa Sol', inquilino: { propietario: 'ana' } },
      },
    },
  });
  return { fb, svc: new CuotaService(fb) };
}

test('crear tarifa, asignarla y desactivarla libera las unidades', async () => {
  const { fb, svc } = escenario();
  const t = await svc.guardarTarifa('Villa Sol', { nombre: 'Torre B', valor: '72.000', desc: 'Ascensor' });
  assert.strictEqual(t.success, true);
  const dup = await svc.guardarTarifa('Villa Sol', { nombre: 'torre b', valor: 1 });
  assert.strictEqual(dup.success, false);

  assert.strictEqual((await svc.asignar('Villa Sol', 'ana', t.id)).success, true);
  assert.strictEqual(fb.data.mirror.usuarios.ana.tarifaId, t.id);
  assert.strictEqual((await svc.asignar('Villa Sol', 'otro', t.id)).success, false, 'otro conjunto');
  assert.strictEqual((await svc.tarifaDe('ana')).valor, 72000);
  assert.strictEqual((await svc.tarifaDe('inq')).valor, 72000, 'inquilino → tarifa de su propietario');
  assert.strictEqual((await svc.tarifaDe('beto')).valor, 60000);

  const cfg = await svc.getConfig('Villa Sol');
  assert.strictEqual(cfg.data.base.unidades, 1);
  assert.strictEqual(cfg.data.tarifas[0].unidades, 1);

  const off = await svc.guardarTarifa('Villa Sol', { activo: false }, t.id);
  assert.strictEqual(off.success, true);
  assert.strictEqual(off.liberadas, 1);
  assert.strictEqual(fb.data.mirror.usuarios.ana.tarifaId, undefined);
  assert.strictEqual((await svc.asignar('Villa Sol', 'beto', t.id)).success, false, 'inactiva no se asigna');
});

test('métodos: agregar banco, hacer principal, no desactivar el único activo, llave compatible', async () => {
  const { fb, svc } = escenario();
  const conj = () => fb.data.mirror.conjuntos.c1;
  const mal = await svc.guardarMetodo('Villa Sol', { tipo: 'banco', banco: 'bancolombia', numero: '12', titular: 'X', nit: '901' });
  assert.strictEqual(mal.success, false);
  const b = await svc.guardarMetodo('Villa Sol', { tipo: 'banco', banco: 'bancolombia', tipoCuenta: 'Ahorros', numero: '2093-4574-821', titular: 'Villa Sol PH', nit: '901.234.567-1' });
  assert.strictEqual(b.success, true, b.message);
  assert.strictEqual(b.metodos.length, 2, 'la llave existente se conserva');
  assert.strictEqual(conj().metodosRecaudo['breb-principal'].principal, true);
  assert.strictEqual(conj().metodosRecaudo[b.id].numero, '20934574821');

  const p = await svc.cambiarMetodo('Villa Sol', b.id, { principal: true });
  assert.strictEqual(p.success, true);
  assert.strictEqual(conj().metodosRecaudo[b.id].principal, true);
  assert.strictEqual(conj().llaveBreB, '3214560897', 'sigue la Bre-B activa');

  const off = await svc.cambiarMetodo('Villa Sol', b.id, { activo: false });
  assert.strictEqual(off.success, true);
  assert.ok(off.aviso);
  assert.strictEqual(conj().metodosRecaudo['breb-principal'].principal, true);
  const unico = await svc.cambiarMetodo('Villa Sol', 'breb-principal', { activo: false });
  assert.strictEqual(unico.success, false);

  const dup = await svc.guardarMetodo('Villa Sol', { tipo: 'breb', llave: '3214560897', titular: 'X' });
  assert.strictEqual(dup.success, false);
});
