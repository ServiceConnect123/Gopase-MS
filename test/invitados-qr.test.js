// QR de acceso de invitados: generar, compartir, validar en portería, anular.
// Ejecutar: npm run test:wsp (compila y corre con el runner nativo de Node).
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const qr = require(path.join(__dirname, '../dist/guests/guest-qr.js'));
const { hoyISO } = require(path.join(__dirname, '../dist/tenants/tenant-rules.js'));
const { GuestsService } = require(path.join(__dirname, '../dist/guests/guests.service.js'));

const dia = (offset) => {
  const [y, m, d] = hoyISO().split('-').map(Number);
  const f = new Date(Date.UTC(y, m - 1, d + offset));
  return f.toISOString().slice(0, 10);
};

// ---------------------------------------------------------------------------
// Reglas puras
// ---------------------------------------------------------------------------

test('validez: solo el día de la visita, una vez y si no fue anulado', () => {
  const hoy = '2026-11-21';
  const inv = { fecha: hoy, estado: 'Pendiente', qr: { codigo: 'K7P4QM' } };
  assert.deepStrictEqual(qr.validezQr(inv, hoy), { valido: true, motivo: 'valido', mensaje: 'Invitado autorizado.' });
  assert.strictEqual(qr.validezQr({ ...inv, fecha: '2026-11-20' }, hoy).motivo, 'vencido');
  assert.match(qr.validezQr({ ...inv, fecha: '2026-11-20' }, hoy).mensaje, /era para el viernes 20 nov/);
  assert.strictEqual(qr.validezQr({ ...inv, fecha: '2026-11-22' }, hoy).motivo, 'futuro');
  assert.strictEqual(qr.validezQr({ ...inv, estado: 'Ingresó', horaIngreso: '2:40 p. m.' }, hoy).mensaje, 'Ya se usó: ingresó a las 2:40 p. m.');
  assert.strictEqual(qr.validezQr({ ...inv, qr: { codigo: 'K7P4QM', anulado: true } }, hoy).motivo, 'anulado');
  assert.strictEqual(qr.validezQr({ fecha: hoy }, hoy).motivo, 'sin_qr');
});

test('el código se lee del QR (URL) o digitado', () => {
  assert.strictEqual(qr.normCodigoInvitado('https://gopasehome.site/app/guests?codigo=k7p4qm'), 'K7P4QM');
  assert.strictEqual(qr.normCodigoInvitado('https://gopasehome.site/invitado?c=K7P4QM&s=abc'), 'K7P4QM');
  assert.strictEqual(qr.normCodigoInvitado(' k7p-4qm '), 'K7P4QM');
});

test('la firma del enlace no se puede adivinar', () => {
  const f = qr.firmaEnlace('secreto', '123', 'K7P4QM');
  assert.ok(qr.firmaValida('secreto', '123', 'K7P4QM', f));
  assert.ok(!qr.firmaValida('secreto', '124', 'K7P4QM', f), 'otro invitado');
  assert.ok(!qr.firmaValida('otro', '123', 'K7P4QM', f), 'otro secreto');
  assert.ok(!qr.firmaValida('secreto', '123', 'K7P4QM', 'x'));
});

// ---------------------------------------------------------------------------
// Servicio (Firebase simulado)
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
    liveVal: async (p) => getAt(p) ?? null,
    liveValues: async (p) => Object.values(getAt(p) || {}),
    db: () => ({
      ref: (p = '') => ({
        get: async () => { const v = getAt(p); return { exists: () => v !== undefined, val: () => v }; },
        set: async (v) => setAt(p, JSON.parse(JSON.stringify(v))),
        update: async (vals) => { for (const [k, v] of Object.entries(vals)) setAt(`${p}/${k}`, v); },
        remove: async () => { const ks = parts(p); delete parts(ks.slice(0, -1).join('/')).reduce((o, k) => o[k], data)[ks[ks.length - 1]]; },
      }),
    }),
  };
}

function escenario() {
  const fb = fakeFirebase({
    mirror: {
      usuarios: {
        carlos: { usuario: 'carlos', nombre: 'Carlos Pérez', rol: 'propietario', conjunto: 'Villa Mayra', parcela: 'Casa 5' },
        laura: { usuario: 'laura', nombre: 'Laura Ríos', rol: 'propietario', conjunto: 'Otro Conjunto', parcela: 'Casa 1' },
      },
      invitados: {
        // Registro viejo: sin conjunto ni QR.
        viejo: { id: 'viejo', nombre: 'Plomero', fecha: dia(0), propietario: 'carlos', estado: 'Pendiente' },
      },
    },
  });
  const svc = new GuestsService(fb, { get: (k, d) => (k === 'JWT_SECRET' ? 'secreto-test' : d) });
  return { fb, svc };
}

test('registrar: toma conjunto y unidad del anfitrión y crea el QR', async () => {
  const { fb, svc } = escenario();
  const r = await svc.create({ id: 'g1', nombre: 'Juan Pérez', placa: 'KLM482', fecha: dia(0), propietario: 'carlos', conjunto: 'Falso', parcela: 'X' });
  assert.ok(r.success);
  const g = fb.data.mirror.invitados.g1;
  assert.strictEqual(g.conjunto, 'Villa Mayra');
  assert.strictEqual(g.parcela, 'Casa 5');
  assert.match(g.qr.codigo, /^[A-HJ-NP-Z2-9]{6}$/);
  assert.strictEqual(r.codigo, g.qr.codigo);

  const sinQr = await svc.create({ id: 'g2', nombre: 'Sin QR', fecha: dia(0), propietario: 'carlos', generarQr: false });
  assert.strictEqual(fb.data.mirror.invitados.g2.qr, undefined);
  assert.strictEqual(sinQr.codigo, undefined);
});

test('la portería solo ve los invitados de su conjunto (incluye registros viejos)', async () => {
  const { svc } = escenario();
  await svc.create({ id: 'g1', nombre: 'Juan', fecha: dia(0), propietario: 'carlos' });
  await svc.create({ id: 'g3', nombre: 'De otro', fecha: dia(0), propietario: 'laura' });
  const lista = await svc.list({ conjunto: 'Villa Mayra' });
  assert.deepStrictEqual(lista.map((g) => g.id).sort(), ['g1', 'viejo']);
  assert.strictEqual(lista.find((g) => g.id === 'viejo').conjunto, 'Villa Mayra');
  assert.strictEqual(lista.find((g) => g.id === 'g1').qrEstado, 'valido');
  assert.strictEqual(lista.find((g) => g.id === 'viejo').qrEstado, 'sin_qr');
});

test('compartir: imagen, enlace firmado y mensaje; crea QR a registros viejos', async () => {
  const { fb, svc } = escenario();
  const r = await svc.compartir('viejo');
  assert.ok(r.success);
  assert.ok(fb.data.mirror.invitados.viejo.qr.codigo, 'se le creó el QR');
  assert.match(r.data.enlace, /\/invitado\?c=[A-Z0-9]{6}&s=/);
  assert.match(r.data.textoWhatsapp, /Carlos te invitó a \*Villa Mayra\*/);
  assert.strictEqual(r.data.parcela, 'Casa 5');
  assert.ok(r.data.qr, 'imagen del QR');
});

test('enlace público: con firma muestra el QR; sin firma, nada', async () => {
  const { svc } = escenario();
  await svc.create({ id: 'g1', nombre: 'Juan Pérez', fecha: dia(0), propietario: 'carlos' });
  const { data } = await svc.compartir('g1');
  const [, c, s] = /c=([A-Z0-9]+)&s=(.+)$/.exec(data.enlace);
  const ok = await svc.acceso(c, s);
  assert.ok(ok.success);
  assert.strictEqual(ok.data.valido, true);
  assert.strictEqual(ok.data.codigo, c);
  assert.strictEqual(ok.data.anfitrion, 'Carlos');
  assert.strictEqual((await svc.acceso(c, 'firma-falsa')).success, false);
});

test('portería: válido hoy, entrada una sola vez, luego "ya se usó"', async () => {
  const { fb, svc } = escenario();
  const r = await svc.create({ id: 'g1', nombre: 'Juan Pérez', fecha: dia(0), propietario: 'carlos' });
  const inv = await svc.porCodigo(`https://x/app/guests?codigo=${r.codigo}`);
  const vista = await svc.paraPorteria(inv);
  assert.strictEqual(vista.valido, true);
  assert.strictEqual(vista.anfitrion, 'Carlos Pérez');

  const e1 = await svc.registrarIngresoQr(inv, 'vig');
  assert.ok(e1.success, e1.message);
  assert.strictEqual(fb.data.mirror.invitados.g1.estado, 'Ingresó');
  assert.match(fb.data.mirror.invitados.g1.horaIngreso, /^\d{1,2}:\d{2} [ap]\. m\.$/);

  const otra = await svc.registrarIngresoQr(await svc.porCodigo(r.codigo), 'vig');
  assert.strictEqual(otra.success, false);
  assert.strictEqual(otra.motivo, 'usado');
  // El enlace del invitado ya no muestra el QR.
  const { data } = await svc.compartir('g1');
  const [, c, s] = /c=([A-Z0-9]+)&s=(.+)$/.exec(data.enlace);
  const acc = await svc.acceso(c, s);
  assert.strictEqual(acc.data.valido, false);
  assert.strictEqual(acc.data.qr, undefined);
});

test('otro día o anulado: no deja entrar', async () => {
  const { svc } = escenario();
  const ayer = await svc.create({ id: 'a', nombre: 'Ayer', fecha: dia(-1), propietario: 'carlos' });
  const manana = await svc.create({ id: 'm', nombre: 'Mañana', fecha: dia(1), propietario: 'carlos' });
  assert.strictEqual((await svc.registrarIngresoQr(await svc.porCodigo(ayer.codigo), 'v')).motivo, 'vencido');
  assert.strictEqual((await svc.registrarIngresoQr(await svc.porCodigo(manana.codigo), 'v')).motivo, 'futuro');

  const hoy = await svc.create({ id: 'h', nombre: 'Hoy', fecha: dia(0), propietario: 'carlos' });
  assert.ok((await svc.anularQr('h')).success);
  assert.strictEqual((await svc.registrarIngresoQr(await svc.porCodigo(hoy.codigo), 'v')).motivo, 'anulado');
});
