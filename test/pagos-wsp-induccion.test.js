// Pagos por WhatsApp: inducción del formato a quien envía un pago sin #pago.
// Ejecutar: npm run test:wsp
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const D = require(path.join(__dirname, '../dist/pagos-whatsapp/pagos-wsp.induccion.js'));
const P = require(path.join(__dirname, '../dist/pagos-whatsapp/pagos-wsp.parser.js'));

test('textos que hablan de un pago (sin #pago)', () => {
  for (const t of ['Ya pagué la administración', 'adjunto comprobante', 'Hice la transferencia', 'consigné ayer', 'pago de la administración de noviembre', 'le mandé por Nequi'])
    assert.strictEqual(D.pareceAvisoDePago(t), true, t);
});

test('textos normales o con #pago no disparan la inducción', () => {
  for (const t of ['Buenos días vecinos', 'alguien tiene el número del portero?', '', '#pago Tel: 3001234567 nov', 'Ana Pérez, casa #4'])
    assert.strictEqual(D.pareceAvisoDePago(t), false, t);
});

test('máximo una inducción por periodo', () => {
  const dia = 24 * 3600_000;
  assert.strictEqual(D.debeInducir(null, 0, dia), true);
  const ayer = new Date(Date.UTC(2026, 10, 24, 12)).toISOString();
  assert.strictEqual(D.debeInducir(ayer, Date.UTC(2026, 10, 24, 20), dia), false);
  assert.strictEqual(D.debeInducir(ayer, Date.UTC(2026, 10, 25, 12), dia), true);
  assert.strictEqual(D.debeInducir('basura', 0, dia), true);
});

test('mensaje personalizado con el formato #pago', () => {
  const t = D.mensajeInduccion({ tipo: 'imagen', telefono: '3009998877', mes: 'Noviembre', valor: 60000, nombre: 'Ana P.', grupoNombre: 'Los Pinos' });
  assert.match(t, /Hola, Ana P\./);
  assert.match(t, /enviaste un comprobante en el grupo «Los Pinos»/);
  assert.match(t, /#pago\nTel: 3009998877\nMes: Noviembre\nValor: 60000/);
  assert.match(t, /responde a la foto/);
});

test('la plantilla del mensaje la entiende el parser de #pago', () => {
  const t = D.mensajeInduccion({ tipo: 'imagen', telefono: '3009998877', mes: 'Noviembre', valor: 60000 });
  const bloque = t.slice(t.indexOf('#pago'), t.indexOf('\n\n', t.indexOf('#pago')));
  const r = P.parsearMensajePago(bloque);
  assert.strictEqual(r.esPago, true);
  assert.deepStrictEqual(r.identificador, { tipo: 'telefono', valor: '3009998877' });
  assert.deepStrictEqual(r.meses.map((m) => m.mes), ['Noviembre']);
  assert.strictEqual(r.valor, 60000);
  assert.deepStrictEqual(r.desconocidos, []);
});

test('sin datos del residente usa textos genéricos', () => {
  const t = D.mensajeInduccion({ tipo: 'texto' });
  assert.match(t, /^👋 Hola\. Vi tu mensaje sobre un pago,/);
  assert.match(t, /Tel: tu celular registrado/);
  assert.match(t, /Valor: el valor que pagaste/);
  assert.match(t, new RegExp(`Mes: ${D.mesActual()}`));
});

test('mes actual en hora de Colombia', () => {
  assert.strictEqual(D.mesActual(new Date('2026-12-01T03:00:00Z')), 'Noviembre'); // 30 nov 22:00 en Bogotá
  assert.strictEqual(D.mesActual(new Date('2026-12-01T06:00:00Z')), 'Diciembre');
});
