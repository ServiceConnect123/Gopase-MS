// Estadías cortas (alquiler por días) con enlace temporal para el huésped.
// Ejecutar: npm run test:wsp (compila y corre con el runner nativo de Node).
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const rules = require(path.join(__dirname, '../dist/stays/stay-rules.js'));
const { StaysService } = require(path.join(__dirname, '../dist/stays/stays.service.js'));

const iso = (offsetDias) => {
  const d = new Date();
  d.setDate(d.getDate() + offsetDias);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

// ---------------------------------------------------------------------------
// Reglas puras
// ---------------------------------------------------------------------------

test('configuración: por defecto NO permitidas y con aprobación', () => {
  assert.deepStrictEqual(rules.normConfig(undefined), { permitidas: false, requiereAprobacion: true, maxNoches: 30, maxAcompanantes: 6, reglas: '' });
  const c = rules.normConfig({ permitidas: true, requiereAprobacion: false, maxNoches: 500, maxAcompanantes: -3 });
  assert.strictEqual(c.maxNoches, 90);
  assert.strictEqual(c.maxAcompanantes, 0);
  assert.strictEqual(c.requiereAprobacion, false);
});

test('validarSolicitud respeta la configuración del conjunto', () => {
  const hoy = '2026-12-01';
  const ok = { nombre: 'Juan Ruiz', phone: '3001234567', llegada: '2026-12-10', salida: '2026-12-13', acompanantes: 2 };
  const config = rules.normConfig({ permitidas: true, maxNoches: 5, maxAcompanantes: 3 });
  assert.match(rules.validarSolicitud(ok, rules.normConfig({}), hoy).error, /no tiene habilitadas/);
  assert.ok('datos' in rules.validarSolicitud(ok, config, hoy));
  assert.match(rules.validarSolicitud({ ...ok, llegada: '2026-11-30' }, config, hoy).error, /pasado/);
  assert.match(rules.validarSolicitud({ ...ok, salida: '2026-12-09' }, config, hoy).error, /antes de la llegada/);
  assert.match(rules.validarSolicitud({ ...ok, salida: '2026-12-20' }, config, hoy).error, /máximo 5 noches/);
  assert.match(rules.validarSolicitud({ ...ok, acompanantes: 4 }, config, hoy).error, /máximo 3 acompañantes/);
  assert.match(rules.validarSolicitud({ ...ok, phone: '12' }, config, hoy).error, /celular/);
  assert.strictEqual(rules.noches('2026-12-10', '2026-12-13'), 3);
});

test('estado efectivo de una estadía', () => {
  const e = { estado: 'aprobada', llegada: '2026-12-10', salida: '2026-12-13' };
  assert.strictEqual(rules.estadoEstadia(e, '2026-12-09'), 'programada');
  assert.strictEqual(rules.estadoEstadia(e, '2026-12-10'), 'por_llegar');
  assert.strictEqual(rules.estadoEstadia({ ...e, entrada: { en: 'x' } }, '2026-12-11'), 'en_curso');
  assert.strictEqual(rules.estadoEstadia(e, '2026-12-13'), 'por_llegar', 'el día de salida aún vale');
  assert.strictEqual(rules.estadoEstadia(e, '2026-12-14'), 'finalizada');
  assert.strictEqual(rules.estadoEstadia({ ...e, entrada: { en: 'x' }, salidaReal: { en: 'y' } }, '2026-12-11'), 'finalizada');
  assert.strictEqual(rules.estadoEstadia({ ...e, estado: 'pendiente' }, '2026-12-11'), 'pendiente');
  assert.strictEqual(rules.accesoVigente(e, '2026-12-09'), false);
  assert.strictEqual(rules.accesoVigente(e, '2026-12-11'), true);
});

test('código: sin caracteres confusos y se lee desde el QR', () => {
  const c = rules.generarCodigo();
  assert.match(c, /^[A-HJ-NP-Z2-9]{6}$/);
  assert.strictEqual(rules.normCodigo('https://gopasehome.site/app/home?estadia=AB3CD9'), 'AB3CD9');
  assert.strictEqual(rules.normCodigo(' ab3-cd9 '), 'AB3CD9');
});

// ---------------------------------------------------------------------------
// Servicio (Firebase y WhatsApp simulados)
// ---------------------------------------------------------------------------

function fakeFirebase(data) {
  const parts = (p) => String(p || '').split('/').filter(Boolean);
  const getAt = (p) => parts(p).reduce((o, k) => (o == null ? undefined : o[k]), data);
  const setAt = (p, v) => {
    const ks = parts(p);
    let o = data;
    ks.slice(0, -1).forEach((k) => { o[k] = o[k] || {}; o = o[k]; });
    o[ks[ks.length - 1]] = v;
  };
  return {
    data,
    isEnabled: () => true,
    liveValues: async (p) => Object.values(getAt(p) || {}),
    liveVal: async (p) => getAt(p) ?? null,
    db: () => ({
      ref: (p = '') => ({
        get: async () => { const v = getAt(p); return { exists: () => v !== undefined, val: () => v }; },
        set: async (v) => setAt(p, JSON.parse(JSON.stringify(v))),
        update: async (vals) => { for (const [k, v] of Object.entries(vals)) setAt(`${p}/${k}`, v); },
      }),
    }),
  };
}

function escenario(config) {
  const fb = fakeFirebase({
    mirror: {
      conjuntos: { c1: { id: 'c1', nombre: 'Villa Test', estadiasCortas: config } },
      usuarios: {
        carlos: { usuario: 'carlos', nombre: 'Carlos Pérez', rol: 'propietario', conjunto: 'Villa Test', parcela: 'Casa 5', phone: '3110000000' },
        ana: { usuario: 'ana', nombre: 'Ana', rol: 'inquilino', conjunto: 'Villa Test', parcela: 'Casa 5' },
      },
      estadias: {},
      noticias: { n1: { conjunto: 'Villa Test', titulo: 'Corte de agua', creadoEn: '2026-01-01' } },
    },
  });
  const mensajes = [];
  const wsp = { sendMessage: async (phone, msg) => { mensajes.push({ phone, msg }); return true; } };
  const svc = new StaysService(fb, { get: (_k, d) => d }, wsp);
  return { fb, svc, mensajes };
}

const huesped = () => ({ nombre: 'Juan Ruiz', phone: '+57 300 123 4567', llegada: iso(0), salida: iso(2), acompanantes: 1 });
const tokenDe = (msg) => /token=([A-Za-z0-9_-]+)/.exec(msg)[1];

test('sin habilitar en el conjunto no se pueden registrar', async () => {
  const { svc } = escenario(undefined);
  const r = await svc.crear('carlos', huesped());
  assert.strictEqual(r.success, false);
  assert.match(r.message, /no tiene habilitadas/);
});

test('solo el propietario registra estadías (no el arrendatario)', async () => {
  const { svc } = escenario({ permitidas: true });
  assert.match((await svc.crear('ana', huesped())).message, /Solo el propietario/);
});

test('con aprobación: queda pendiente, el admin aprueba y se envía el enlace', async () => {
  const { fb, svc, mensajes } = escenario({ permitidas: true, requiereAprobacion: true });
  const r = await svc.crear('carlos', huesped());
  assert.ok(r.success, r.message);
  assert.strictEqual(fb.data.mirror.estadias[r.id].estado, 'pendiente');
  assert.strictEqual(fb.data.mirror.estadias[r.id].parcela, 'Casa 5');
  assert.strictEqual(mensajes.length, 0, 'nada se envía antes de aprobar');

  const pendientes = await svc.deConjunto('Villa Test', 'pendientes');
  assert.strictEqual(pendientes.length, 1);
  assert.strictEqual(pendientes[0].tokenHash, undefined, 'no expone el hash del enlace');

  const a = await svc.aprobar(r.id, 'laura');
  assert.ok(a.success);
  const alHuesped = mensajes.find((m) => m.phone === '573001234567');
  assert.ok(alHuesped, 'el huésped recibe el enlace');
  assert.match(alHuesped.msg, /estadia\?token=/);
  assert.match(alHuesped.msg, new RegExp(fb.data.mirror.estadias[r.id].codigo));
  assert.ok(mensajes.some((m) => m.phone === '3110000000' && /aprobó/.test(m.msg)), 'se avisa al propietario');
  assert.strictEqual((await svc.aprobar(r.id, 'laura')).success, false, 'no se aprueba dos veces');
});

test('sin aprobación: queda aprobada y el enlace sale de una vez', async () => {
  const { fb, svc, mensajes } = escenario({ permitidas: true, requiereAprobacion: false });
  const r = await svc.crear('carlos', huesped());
  assert.strictEqual(fb.data.mirror.estadias[r.id].estado, 'aprobada');
  assert.strictEqual(mensajes.length, 1);
});

test('el enlace muestra QR y noticias solo durante la estadía; uno nuevo invalida el anterior', async () => {
  const { svc, mensajes } = escenario({ permitidas: true, requiereAprobacion: false, reglas: 'Silencio después de las 10 p. m.' });
  const r = await svc.crear('carlos', huesped());
  const token1 = tokenDe(mensajes[0].msg);
  const acc = await svc.acceso(token1);
  assert.ok(acc.success);
  assert.strictEqual(acc.data.vigente, true);
  assert.strictEqual(acc.data.huesped, 'Juan Ruiz');
  assert.strictEqual(acc.data.parcela, 'Casa 5');
  assert.strictEqual(acc.data.reglas, 'Silencio después de las 10 p. m.');
  assert.ok(acc.data.codigo);
  assert.strictEqual(acc.data.noticias.length, 1);

  await svc.reenviar(r.id);
  const token2 = tokenDe(mensajes[1].msg);
  assert.notStrictEqual(token1, token2);
  assert.strictEqual((await svc.acceso(token1)).success, false, 'el enlace viejo deja de servir');
  assert.ok((await svc.acceso(token2)).success);
  assert.strictEqual((await svc.acceso('corto')).success, false);
});

test('estadía futura: el enlace dice cuándo empieza y no muestra QR', async () => {
  const { svc, mensajes } = escenario({ permitidas: true, requiereAprobacion: false });
  await svc.crear('carlos', { ...huesped(), llegada: iso(3), salida: iso(5) });
  const acc = await svc.acceso(tokenDe(mensajes[0].msg));
  assert.strictEqual(acc.data.vigente, false);
  assert.match(acc.data.mensaje, /empieza el/);
  assert.strictEqual(acc.data.qr, undefined);
  assert.strictEqual(acc.data.codigo, undefined);
});

test('portería: buscar por código, entrada y salida (la salida cierra el acceso)', async () => {
  const { fb, svc, mensajes } = escenario({ permitidas: true, requiereAprobacion: false });
  const r = await svc.crear('carlos', huesped());
  const codigo = fb.data.mirror.estadias[r.id].codigo;
  assert.strictEqual((await svc.porCodigo(`https://x/app/home?estadia=${codigo}`)).id, r.id);
  assert.strictEqual((await svc.deConjunto('Villa Test', 'hoy')).length, 1);

  assert.strictEqual((await svc.registrarSalida(r.id, 'vig')).success, false, 'sin entrada no hay salida');
  assert.ok((await svc.registrarEntrada(r.id, 'vig')).success);
  assert.strictEqual((await svc.registrarEntrada(r.id, 'vig')).success, false, 'no se registra dos veces');
  assert.strictEqual((await svc.deConjunto('Villa Test', 'hoy'))[0].estadoActual, 'en_curso');
  assert.ok((await svc.registrarSalida(r.id, 'vig')).success);

  const acc = await svc.acceso(tokenDe(mensajes[0].msg));
  assert.strictEqual(acc.data.vigente, false);
  assert.match(acc.data.mensaje, /terminó/);
  assert.strictEqual((await svc.deConjunto('Villa Test', 'hoy')).length, 0);
});

test('rechazar y cancelar', async () => {
  const { fb, svc, mensajes } = escenario({ permitidas: true, requiereAprobacion: true });
  const r1 = await svc.crear('carlos', huesped());
  assert.ok((await svc.rechazar(r1.id, 'laura', 'Fechas de mantenimiento')).success);
  assert.strictEqual(fb.data.mirror.estadias[r1.id].estado, 'rechazada');
  assert.ok(mensajes.some((m) => /no aprobó/.test(m.msg) && /mantenimiento/.test(m.msg)));
  assert.strictEqual((await svc.registrarEntrada(r1.id, 'vig')).success, false);

  const r2 = await svc.crear('carlos', huesped());
  assert.ok((await svc.cancelar(r2.id)).success);
  assert.strictEqual((await svc.cancelar(r2.id)).success, false);
  assert.strictEqual((await svc.reenviar(r2.id)).success, false, 'no se reenvía una cancelada');
});

test('configuración: el admin la guarda normalizada', async () => {
  const { fb, svc } = escenario(undefined);
  const r = await svc.setConfig('Villa Test', { permitidas: true, maxNoches: 7, reglas: '  Sin mascotas  ' });
  assert.ok(r.success);
  assert.deepStrictEqual(fb.data.mirror.conjuntos.c1.estadiasCortas, {
    permitidas: true, requiereAprobacion: true, maxNoches: 7, maxAcompanantes: 6, reglas: 'Sin mascotas',
  });
});
