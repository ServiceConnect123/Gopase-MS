// Seguridad: quién gestiona a qué usuario y validación de pagos ePayco.
// Ejecutar: npm run test:wsp (compila y corre con el runner nativo de Node).
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const dist = process.env.TEST_DIST || path.join(__dirname, '../dist');
const u = require(path.join(dist, 'auth/user-admin.rules.js'));
const e = require(path.join(dist, 'billing/epayco-rules.js'));

const prop = { uid: 'ana', rol: 'propietario', conjunto: 'Villa Mayra' };
const admin = { uid: 'adm', rol: 'admin', conjunto: 'Villa Mayra' };
const contador = { uid: 'cont', rol: 'contador', conjunto: 'Villa Mayra' };
const sa = { uid: 'root', rol: 'superAdmin', conjunto: '' };
const vecino = { uid: 'beto', rol: 'propietario', conjunto: 'Villa Mayra', existe: true };
const superObj = { uid: 'root', rol: 'superAdmin', conjunto: '', existe: true };
const otroAdmin = { uid: 'adm2', rol: 'admin', conjunto: 'Villa Mayra', existe: true };
const ajeno = { uid: 'zoe', rol: 'propietario', conjunto: 'Otro Conjunto', existe: true };

test('un propietario NO puede gestionar a otro usuario (ni al superAdmin)', () => {
  assert.equal(u.puedeGestionar(prop, vecino, true).ok, false);
  assert.equal(u.puedeGestionar(prop, superObj, true).ok, false);
});

test('cada uno puede editar su propio perfil, pero no borrarse ni resetearse', () => {
  const yo = { uid: 'ana', rol: 'propietario', conjunto: 'Villa Mayra', existe: true };
  assert.equal(u.puedeGestionar(prop, yo, true).ok, true);
  assert.equal(u.puedeGestionar(prop, yo, false).ok, false);
});

test('un propietario no puede cambiarse el rol ni el conjunto', () => {
  const yo = { uid: 'ana', rol: 'propietario', conjunto: 'Villa Mayra', existe: true };
  assert.equal(u.puedeAsignar(prop, yo, 'superAdmin', undefined).ok, false);
  assert.equal(u.puedeAsignar(prop, yo, 'admin', undefined).ok, false);
  assert.equal(u.puedeAsignar(prop, yo, 'propietario', 'Villa Mayra').ok, true); // sin cambios
  assert.equal(u.puedeAsignar(prop, yo, undefined, 'Otro Conjunto').ok, false);
});

test('el admin gestiona propietarios de SU conjunto, no de otros ni a admins/superAdmin', () => {
  assert.equal(u.puedeGestionar(admin, vecino, false).ok, true);
  assert.equal(u.puedeGestionar(admin, ajeno, false).ok, false);
  assert.equal(u.puedeGestionar(admin, superObj, false).ok, false);
  assert.equal(u.puedeGestionar(admin, otroAdmin, false).ok, false);
});

test('el admin no puede asignar superAdmin; sí admin dentro de su conjunto', () => {
  assert.equal(u.puedeAsignar(admin, vecino, 'superAdmin', undefined).ok, false);
  assert.equal(u.puedeAsignar(admin, vecino, 'admin', 'Villa Mayra').ok, true);
  assert.equal(u.puedeAsignar(admin, vecino, undefined, 'Otro Conjunto').ok, false);
});

test('un rol personalizado (contador) gestiona propietarios de su conjunto pero no asigna admin', () => {
  assert.equal(u.puedeGestionar(contador, vecino, false).ok, true);
  assert.equal(u.puedeAsignar(contador, vecino, 'admin', undefined).ok, false);
});

test('vigilante e inquilino no gestionan usuarios', () => {
  assert.equal(u.puedeGestionar({ uid: 'v', rol: 'vigilante', conjunto: 'Villa Mayra' }, vecino, true).ok, false);
  assert.equal(u.puedeGestionar({ uid: 'i', rol: 'inquilino', conjunto: 'Villa Mayra' }, vecino, true).ok, false);
});

test('el superAdmin puede todo', () => {
  assert.equal(u.puedeGestionar(sa, ajeno, false).ok, true);
  assert.equal(u.puedeAsignar(sa, ajeno, 'superAdmin', 'X').ok, true);
});

test('webhook ePayco: la firma es obligatoria fuera de pruebas', () => {
  assert.equal(e.firmaWebhookValida({ test: false, configurada: true, firmaRecibida: '', firmaValida: false }).ok, false);
  assert.equal(e.firmaWebhookValida({ test: false, configurada: true, firmaRecibida: 'abc', firmaValida: false }).ok, false);
  assert.equal(e.firmaWebhookValida({ test: false, configurada: false, firmaRecibida: 'abc', firmaValida: false }).ok, false);
  assert.equal(e.firmaWebhookValida({ test: false, configurada: true, firmaRecibida: 'abc', firmaValida: true }).ok, true);
  assert.equal(e.firmaWebhookValida({ test: true, configurada: false, firmaRecibida: '', firmaValida: false }).ok, true);
});

test('la referencia ePayco debe ser del mismo conjunto, plan y monto', () => {
  const pedido = { conjunto: 'Villa Mayra', planId: 'pro', montoEsperado: 120000 };
  const ok = { accepted: true, monto: 120000, message: 'aceptada', conjunto: 'villa mayra', planId: 'PRO' };
  assert.equal(e.transaccionCorresponde(ok, pedido).ok, true);
  assert.equal(e.transaccionCorresponde({ ...ok, accepted: false, message: 'rechazada' }, pedido).ok, false);
  assert.equal(e.transaccionCorresponde({ ...ok, conjunto: 'Otro' }, pedido).ok, false);
  assert.equal(e.transaccionCorresponde({ ...ok, planId: 'basico' }, pedido).ok, false);
  assert.equal(e.transaccionCorresponde({ ...ok, monto: 30000 }, pedido).ok, false);
  // Sin extras ni monto esperado conocido: basta con que esté aceptada.
  assert.equal(e.transaccionCorresponde({ accepted: true, monto: 1, message: 'aceptada' }, { conjunto: 'a', planId: 'b' }).ok, true);
});

test('refKey limpia caracteres prohibidos de RTDB', () => {
  assert.equal(e.refKey('12.3#4/5'), '12_3_4_5');
});
