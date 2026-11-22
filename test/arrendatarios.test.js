// Inquilinos (rol "inquilino") que registra el propietario de una unidad.
// Ejecutar: npm run test:wsp (compila y corre con el runner nativo de Node).
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const rules = require(path.join(__dirname, '../dist/tenants/tenant-rules.js'));
const { TenantsService } = require(path.join(__dirname, '../dist/tenants/tenants.service.js'));
const { PaymentsService } = require(path.join(__dirname, '../dist/payments/payments.service.js'));

// ---------------------------------------------------------------------------
// Reglas puras
// ---------------------------------------------------------------------------

test('estado del arriendo según las fechas (inclusivas)', () => {
  const d = { inicio: '2026-12-01', fin: '2027-11-30' };
  assert.strictEqual(rules.estadoInquilino(d, '2026-11-30'), 'programado');
  assert.strictEqual(rules.estadoInquilino(d, '2026-12-01'), 'activo');
  assert.strictEqual(rules.estadoInquilino(d, '2027-11-30'), 'activo');
  assert.strictEqual(rules.estadoInquilino(d, '2027-12-01'), 'vencido');
  assert.strictEqual(rules.estadoInquilino({ ...d, revocado: true }, '2027-01-01'), 'revocado');
  assert.strictEqual(rules.estadoInquilino({ inicio: '2026-01-01', fin: '' }, '2030-01-01'), 'activo', 'sin fin = indefinido');
  assert.strictEqual(rules.estadoInquilino(null, '2027-01-01'), 'revocado');
});

test('mensajes de acceso para el login', () => {
  assert.strictEqual(rules.mensajeAccesoInquilino({ inicio: '2026-01-01' }, '2026-05-05'), null);
  assert.match(rules.mensajeAccesoInquilino({ inicio: '2026-12-01' }, '2026-11-01'), /empieza el 01\/12\/2026/);
  assert.match(rules.mensajeAccesoInquilino({ inicio: '2026-01-01', fin: '2026-06-30' }, '2026-07-01'), /venció el 30\/06\/2026/);
  assert.match(rules.mensajeAccesoInquilino({ inicio: '2026-01-01', revocado: true }, '2026-03-01'), /fue retirado/);
});

test('validarArriendo', () => {
  assert.ok('error' in rules.validarArriendo({}));
  assert.ok('error' in rules.validarArriendo({ inicio: '2026-02-30' }), 'fecha imposible');
  assert.ok('error' in rules.validarArriendo({ inicio: '2026-05-01', fin: '2026-04-30' }));
  assert.ok('error' in rules.validarArriendo({ inicio: '2026-05-01', fin: 'mañana' }));
  const ok = rules.validarArriendo({ inicio: '2026-05-01', fin: '', pagaAdministracion: true });
  assert.deepStrictEqual(ok, { datos: { inicio: '2026-05-01', fin: '', pagaAdministracion: true, puedeReservar: false } });
});

test('sin cartera propia: superAdmin, vigilante e inquilino', () => {
  assert.strictEqual(rules.tieneCartera('propietario'), true);
  assert.strictEqual(rules.tieneCartera('admin'), true);
  assert.strictEqual(rules.tieneCartera('superAdmin'), false);
  assert.strictEqual(rules.tieneCartera('vigilante'), false);
  assert.strictEqual(rules.tieneCartera('Inquilino'), false);
});

test('pago delegado: solo vigente, delegado y por la cuenta de su propietario', () => {
  const hoy = '2026-06-01';
  const base = { rol: 'inquilino', inquilino: { propietario: 'carlos', inicio: '2026-01-01', pagaAdministracion: true } };
  assert.strictEqual(rules.puedePagarPorCuenta(base, 'carlos', hoy), true);
  assert.strictEqual(rules.puedePagarPorCuenta(base, 'otro', hoy), false);
  assert.strictEqual(rules.puedePagarPorCuenta({ ...base, inquilino: { ...base.inquilino, pagaAdministracion: false } }, 'carlos', hoy), false);
  assert.strictEqual(rules.puedePagarPorCuenta({ ...base, inquilino: { ...base.inquilino, fin: '2026-05-31' } }, 'carlos', hoy), false);
  assert.strictEqual(rules.puedePagarPorCuenta({ ...base, rol: 'propietario' }, 'carlos', hoy), false);
});

test('la sesión del inquilino no dura más que su arriendo', () => {
  // Mediodía en Colombia (el fin del día también es hora Colombia, no del servidor).
  const now = new Date('2026-01-01T12:00:00-05:00');
  assert.strictEqual(rules.segundosHastaFin('', now), null);
  assert.strictEqual(rules.segundosHastaFin('2026-01-01', now), 11 * 3600 + 59 * 60 + 59);
  assert.strictEqual(rules.segundosHastaFin('2025-12-01', now), 60, 'mínimo 60 s');
});

// ---------------------------------------------------------------------------
// Servicio (con Firebase, usuarios y WhatsApp simulados)
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
  const authDisabled = {};
  return {
    data,
    authDisabled,
    isEnabled: () => true,
    liveValues: async (p) => Object.values(getAt(p) || {}),
    liveVal: async (p) => getAt(p) ?? null,
    auth: () => ({ updateUser: async (uid, v) => { if ('disabled' in v) authDisabled[uid] = v.disabled; } }),
    db: () => ({
      ref: (p = '') => ({
        get: async () => { const v = getAt(p); return { exists: () => v !== undefined, val: () => v }; },
        update: async (vals) => { for (const [k, v] of Object.entries(vals)) setAt(`${p}/${k}`, v); },
      }),
    }),
  };
}

function fakeUsers(fb) {
  return {
    create: async (dto) => {
      fb.data.mirror.usuarios[dto.usuario] = {
        usuario: dto.usuario, nombre: dto.nombre, rol: dto.rol, phone: dto.phone, conjunto: dto.conjunto,
        parcela: dto.parcela, placa1: dto.placa1, placa2: dto.placa2, docType: dto.documentType, docNum: dto.documentNumber,
      };
      return { success: true };
    },
    update: async (u, dto) => {
      const rec = fb.data.mirror.usuarios[u];
      if (dto.nombre !== undefined) rec.nombre = dto.nombre;
      if (dto.phone !== undefined) rec.phone = dto.phone;
      return { success: true };
    },
    remove: async (u) => { delete fb.data.mirror.usuarios[u]; return { success: true }; },
  };
}

function escenario() {
  const fb = fakeFirebase({
    mirror: {
      usuarios: {
        carlos: { usuario: 'carlos', nombre: 'Carlos Pérez', rol: 'propietario', conjunto: 'Villa Test', parcela: 'Casa 5' },
        sinunidad: { usuario: 'sinunidad', nombre: 'Sin Unidad', rol: 'propietario', conjunto: 'Villa Test', parcela: '' },
        laura: { usuario: 'laura', nombre: 'Laura Admin', rol: 'admin', conjunto: 'Villa Test', parcela: '' },
      },
      pagos: {},
    },
  });
  const enviados = [];
  const invite = { sendCredentials: async (u, c) => { enviados.push([u, c]); return { success: true }; } };
  return { fb, enviados, svc: new TenantsService(fb, fakeUsers(fb), invite) };
}

const nuevo = { nombre: 'Ana Gómez', phone: '3001234567', inicio: '2020-01-01', fin: '', pagaAdministracion: true };

test('el propietario crea un inquilino en SU unidad y se le envía el acceso', async () => {
  const { fb, svc, enviados } = escenario();
  const r = await svc.crear('carlos', nuevo);
  assert.ok(r.success, r.message);
  assert.strictEqual(r.usuario, 'anagomez');
  const u = fb.data.mirror.usuarios.anagomez;
  assert.strictEqual(u.rol, 'inquilino');
  assert.strictEqual(u.parcela, 'Casa 5', 'misma unidad del propietario');
  assert.strictEqual(u.conjunto, 'Villa Test');
  assert.strictEqual(u.inquilino.propietario, 'carlos');
  assert.strictEqual(u.inquilino.pagaAdministracion, true);
  assert.deepStrictEqual(enviados, [['anagomez', 'Villa Test']]);

  const lista = await svc.listar('carlos');
  assert.strictEqual(lista.length, 1);
  assert.strictEqual(lista[0].estado, 'activo');
});

test('usuario único aunque se repita el nombre', async () => {
  const { svc } = escenario();
  await svc.crear('carlos', nuevo);
  const r2 = await svc.crear('carlos', { ...nuevo, enviarAcceso: false });
  assert.strictEqual(r2.usuario, 'anagomez2');
});

test('solo un propietario con unidad puede crear inquilinos', async () => {
  const { svc } = escenario();
  assert.match((await svc.crear('laura', nuevo)).message, /Solo un propietario/);
  assert.match((await svc.crear('sinunidad', nuevo)).message, /registra tu unidad/);
  assert.match((await svc.crear('carlos', { ...nuevo, phone: '12' })).message, /celular/);
  assert.match((await svc.crear('carlos', { ...nuevo, inicio: '' })).message, /fecha de inicio/);
});

test('otro propietario no puede tocar el inquilino', async () => {
  const { fb, svc } = escenario();
  fb.data.mirror.usuarios.pedro = { usuario: 'pedro', rol: 'propietario', conjunto: 'Villa Test', parcela: 'Casa 9' };
  await svc.crear('carlos', nuevo);
  assert.strictEqual((await svc.setRevocado('pedro', 'anagomez', true)).success, false);
  assert.strictEqual((await svc.eliminar('pedro', 'anagomez')).success, false);
  assert.strictEqual((await svc.actualizar('pedro', 'anagomez', { nombre: 'X' })).success, false);
  assert.ok(fb.data.mirror.usuarios.anagomez, 'sigue existiendo');
});

test('retirar y devolver el acceso (también en Auth)', async () => {
  const { fb, svc } = escenario();
  await svc.crear('carlos', nuevo);
  assert.ok((await svc.setRevocado('carlos', 'anagomez', true)).success);
  assert.strictEqual(fb.data.mirror.usuarios.anagomez.inquilino.revocado, true);
  assert.strictEqual(fb.authDisabled.anagomez, true);
  assert.strictEqual((await svc.listar('carlos'))[0].estado, 'revocado');
  assert.strictEqual((await svc.enviarAcceso('carlos', 'anagomez')).success, false, 'no reenvía a un retirado');
  assert.ok((await svc.setRevocado('carlos', 'anagomez', false)).success);
  assert.strictEqual(fb.authDisabled.anagomez, false);
});

test('editar fechas y permisos valida el rango', async () => {
  const { fb, svc } = escenario();
  await svc.crear('carlos', nuevo);
  assert.match((await svc.actualizar('carlos', 'anagomez', { fin: '2019-12-31' })).message, /anterior/);
  assert.ok((await svc.actualizar('carlos', 'anagomez', { fin: '2099-12-31', puedeReservar: true })).success);
  const d = fb.data.mirror.usuarios.anagomez.inquilino;
  assert.strictEqual(d.fin, '2099-12-31');
  assert.strictEqual(d.puedeReservar, true);
  assert.strictEqual(d.pagaAdministracion, true, 'conserva lo que no se envió');
});

test('los inquilinos no aparecen en la cartera de Pagos', async () => {
  const { fb, svc } = escenario();
  await svc.crear('carlos', nuevo);
  const payments = new PaymentsService(fb, { getDiasGraciaPropietario: async () => 10 }, {}, {});
  const lista = await payments.getAdminList('Villa Test', new Date().getFullYear(), false);
  const usuarios = lista.map((x) => x.username);
  assert.ok(usuarios.includes('carlos'));
  assert.ok(!usuarios.includes('anagomez'), 'el inquilino no tiene cartera propia');
  const reporte = await payments.getAlDiaReport('Villa Test', false);
  assert.ok(!reporte.propietarios.some((p) => p.usuario === 'anagomez'));
});

test('el guard corta la sesión del inquilino retirado o vencido', async () => {
  const { JwtAuthGuard } = require(path.join(__dirname, '../dist/auth/jwt-auth.guard.js'));
  const usuarios = {
    ana: { rol: 'inquilino', inquilino: { propietario: 'carlos', inicio: '2020-01-01' } },
    beto: { rol: 'inquilino', inquilino: { propietario: 'carlos', inicio: '2020-01-01', revocado: true } },
    caro: { rol: 'inquilino', inquilino: { propietario: 'carlos', inicio: '2020-01-01', fin: '2020-12-31' } },
    carlos: { rol: 'propietario' },
  };
  const fb = { isEnabled: () => true, liveVal: async () => usuarios };
  const guard = new JwtAuthGuard(
    { getAllAndOverride: () => false },
    { verify: (t) => ({ sub: t, rol: usuarios[t].rol }) },
    { get: () => 'true' },
    fb,
  );
  const ctx = (sub) => ({
    getType: () => 'http',
    getHandler: () => null,
    getClass: () => null,
    switchToHttp: () => ({ getRequest: () => ({ method: 'GET', headers: { authorization: `Bearer ${sub}` } }) }),
  });
  assert.strictEqual(await guard.canActivate(ctx('ana')), true);
  assert.strictEqual(await guard.canActivate(ctx('carlos')), true);
  // Con Nest real se valida el mensaje; con dependencias simuladas, solo el rechazo.
  const conMensaje = (re) => (e) => (typeof e?.message === 'string' ? re.test(e.message) : true);
  await assert.rejects(guard.canActivate(ctx('beto')), conMensaje(/retirado/));
  await assert.rejects(guard.canActivate(ctx('caro')), conMensaje(/venció/));
});

test('hoy y la hora se calculan en Colombia aunque el servidor esté en UTC', () => {
  // 21 nov 2026, 8:30 p. m. en Colombia = 22 nov 01:30 UTC.
  const noche = new Date('2026-11-22T01:30:00Z');
  assert.strictEqual(rules.hoyISO(noche), '2026-11-21');
  assert.strictEqual(rules.horaColombia(noche), '8:30 p. m.');
  assert.strictEqual(rules.horaColombia(new Date('2026-11-21T14:05:00Z')), '9:05 a. m.');
});

// ---- El inquilino toma la propiedad y los datos de su propietario ----
test('conPropietario: el inquilino hereda unidad, conjunto y contacto del propietario en vivo', () => {
  const { conPropietario } = require(path.join(__dirname, '../dist/tenants/tenant-rules.js'));
  const usuarios = [
    { usuario: 'carlos', rol: 'propietario', nombre: 'Carlos Pérez', phone: '3001112233', email: 'c@x.co', parcela: 'Casa 7', conjunto: 'Villa Mayra' },
    { usuario: 'ana', rol: 'inquilino', nombre: 'Ana', parcela: 'Casa 5', conjunto: 'Villa Mayra', inquilino: { propietario: 'carlos', propietarioNombre: 'Carlos' } },
    { usuario: 'huerfano', rol: 'inquilino', nombre: 'Luis', parcela: 'Casa 9', inquilino: { propietario: 'nadie', propietarioNombre: 'Nadie' } },
    { usuario: 'vigi', rol: 'vigilante', nombre: 'Vigi' },
  ];
  const r = conPropietario(usuarios);
  const ana = r.find((u) => u.usuario === 'ana');
  assert.strictEqual(ana.parcela, 'Casa 7', 'la unidad es la del propietario actual');
  assert.strictEqual(ana.propietarioNombre, 'Carlos Pérez');
  assert.strictEqual(ana.propietarioTelefono, '3001112233');
  assert.strictEqual(ana.inquilino.propietarioNombre, 'Carlos Pérez');
  const luis = r.find((u) => u.usuario === 'huerfano');
  assert.strictEqual(luis.parcela, 'Casa 9', 'sin propietario conserva lo suyo');
  assert.strictEqual(luis.propietarioNombre, 'Nadie');
  assert.strictEqual(r.find((u) => u.usuario === 'vigi'), usuarios[3]);
  assert.strictEqual(usuarios[1].parcela, 'Casa 5', 'no modifica el original');
});

// ---- "Pagado por": el pago de un inquilino queda a nombre del propietario y registra quién pagó ----
test('pagadoPorInquilino: solo un inquilino de esa cuenta', () => {
  const { pagadoPorInquilino } = require(path.join(__dirname, '../dist/tenants/tenant-rules.js'));
  const ana = { usuario: 'ana', nombre: 'Ana Gómez', rol: 'inquilino', inquilino: { propietario: 'carlos' } };
  assert.deepStrictEqual(pagadoPorInquilino(ana, 'Carlos'), { usuario: 'ana', nombre: 'Ana Gómez', rol: 'inquilino' });
  assert.strictEqual(pagadoPorInquilino(ana, 'pedro'), null);
  assert.strictEqual(pagadoPorInquilino({ usuario: 'carlos', rol: 'propietario' }, 'carlos'), null);
});

test('createPayments guarda pagadoPor y el recibo muestra "Pagado por"', async () => {
  const data = {
    mirror: {
      pagos: {},
      usuarios: { carlos: { usuario: 'carlos', nombre: 'Carlos Pérez', rol: 'propietario', parcela: 'Casa 7', conjunto: 'Villa' } },
      conjuntos: {},
    },
  };
  const parts = (p) => String(p || '').split('/').filter(Boolean);
  const getAt = (p) => parts(p).reduce((o, k) => (o == null ? undefined : o[k]), data);
  const setAt = (p, v) => { const ks = parts(p); let o = data; for (const k of ks.slice(0, -1)) o = o[k] ??= {}; o[ks.at(-1)] = JSON.parse(JSON.stringify(v)); };
  const fb = {
    isEnabled: () => true,
    liveVal: async (p) => getAt(p),
    liveValues: async (p) => Object.values(getAt(p) || {}),
    db: () => ({ ref: (p = '') => ({
      get: async () => { const v = getAt(p); return { exists: () => v !== undefined, val: () => v }; },
      update: async (vals) => { for (const [k, v] of Object.entries(vals)) setAt(p ? `${p}/${k}` : k, v); },
    }) }),
  };
  const s = new PaymentsService(fb, {}, {}, {});
  const pagadoPor = { usuario: 'ana', nombre: 'Ana Gómez', rol: 'inquilino' };
  const r = await s.createPayments({ usuario: 'carlos', montoPerMonth: 100000, year: 2026, estado: 'Pendiente', referencia: '', concepto: 'Pago X', pagadoPor });
  assert.ok(r.success);
  assert.deepStrictEqual(data.mirror.pagos[r.ids[0]].pagadoPor, pagadoPor);
  assert.strictEqual(data.mirror.pagos[r.ids[0]].usuario, 'carlos', 'el pago es de la cuenta del propietario');
  const rec = await s.buildReceiptData(r.ids);
  assert.ok(rec.ok);
  assert.strictEqual(rec.data.propietario, 'Carlos Pérez');
  assert.strictEqual(rec.data.pagadoPor, 'Ana Gómez (inquilino)');
  // Sin pagadoPor no se agrega el campo.
  const r2 = await s.createPayments({ usuario: 'carlos', montoPerMonth: 1, year: 2026, estado: 'Pendiente', referencia: '', concepto: 'Pago Y' });
  assert.strictEqual(data.mirror.pagos[r2.ids[0]].pagadoPor, undefined);
});

// ---- Inicio del vigilante: los inquilinos vigentes con su unidad y su propietario ----
test('Inicio del vigilante incluye inquilinos vigentes con datos del propietario', async () => {
  const { HomeService } = require(path.join(__dirname, '../dist/home/home.service.js'));
  const hoy = new Date().toISOString().slice(0, 10);
  const users = [
    { usuario: 'carlos', nombre: 'Carlos Pérez', rol: 'propietario', conjunto: 'Villa', parcela: 'Casa 7', phone: '3001112233' },
    { usuario: 'ana', nombre: 'Ana Gómez', rol: 'inquilino', conjunto: 'Villa', parcela: 'Casa 5', placa1: 'KLM482',
      inquilino: { propietario: 'carlos', inicio: '2020-01-01', fin: '2099-12-31' } },
    { usuario: 'luis', nombre: 'Luis', rol: 'inquilino', conjunto: 'Villa', inquilino: { propietario: 'carlos', inicio: '2020-01-01', revocado: true } },
    { usuario: 'vigi', nombre: 'Vigi', rol: 'vigilante', conjunto: 'Villa' },
  ];
  const payments = {
    readCollection: async (c) => (c === 'usuarios' ? users : []),
    getAlDiaReport: async () => ({ propietarios: [{ usuario: 'carlos', alDia: true }], totalAlDia: 1, totalMora: 0 }),
  };
  const svc = new HomeService({}, payments);
  svc.readReportesConTope = async () => [];
  const r = await svc.getDashboard({ role: 'vigilante', complex: 'Villa', username: 'vigi', year: Number(hoy.slice(0, 4)) });
  const ana = r.usuarios.find((u) => u.username === 'ana');
  assert.ok(ana, 'el inquilino vigente aparece');
  assert.strictEqual(ana.tipo, 'inquilino');
  assert.strictEqual(ana.unidad, 'Casa 7', 'unidad del propietario');
  assert.strictEqual(ana.propietarioNombre, 'Carlos Pérez');
  assert.strictEqual(ana.propietarioTelefono, '3001112233');
  assert.strictEqual(ana.paymentStatus, 'Al día', 'estado de pago de la unidad');
  assert.strictEqual(ana.placa1, 'KLM482');
  assert.ok(!r.usuarios.some((u) => u.username === 'luis'), 'con acceso retirado no aparece');
  assert.strictEqual(r.counts.total, 1, 'los conteos siguen siendo de propietarios');
  // El admin no recibe inquilinos en esta lista.
  const a = await svc.getDashboard({ role: 'admin', complex: 'Villa', username: 'x', year: Number(hoy.slice(0, 4)) });
  assert.ok(!a.usuarios.some((u) => u.tipo === 'inquilino'));
});
