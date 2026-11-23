// Solicitudes de registro por QR: reglas y flujo pendiente → aprobada/rechazada.
// Ejecutar: npm run test:wsp (compila y corre con el runner nativo de Node).
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const rules = require(path.join(__dirname, '../dist/users/registro-solicitudes.rules.js'));
const { UsersInviteService } = require(path.join(__dirname, '../dist/users/users-invite.service.js'));

// ---------------------------------------------------------------------------
// Reglas puras
// ---------------------------------------------------------------------------

test('normUnidad iguala las formas comunes de escribir la unidad', () => {
  const a = rules.normUnidad('Torre 3 Apto 402');
  assert.strictEqual(a, '3 402');
  assert.strictEqual(rules.normUnidad('T3-402'), a);
  assert.strictEqual(rules.normUnidad('torre 3 - apto. 402'), a);
  assert.strictEqual(rules.normUnidad('3 402'), a);
  assert.strictEqual(rules.normUnidad('Casa 12'), '12');
  assert.notStrictEqual(rules.normUnidad('Torre 3 Apto 403'), a);
});

test('limpiarDatos normaliza nombre, teléfono, documento y correo', () => {
  const d = rules.limpiarDatos({ nombre: '  JUAN   pérez gómez ', phone: '+57 300-123 4567', documentNumber: '1.020.304', email: ' Juan@Mail.COM ', documentType: 'cc' });
  assert.strictEqual(d.nombre, 'Juan Pérez Gómez');
  assert.strictEqual(d.phone, '573001234567');
  assert.strictEqual(d.documentNumber, '1020304');
  assert.strictEqual(d.email, 'juan@mail.com');
  assert.strictEqual(d.documentType, 'CC');
});

test('advertencias: unidad con propietario, documento, teléfono y correo repetidos', () => {
  const usuarios = [
    { usuario: 'ana', nombre: 'Ana Ruiz', rol: 'propietario', parcela: 'T3-402', docNum: '1020304', phone: '3001234567', email: 'ana@x.com' },
    { usuario: 'old', nombre: 'Viejo', rol: 'desactivado', parcela: 'Torre 1 Apto 101', docNum: '999999' },
  ];
  const s = rules.limpiarDatos({ nombre: 'Luis', parcela: 'Torre 3 Apto 402', documentNumber: '1020304', phone: '+57 300 123 4567', email: 'ANA@x.com' });
  const tipos = rules.advertencias(s, usuarios).map((a) => a.tipo).sort();
  assert.deepStrictEqual(tipos, ['correo', 'documento', 'telefono', 'unidad']);

  const limpio = rules.limpiarDatos({ nombre: 'Luis', parcela: 'Torre 1 Apto 101', documentNumber: '999999' });
  assert.deepStrictEqual(rules.advertencias(limpio, usuarios), [], 'los desactivados no cuentan');
});

test('solicitudRepetida por documento o celular; requiereAprobacion por defecto', () => {
  const p = [{ id: 'a', estado: 'pendiente', documentNumber: '1020304', phone: '3001234567' }];
  assert.ok(rules.solicitudRepetida(rules.limpiarDatos({ nombre: 'x', documentNumber: '1020304' }), p));
  assert.ok(rules.solicitudRepetida(rules.limpiarDatos({ nombre: 'x', phone: '+573001234567' }), p));
  assert.strictEqual(rules.solicitudRepetida(rules.limpiarDatos({ nombre: 'x', phone: '3110000000' }), p), null);
  assert.strictEqual(rules.requiereAprobacion({}), true);
  assert.strictEqual(rules.requiereAprobacion({ registroQr: { requiereAprobacion: false } }), false);
});

// ---------------------------------------------------------------------------
// Flujo con Firebase simulado
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
  let n = 0;
  const ref = (p = '') => ({
    get: async () => { const v = getAt(p); return { exists: () => v !== undefined, val: () => v }; },
    set: async (v) => setAt(p, JSON.parse(JSON.stringify(v))),
    update: async (vals) => { for (const [k, v] of Object.entries(vals)) setAt(`${p}/${k}`, v); },
    push: () => ref(`${p}/s${++n}`),
    child: (c) => ref(`${p}/${c}`),
    transaction: async (fn) => {
      const nuevo = fn(getAt(p) ?? null);
      if (nuevo === undefined) return { committed: false };
      setAt(p, nuevo);
      return { committed: true };
    },
  });
  return {
    data,
    isEnabled: () => true,
    liveVal: async (p) => getAt(p) ?? null,
    liveValues: async (p) => Object.values(getAt(p) || {}),
    db: () => ({ ref }),
  };
}

function escenario({ requiere } = {}) {
  const fb = fakeFirebase({
    mirror: {
      conjuntos: { c1: { nombre: 'Villa Sol', ...(requiere === false ? { registroQr: { requiereAprobacion: false } } : {}) } },
      usuarios: { ana: { usuario: 'ana', nombre: 'Ana Ruiz', rol: 'propietario', conjunto: 'Villa Sol', parcela: 'T3-402', phone: '3001234567' } },
    },
  });
  const creados = [];
  const enviados = [];
  const users = {
    list: async (c) => Object.values(fb.data.mirror.usuarios).filter((u) => u.conjunto === c),
    create: async (dto) => {
      if (fb.data.mirror.usuarios[dto.usuario]) return { success: false, message: 'El usuario ya existe.' };
      fb.data.mirror.usuarios[dto.usuario] = { usuario: dto.usuario, nombre: dto.nombre, rol: dto.rol, conjunto: dto.conjunto, parcela: dto.parcela, phone: dto.phone };
      creados.push(dto);
      return { success: true };
    },
  };
  const whatsapp = { sendMessage: async (tel, msg) => { enviados.push({ tel, msg }); return true; } };
  const config = { get: (_k, def) => def };
  const jwt = { verify: (t) => (t === 'ok' ? { type: 'invite', conjunto: 'Villa Sol' } : (() => { throw new Error('x'); })()) };
  const svc = new UsersInviteService(fb, config, jwt, users, whatsapp);
  // Sin Firebase Auth en la prueba: acceso temporal y envío simulados.
  svc.generateTempAccess = async (u) => ({ success: true, usuario: u, password: 'Tmp-123' });
  svc.sendCredentials = async (u, c) => { enviados.push({ tel: 'cred', msg: `${u}@${c}` }); return { success: true }; };
  return { fb, svc, creados, enviados };
}

test('con aprobación: el registro queda pendiente y no crea la cuenta', async () => {
  const { fb, svc, creados } = escenario();
  const r = await svc.selfRegister('ok', { nombre: 'luis torres', phone: '3115550000', parcela: 'Torre 3 Apto 402' });
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.pendiente, true);
  assert.strictEqual(creados.length, 0);
  const pend = Object.values(fb.data.solicitudes_registro['villa sol']);
  assert.strictEqual(pend.length, 1);
  assert.strictEqual(pend[0].nombre, 'Luis Torres');

  // Reenviar el formulario no duplica.
  const r2 = await svc.selfRegister('ok', { nombre: 'Luis Torres', phone: '+57 311 555 0000' });
  assert.strictEqual(r2.pendiente, true);
  assert.strictEqual(Object.keys(fb.data.solicitudes_registro['villa sol']).length, 1);

  const lista = await svc.listarSolicitudes('Villa Sol');
  assert.strictEqual(lista.data.length, 1);
  assert.deepStrictEqual(lista.data[0].advertencias.map((a) => a.tipo), ['unidad'], 'la unidad ya es de Ana');
});

test('aprobar con cambios crea la cuenta, envía credenciales y no se puede aprobar dos veces', async () => {
  const { fb, svc, creados, enviados } = escenario();
  await svc.selfRegister('ok', { nombre: 'Luis Torres', phone: '3115550000', parcela: 'T3 402' });
  const id = Object.keys(fb.data.solicitudes_registro['villa sol'])[0];

  const r = await svc.aprobarSolicitud('Villa Sol', id, { parcela: 'Torre 3 Apto 403' }, 'admin1');
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.enviadoPorWhatsapp, true);
  assert.strictEqual(creados.length, 1);
  assert.strictEqual(creados[0].parcela, 'Torre 3 Apto 403');
  assert.strictEqual(creados[0].rol, 'propietario');
  assert.ok(enviados.some((e) => e.tel === 'cred'));
  const s = fb.data.solicitudes_registro['villa sol'][id];
  assert.strictEqual(s.estado, 'aprobada');
  assert.strictEqual(s.resueltaPor, 'admin1');

  const otra = await svc.aprobarSolicitud('Villa Sol', id, undefined, 'admin2');
  assert.strictEqual(otra.success, false);
  assert.strictEqual(creados.length, 1);
});

test('aprobar sin teléfono devuelve credenciales para el admin', async () => {
  const { fb, svc } = escenario();
  await svc.selfRegister('ok', { nombre: 'Marta Gil', documentNumber: '55667788' });
  const id = Object.keys(fb.data.solicitudes_registro['villa sol'])[0];
  const r = await svc.aprobarSolicitud('Villa Sol', id, undefined, 'admin1');
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.enviadoPorWhatsapp, false);
  assert.deepStrictEqual(r.credenciales, { usuario: r.usuario, password: 'Tmp-123' });
});

test('rechazar avisa por WhatsApp y deja la solicitud cerrada', async () => {
  const { fb, svc, creados, enviados } = escenario();
  await svc.selfRegister('ok', { nombre: 'Pedro', phone: '3209998877' });
  const id = Object.keys(fb.data.solicitudes_registro['villa sol'])[0];
  const r = await svc.rechazarSolicitud('Villa Sol', id, 'No figura como propietario', 'admin1');
  assert.strictEqual(r.success, true);
  assert.strictEqual(fb.data.solicitudes_registro['villa sol'][id].estado, 'rechazada');
  assert.ok(enviados.some((e) => e.tel === '3209998877' && /No figura como propietario/.test(e.msg)));
  assert.strictEqual(creados.length, 0);
  assert.strictEqual((await svc.aprobarSolicitud('Villa Sol', id, undefined, 'x')).success, false);
});

test('sin aprobación (configurado así): crea la cuenta como antes', async () => {
  const { svc, creados } = escenario({ requiere: false });
  const r = await svc.selfRegister('ok', { nombre: 'Rosa Paz' });
  assert.strictEqual(r.success, true);
  assert.ok(!r.pendiente);
  assert.ok(r.usuario);
  assert.strictEqual(creados.length, 1);
});

test('token inválido no crea nada', async () => {
  const { fb, svc } = escenario();
  const r = await svc.selfRegister('malo', { nombre: 'X' });
  assert.strictEqual(r.success, false);
  assert.strictEqual(fb.data.solicitudes_registro, undefined);
});
