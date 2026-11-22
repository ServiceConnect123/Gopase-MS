// Roles y permisos: reglas, quién gestiona qué y limpieza de permisos.
// Ejecutar: npm run test:wsp (compila y corre con el runner nativo de Node).
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const reglas = require(path.join(__dirname, '../dist/roles/roles-rules.js'));
const { RolesService } = require(path.join(__dirname, '../dist/roles/roles.service.js'));
const { RolesController } = require(path.join(__dirname, '../dist/roles/roles.controller.js'));

function fakeFirebase(inicial = {}) {
  const data = JSON.parse(JSON.stringify(inicial));
  const partes = (p) => p.split('/').filter(Boolean);
  const leer = (p) => partes(p).reduce((o, k) => (o == null ? undefined : o[k]), data);
  const escribir = (p, v) => {
    const ks = partes(p);
    let o = data;
    ks.slice(0, -1).forEach((k) => { o[k] = o[k] || {}; o = o[k]; });
    if (v === undefined) delete o[ks[ks.length - 1]];
    else o[ks[ks.length - 1]] = JSON.parse(JSON.stringify(v));
  };
  const ref = (p) => ({
    get: async () => { const v = leer(p); return { exists: () => v !== undefined && v !== null, val: () => v }; },
    set: async (v) => escribir(p, v),
    remove: async () => escribir(p, undefined),
  });
  return { data, isEnabled: () => true, db: () => ({ ref }), liveVal: async (p) => leer(p) ?? null };
}

const BASE = {
  mirror: {
    usuarios: { admin1: { conjunto: 'Los Pinos' }, admin2: { conjunto: 'Otro' } },
    roles: {
      admin: { id: 'admin', nombre: 'admin', permisos: [{ path: '/app/payments', status: true }] },
      propietario: { id: 'propietario', nombre: 'propietario', permisos: [] },
      superAdmin: { id: 'superAdmin', nombre: 'superAdmin', permisos: [] },
      c1: { id: 'c1', nombre: 'Contador', permisos: [], conjunto: 'Los Pinos' },
      c2: { id: 'c2', nombre: 'Portero nocturno', permisos: [], conjunto: 'Otro' },
    },
  },
};
const req = (sub, rol) => ({ user: { sub, rol } });
function armar() {
  const fb = fakeFirebase(BASE);
  const svc = new RolesService(fb);
  return { fb, svc, ctl: new RolesController(svc, fb) };
}

test('limpiarPermisos: solo vistas asignables, sin duplicados', () => {
  const p = reglas.limpiarPermisos([
    { path: '/app/payments', name: 'Pagos', status: true },
    { path: '/app/roles', status: true },
    { path: '/app/monitoring', status: true },
    '/app/avisos',
    { path: '/app/payments', status: false },
    { path: '/app/home', status: true },
  ]);
  assert.deepStrictEqual(p.map((x) => [x.path, x.status]), [['/app/payments', true], ['/app/avisos', true]]);
  assert.ok(!reglas.VISTAS_ASIGNABLES.includes('/app/complexes'));
  assert.ok(!reglas.VISTAS_ASIGNABLES.includes('/app/billing'));
  assert.strictEqual(reglas.VISTAS_ASIGNABLES.length, 16);
});

test('roles del sistema', () => {
  assert.ok(reglas.esRolSistema('superAdmin'));
  assert.ok(reglas.esRolSistema('Inquilino'));
  assert.ok(!reglas.esRolSistema('Contador'));
});

test('list: el admin ve los del sistema, globales y los de su conjunto', async () => {
  const { ctl } = armar();
  const r = await ctl.list(req('admin1', 'admin'));
  const nombres = r.data.map((x) => x.name).sort();
  assert.deepStrictEqual(nombres, ['Contador', 'admin', 'propietario', 'superAdmin']);
  assert.strictEqual(r.data.find((x) => x.name === 'admin').sistema, true);
  assert.strictEqual(r.data.find((x) => x.name === 'Contador').sistema, false);
  const todos = await ctl.list(req('root', 'superAdmin'));
  assert.strictEqual(todos.data.length, 5);
});

test('roles del sistema: solo el superAdmin los edita y nadie los elimina', async () => {
  const { ctl, fb } = armar();
  await assert.rejects(() => ctl.update(req('admin1', 'admin'), 'admin', { permissions: [] }));
  await assert.rejects(() => ctl.update(req('x', 'propietario'), 'c1', { name: 'X' }));
  assert.strictEqual(fb.data.mirror.roles.admin.permisos.length, 1);
  const ok = await ctl.update(req('root', 'superAdmin'), 'propietario', { name: 'Dueño', permissions: [{ path: '/app/guests', status: true }] });
  assert.strictEqual(ok.success, true);
  const guardado = fb.data.mirror.roles.propietario;
  assert.strictEqual(guardado.nombre, 'propietario'); // conserva su nombre
  assert.strictEqual(guardado.v, 2);
  assert.deepStrictEqual(guardado.permisos.map((p) => p.path), ['/app/guests']);
  const del = await ctl.remove(req('root', 'superAdmin'), 'admin');
  assert.strictEqual(del.success, false);
});

test('roles personalizados: el admin solo gestiona los de su conjunto', async () => {
  const { ctl, fb } = armar();
  const c = await ctl.create(req('admin1', 'admin'), { name: 'Tesorero', conjunto: 'Otro', permissions: ['/app/payments'] });
  assert.strictEqual(c.success, true);
  assert.strictEqual(fb.data.mirror.roles[c.id].conjunto, 'Los Pinos'); // se fuerza su conjunto
  await assert.rejects(() => ctl.update(req('admin1', 'admin'), 'c2', { name: 'X' }));
  await assert.rejects(() => ctl.remove(req('admin1', 'admin'), 'c2'));
  assert.strictEqual(fb.data.mirror.roles.c2.nombre, 'Portero nocturno');
  assert.strictEqual((await ctl.update(req('admin1', 'admin'), 'c1', { name: 'Contadora', permissions: [] })).success, true);
  assert.strictEqual((await ctl.remove(req('admin1', 'admin'), 'c1')).success, true);
});

test('nombres: no se repiten ni se usan los del sistema', async () => {
  const { ctl } = armar();
  assert.match((await ctl.create(req('admin1', 'admin'), { name: 'contador' })).message, /Ya existe/);
  assert.match((await ctl.create(req('admin1', 'admin'), { name: 'Vigilante' })).message, /rol del sistema/);
  // En otro conjunto sí se puede usar el mismo nombre.
  assert.strictEqual((await ctl.create(req('admin2', 'admin'), { name: 'Contador' })).success, true);
});

test('el superAdmin crea el registro de un rol del sistema que falta (inquilino)', async () => {
  const { ctl, fb } = armar();
  const r = await ctl.create(req('root', 'superAdmin'), { name: 'inquilino', permissions: [{ path: '/app/guests', status: true }] });
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.id, 'inquilino');
  assert.strictEqual(fb.data.mirror.roles.inquilino.conjunto, '');
  assert.match((await ctl.create(req('root', 'superAdmin'), { name: 'admin' })).message, /ya existe/);
});
