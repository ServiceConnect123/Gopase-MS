// Anuncios de GoPase: validación, a quién le aplica, una sola vista por usuario y métricas.
// Ejecutar: npm run test:wsp (compila y corre con el runner nativo de Node).
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const rules = require(path.join(__dirname, '../dist/anuncios/anuncio-rules.js'));
const { AnunciosService } = require(path.join(__dirname, '../dist/anuncios/anuncios.service.js'));
const { FIRMA_REDES } = require(path.join(__dirname, '../dist/pagos-whatsapp/pagos-wsp.service.js'));

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
    get: async () => { const v = leer(p); return { exists: () => v !== undefined && v !== null, val: () => (v === undefined ? null : v) }; },
    set: async (v) => escribir(p, v),
    remove: async () => escribir(p, undefined),
  });
  return { data, isEnabled: () => true, db: () => ({ ref }), liveVal: async (p) => leer(p) ?? null };
}

const USUARIOS = {
  mirror: {
    usuarios: {
      ana: { nombre: 'Ana Pérez', rol: 'propietario', conjunto: 'Los Pinos' },
      beto: { nombre: 'Beto Ruiz', rol: 'admin', conjunto: 'Los Pinos' },
      caro: { nombre: 'Caro Díaz', rol: 'propietario', conjunto: 'Villa Mayra' },
      superadmin: { nombre: 'Super', rol: 'superAdmin', conjunto: '' },
    },
  },
};

const BASE = { titulo: 'Síguenos en TikTok', mensaje: 'Tips para tu conjunto', ctaTexto: 'Seguir', ctaUrl: 'https://www.tiktok.com/@somosgopase' };

// ------------------------------------------------------------------ reglas

test('validarAnuncio: exige título y mensaje o imagen, y enlaces http(s)', () => {
  assert.strictEqual(rules.validarAnuncio({}).ok, false);
  assert.strictEqual(rules.validarAnuncio({ titulo: 'Hola' }).ok, false);
  assert.match(rules.validarAnuncio({ titulo: 'Hola', mensaje: 'x', ctaUrl: 'tiktok.com' }).error, /http/);
  assert.match(rules.validarAnuncio({ titulo: 'Hola', mensaje: 'x', ctaTexto: 'Ir' }).error, /enlace/);
  assert.match(rules.validarAnuncio({ titulo: 'Hola', mensaje: 'x', desde: '2026-12-10', hasta: '2026-12-01' }).error, /posterior/);
  const ok = rules.validarAnuncio({ ...BASE, roles: ['Propietario', 'superadmin', 'propietario'] });
  assert.strictEqual(ok.ok, true);
  assert.deepStrictEqual(ok.anuncio.roles, ['propietario']); // sin superadmin ni duplicados
  assert.strictEqual(ok.anuncio.activo, true);
  // enlace sin texto: botón «Ver más» por defecto
  assert.strictEqual(rules.validarAnuncio({ titulo: 'a', mensaje: 'b', ctaUrl: 'https://x.co' }).anuncio.ctaTexto, 'Ver más');
});

test('aplicaA: respeta activo, fechas, roles y conjuntos; nunca al superAdmin', () => {
  const a = { activo: true, roles: ['propietario'], conjuntos: ['Los Pinos'], desde: '2026-12-01', hasta: '2026-12-31' };
  assert.strictEqual(rules.aplicaA(a, 'propietario', 'los pinos', '2026-12-15'), true);
  assert.strictEqual(rules.aplicaA(a, 'admin', 'Los Pinos', '2026-12-15'), false);
  assert.strictEqual(rules.aplicaA(a, 'propietario', 'Villa Mayra', '2026-12-15'), false);
  assert.strictEqual(rules.aplicaA(a, 'propietario', 'Los Pinos', '2026-11-30'), false);
  assert.strictEqual(rules.aplicaA(a, 'propietario', 'Los Pinos', '2027-01-01'), false);
  assert.strictEqual(rules.aplicaA({ ...a, activo: false }, 'propietario', 'Los Pinos', '2026-12-15'), false);
  assert.strictEqual(rules.aplicaA({ activo: true, roles: [], conjuntos: [] }, 'superAdmin', '', '2026-12-15'), false);
});

test('anuncioPendiente: el de mayor prioridad que no ha visto', () => {
  const anuncios = [
    { id: '1', activo: true, prioridad: 0, creadoEn: '2026-11-01' },
    { id: '2', activo: true, prioridad: 5, creadoEn: '2026-10-01' },
  ];
  assert.strictEqual(rules.anuncioPendiente(anuncios, {}, 'ana', 'propietario', 'X', '2026-12-01').id, '2');
  assert.strictEqual(rules.anuncioPendiente(anuncios, { 2: { ana: {} } }, 'ana', 'propietario', 'X', '2026-12-01').id, '1');
  assert.strictEqual(rules.anuncioPendiente(anuncios, { 1: { ana: {} }, 2: { ana: {} } }, 'ana', 'propietario', 'X', '2026-12-01'), null);
});

test('metricas: cuenta vistas, clics, tasa y reparto', () => {
  const m = rules.metricas([
    { rol: 'propietario', conjunto: 'A', vistoEn: '2026-12-01T15:00:00Z', clic: true },
    { rol: 'propietario', conjunto: 'B', vistoEn: '2026-12-02T03:00:00Z' }, // 1 dic en Colombia
    { rol: 'admin', conjunto: 'A', vistoEn: '2026-12-02T15:00:00Z', clic: true },
  ]);
  assert.strictEqual(m.vistas, 3);
  assert.strictEqual(m.clics, 2);
  assert.ok(Math.abs(m.tasaClic - 2 / 3) < 1e-9);
  assert.deepStrictEqual(m.porRol, { propietario: 2, admin: 1 });
  assert.deepStrictEqual(m.porConjunto, { A: 2, B: 1 });
  assert.deepStrictEqual(m.porDia, { '2026-12-01': 2, '2026-12-02': 1 });
});

// ------------------------------------------------------------------ servicio

test('cada usuario ve el anuncio una sola vez', async () => {
  const fb = fakeFirebase(USUARIOS);
  const svc = new AnunciosService(fb);
  const c = await svc.create(BASE, 'superadmin');
  assert.strictEqual(c.success, true);

  const p1 = await svc.pendiente('ana');
  assert.strictEqual(p1.id, c.id);
  assert.strictEqual((await svc.registrarVista(c.id, 'ana')).success, true);
  assert.strictEqual(await svc.pendiente('ana'), null);
  // Otro usuario todavía lo tiene pendiente; el superAdmin nunca.
  assert.strictEqual((await svc.pendiente('caro')).id, c.id);
  assert.strictEqual(await svc.pendiente('superadmin'), null);
});

test('registrarVista es idempotente y guarda el clic', async () => {
  const fb = fakeFirebase(USUARIOS);
  const svc = new AnunciosService(fb);
  const { id } = await svc.create(BASE, 'superadmin');
  await svc.registrarVista(id, 'ana');
  const primera = fb.data.mirror.anuncios_vistas[id].ana.vistoEn;
  await new Promise((r) => setTimeout(r, 5));
  await svc.registrarVista(id, 'ana', true);
  const v = fb.data.mirror.anuncios_vistas[id].ana;
  assert.strictEqual(v.vistoEn, primera); // conserva la primera fecha
  assert.strictEqual(v.clic, true);
  assert.strictEqual(v.nombre, 'Ana Pérez');
  assert.strictEqual(v.conjunto, 'Los Pinos');
  assert.strictEqual((await svc.registrarVista('no-existe', 'ana')).success, false);
});

test('list y detalle: métricas, audiencia y quién lo vio', async () => {
  const fb = fakeFirebase(USUARIOS);
  const svc = new AnunciosService(fb);
  const { id } = await svc.create({ ...BASE, roles: ['propietario'] }, 'superadmin');
  await svc.registrarVista(id, 'ana', true);
  await svc.registrarVista(id, 'caro');

  const [a] = await svc.list();
  assert.strictEqual(a.metricas.vistas, 2);
  assert.strictEqual(a.metricas.clics, 1);
  assert.strictEqual(a.metricas.audiencia, 2); // ana y caro son propietarias

  const d = await svc.detalle(id);
  assert.strictEqual(d.success, true);
  assert.deepStrictEqual(d.vistas.map((v) => v.usuario).sort(), ['ana', 'caro']);
  assert.deepStrictEqual(d.metricas.porConjunto, { 'Los Pinos': 1, 'Villa Mayra': 1 });
});

test('update conserva lo no enviado; remove borra anuncio y vistas', async () => {
  const fb = fakeFirebase(USUARIOS);
  const svc = new AnunciosService(fb);
  const { id } = await svc.create(BASE, 'superadmin');
  await svc.registrarVista(id, 'ana');
  assert.strictEqual((await svc.update(id, { activo: false })).success, true);
  const guardado = fb.data.mirror.anuncios[id];
  assert.strictEqual(guardado.activo, false);
  assert.strictEqual(guardado.titulo, BASE.titulo);
  assert.strictEqual(await svc.pendiente('caro'), null); // inactivo
  assert.strictEqual((await svc.remove(id)).success, true);
  assert.strictEqual(fb.data.mirror.anuncios[id], undefined);
  assert.strictEqual(fb.data.mirror.anuncios_vistas?.[id], undefined);
});

test('firma de redes en la confirmación de pago por WhatsApp', () => {
  assert.match(FIRMA_REDES, /@somosgopase/);
});
