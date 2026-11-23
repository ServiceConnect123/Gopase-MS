// Con qué inicia sesión cada usuario (cédula, correo o usuario generado).
// Ejecutar: npm run test:wsp (compila y corre con el runner nativo de Node).
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const r = require(path.join(__dirname, '../dist/users/login-acceso.rules.js'));
const { UsersService } = require(path.join(__dirname, '../dist/users/users.service.js'));
const { AuthLoginService } = require(path.join(__dirname, '../dist/auth/auth-login.service.js'));

test('normLoginCon acepta variantes y rechaza lo desconocido', () => {
  assert.strictEqual(r.normLoginCon('Cédula'), 'documento');
  assert.strictEqual(r.normLoginCon(' CC '), 'documento');
  assert.strictEqual(r.normLoginCon('Correo'), 'correo');
  assert.strictEqual(r.normLoginCon('email'), 'correo');
  assert.strictEqual(r.normLoginCon('USUARIO'), 'usuario');
  assert.strictEqual(r.normLoginCon(''), null);
  assert.strictEqual(r.normLoginCon('telefono'), null);
});

test('por defecto: cédula, luego correo, luego usuario; validación del dato', () => {
  assert.strictEqual(r.loginConPorDefecto({ documentNumber: '1.020.304', email: 'a@b.co' }), 'documento');
  assert.strictEqual(r.loginConPorDefecto({ documentNumber: '12', email: 'a@b.co' }), 'correo');
  assert.strictEqual(r.loginConPorDefecto({}), 'usuario');
  assert.ok(r.validarLoginCon('documento', { docNum: '' }));
  assert.ok(r.validarLoginCon('correo', { email: 'no-es-correo' }));
  assert.strictEqual(r.validarLoginCon('documento', { docNum: '1020304' }), null);
  assert.strictEqual(r.validarLoginCon('usuario', {}), null);
});

test('textoAcceso según el método (y cae al usuario si falta el dato)', () => {
  assert.deepStrictEqual(r.textoAcceso({ usuario: 'ana', loginCon: 'documento', docNum: '1020304' }), { etiqueta: 'Cédula', valor: '1020304' });
  assert.deepStrictEqual(r.textoAcceso({ usuario: 'ana', loginCon: 'correo', email: 'Ana@X.co' }), { etiqueta: 'Correo', valor: 'ana@x.co' });
  assert.deepStrictEqual(r.textoAcceso({ usuario: 'ana' }), { etiqueta: 'Usuario', valor: 'ana' });
  assert.deepStrictEqual(r.textoAcceso({ usuario: 'ana', loginCon: 'documento', docNum: '' }), { etiqueta: 'Usuario', valor: 'ana' });
});

const usuarios = {
  ana: { usuario: 'ana', nombre: 'Ana', rol: 'propietario', conjunto: 'Villa Sol', loginCon: 'documento', docNum: '1020304', email: 'fam@x.co' },
  beto: { usuario: 'beto', nombre: 'Beto', rol: 'propietario', conjunto: 'Villa Sol', loginCon: 'correo', email: 'fam@x.co' },
  ana2: { usuario: 'ana2', nombre: 'Ana', rol: 'admin', conjunto: 'Otro', loginCon: 'documento', docNum: '1020304' },
  viejo: { usuario: 'viejo', nombre: 'Viejo', rol: 'desactivado', conjunto: 'Villa Sol', loginCon: 'documento', docNum: '5555555' },
  sinmetodo: { usuario: 'sinmetodo', nombre: 'Sin', rol: 'propietario', conjunto: 'Villa Sol', docNum: '7777777' },
};

test('conflictoLogin: mismo conjunto choca, otro conjunto y desactivados no', () => {
  const lista = Object.values(usuarios);
  assert.match(r.conflictoLogin(lista, { usuario: 'nuevo', conjunto: 'villa sol', loginCon: 'documento', docNum: '1.020.304' }), /Ana ya inicia sesión con la cédula 1020304/);
  assert.match(r.conflictoLogin(lista, { usuario: 'nuevo', conjunto: 'Villa Sol', loginCon: 'correo', email: 'FAM@x.co' }), /Beto ya inicia sesión con el correo/);
  assert.strictEqual(r.conflictoLogin(lista, { usuario: 'ana', conjunto: 'Villa Sol', loginCon: 'documento', docNum: '1020304' }), null, 'uno mismo');
  assert.strictEqual(r.conflictoLogin(lista, { usuario: 'x', conjunto: 'Tercero', loginCon: 'documento', docNum: '1020304' }), null, 'otro conjunto');
  assert.strictEqual(r.conflictoLogin(lista, { usuario: 'x', conjunto: 'Villa Sol', loginCon: 'documento', docNum: '5555555' }), null, 'desactivado');
  assert.strictEqual(r.conflictoLogin(lista, { usuario: 'x', conjunto: 'Villa Sol', loginCon: 'documento', docNum: '7777777' }), null, 'el otro entra con usuario');
  assert.strictEqual(r.conflictoLogin(lista, { usuario: 'x', conjunto: 'Villa Sol', loginCon: 'usuario' }), null);
});

test('candidatosLogin: cédula (con puntos) y correo, solo de quien escogió ese método', () => {
  assert.deepStrictEqual(r.candidatosLogin(usuarios, '1.020.304').sort(), ['ana', 'ana2']);
  assert.deepStrictEqual(r.candidatosLogin(usuarios, 'FAM@x.co'), ['beto']);
  assert.deepStrictEqual(r.candidatosLogin(usuarios, '7777777'), [], 'sin método = solo usuario');
  assert.deepStrictEqual(r.candidatosLogin(usuarios, '5555555'), [], 'desactivado');
  assert.deepStrictEqual(r.candidatosLogin(usuarios, 'ana'), []);
});

// ---------------------------------------------------------------------------
// UsersService: valida al crear y al editar
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
  const authUsers = {};
  return {
    data,
    authUsers,
    isEnabled: () => true,
    liveVal: async (p) => getAt(p) ?? null,
    liveValues: async (p) => Object.values(getAt(p) || {}),
    db: () => ({
      ref: (p = '') => ({
        get: async () => { const v = getAt(p); return { exists: () => v !== undefined, val: () => v }; },
        set: async (v) => setAt(p, v),
        update: async (vals) => { for (const [k, v] of Object.entries(vals)) setAt(`${p}/${k}`, v); },
      }),
    }),
    auth: () => ({
      getUser: async (uid) => { if (!authUsers[uid]) throw new Error('no user record'); return authUsers[uid]; },
      createUser: async (u) => { authUsers[u.uid] = { ...u, customClaims: {} }; },
      updateUser: async (uid, v) => { authUsers[uid] = { ...(authUsers[uid] || {}), ...v }; },
      setCustomUserClaims: async (uid, c) => { authUsers[uid].customClaims = c; },
    }),
  };
}

function servicio() {
  const fb = fakeFirebase({ mirror: { usuarios: JSON.parse(JSON.stringify(usuarios)), conjuntos: {} } });
  const config = { get: (_k, def) => def };
  return { fb, svc: new UsersService(fb, config) };
}

test('create guarda loginCon, exige el dato y rechaza la cédula repetida en el conjunto', async () => {
  const { fb, svc } = servicio();
  const ok = await svc.create({ usuario: 'carla', nombre: 'Carla', rol: 'propietario', conjunto: 'Villa Sol', documentNumber: '9090909', loginCon: 'Cédula' });
  assert.strictEqual(ok.success, true, ok.message);
  assert.strictEqual(fb.data.mirror.usuarios.carla.loginCon, 'documento');

  const sinDato = await svc.create({ usuario: 'dani', nombre: 'Dani', rol: 'propietario', conjunto: 'Villa Sol', loginCon: 'correo' });
  assert.strictEqual(sinDato.success, false);
  assert.match(sinDato.message, /correo válido/);

  const repetida = await svc.create({ usuario: 'eva', nombre: 'Eva', rol: 'propietario', conjunto: 'Villa Sol', documentNumber: '1020304', loginCon: 'documento' });
  assert.strictEqual(repetida.success, false);
  assert.match(repetida.message, /Ana ya inicia sesión/);
  assert.strictEqual(fb.data.mirror.usuarios.eva, undefined);
});

test('update valida con los datos resultantes', async () => {
  const { fb, svc } = servicio();
  // Cambiar la cédula de quien entra con cédula a una ya usada → error.
  const r1 = await svc.update('sinmetodo', { loginCon: 'documento', documentNumber: '1020304' });
  assert.strictEqual(r1.success, false);
  // Pasar a correo sin correo → error.
  const r2 = await svc.update('sinmetodo', { loginCon: 'correo' });
  assert.strictEqual(r2.success, false);
  // Pasar a cédula con su propia cédula → ok.
  const r3 = await svc.update('sinmetodo', { loginCon: 'documento' });
  assert.strictEqual(r3.success, true, r3.message);
  assert.strictEqual(fb.data.mirror.usuarios.sinmetodo.loginCon, 'documento');
  // Método inválido.
  const r4 = await svc.update('ana', { loginCon: 'huella' });
  assert.strictEqual(r4.success, false);
});

// ---------------------------------------------------------------------------
// Login: usuario de siempre, cédula, correo y cuenta con correo real en Auth
// ---------------------------------------------------------------------------

test('login entra con usuario, cédula o correo; el usuario sigue funcionando', async () => {
  const fb = fakeFirebase({ mirror: { usuarios: JSON.parse(JSON.stringify(usuarios)) } });
  // Correos con los que quedaron las cuentas en Auth y su contraseña.
  const cuentas = {
    'ana@gopase.local': { uid: 'ana', pass: 'clave-ana' },
    'beto-real@correo.com': { uid: 'beto', pass: 'clave-beto' }, // creado sin email sintético
    'ana2@gopase.local': { uid: 'ana2', pass: 'clave-admin' },
  };
  fb.authUsers.ana = { email: 'ana@gopase.local' };
  fb.authUsers.beto = { email: 'beto-real@correo.com' };
  fb.authUsers.ana2 = { email: 'ana2@gopase.local' };
  const llamadas = [];
  global.fetch = async (_url, init) => {
    const { email, password } = JSON.parse(init.body);
    llamadas.push(email);
    const c = cuentas[email];
    if (c && c.pass === password) return { ok: true, json: async () => ({ localId: c.uid }) };
    return { ok: false, json: async () => ({ error: { message: c ? 'INVALID_PASSWORD' : 'EMAIL_NOT_FOUND' } }) };
  };
  const config = { get: (k, def) => (k === 'FIREBASE_WEB_API_KEY' ? 'key' : k === 'AUTH_EMAIL_DOMAIN' ? 'gopase.local' : def) };
  const svc = new AuthLoginService(fb, config, {}, {}, undefined, undefined);
  const salidas = [];
  svc.buildUserResponse = async (uid) => { salidas.push(uid); return { success: true, user: { username: uid } }; };

  assert.strictEqual((await svc.login('ana', undefined, 'clave-ana')).success, true, 'usuario de siempre');
  assert.strictEqual((await svc.login('1.020.304', undefined, 'clave-ana')).success, true, 'cédula');
  assert.strictEqual((await svc.login('1020304', undefined, 'clave-admin')).success, true, 'misma cédula, otro conjunto: decide la contraseña');
  assert.strictEqual((await svc.login('FAM@x.co', undefined, 'clave-beto')).success, true, 'correo');
  assert.strictEqual((await svc.login('beto', undefined, 'clave-beto')).success, true, 'usuario con correo real en Auth');
  assert.deepStrictEqual(salidas, ['ana', 'ana', 'ana2', 'beto', 'beto']);
  assert.strictEqual((await svc.login('1020304', undefined, 'mala')).success, false);
  assert.strictEqual((await svc.login('7777777', undefined, 'x')).success, false, 'sin método no entra por cédula');
});
