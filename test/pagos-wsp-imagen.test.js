// Pagos por WhatsApp: de dónde sale la foto del comprobante (pie de foto,
// respuesta a la foto, o foto enviada justo antes del #pago).
// Ejecutar: npm run test:wsp
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const I = require(path.join(__dirname, '../dist/pagos-whatsapp/pagos-wsp.imagen.js'));

const GRUPO = '120363000000000000@g.us';
const ANA = '573001112233@s.whatsapp.net';
const BETO = '573004445566@s.whatsapp.net';
const foto = (caption) => ({ imageMessage: { mimetype: 'image/jpeg', mediaKey: 'k', directPath: '/p', caption } });

test('texto e imagen del mensaje, con envolturas', () => {
  const m = I.desenvolver({ ephemeralMessage: { message: foto('#pago nov') } });
  assert.ok(I.imagenDe(m));
  assert.strictEqual(I.textoDe(m), '#pago nov');
  assert.strictEqual(I.textoDe({ conversation: '  hola ' }), 'hola');
  assert.strictEqual(I.imagenDe({ documentMessage: { mimetype: 'image/png' } }).mimetype, 'image/png');
  assert.strictEqual(I.imagenDe({ documentMessage: { mimetype: 'application/pdf' } }), null);
});

test('respuesta (cita) a la foto del comprobante', () => {
  const m = {
    extendedTextMessage: {
      text: '#pago ana97 nov',
      contextInfo: { stanzaId: 'ABC123', participant: ANA, quotedMessage: foto(undefined) },
    },
  };
  const c = I.imagenCitada(m, GRUPO);
  assert.ok(c);
  assert.deepStrictEqual(c.key, { remoteJid: GRUPO, id: 'ABC123', participant: ANA, fromMe: false });
  assert.ok(c.message.imageMessage.mediaKey);
});

test('cita a una foto reenviada o temporal (con envoltura)', () => {
  const m = { extendedTextMessage: { text: '#pago', contextInfo: { stanzaId: 'X', quotedMessage: { viewOnceMessageV2: { message: foto() } } } } };
  assert.ok(I.imagenCitada(m, GRUPO).message.imageMessage);
});

test('cita a un texto (sin foto) no cuenta como comprobante', () => {
  const m = { extendedTextMessage: { text: '#pago', contextInfo: { stanzaId: 'X', quotedMessage: { conversation: 'ya pagué' } } } };
  assert.strictEqual(I.imagenCitada(m, GRUPO), null);
  assert.strictEqual(I.imagenCitada({ conversation: '#pago' }, GRUPO), null);
});

test('foto y luego #pago del mismo remitente, dentro de la ventana', () => {
  const f = new I.FotosRecientes(5 * 60_000);
  const msg = { key: { remoteJid: GRUPO, id: 'F1', participant: ANA }, message: foto() };
  f.recordar('conj', GRUPO, ANA, msg, 1000);
  assert.strictEqual(f.tomar('conj', GRUPO, BETO, 2000), null, 'otro remitente no toma la foto');
  assert.strictEqual(f.tomar('conj', 'otro@g.us', ANA, 2000), null, 'otro chat no toma la foto');
  assert.strictEqual(f.tomar('conj', GRUPO, ANA, 2000), msg);
  assert.strictEqual(f.tomar('conj', GRUPO, ANA, 2000), null, 'se usa una sola vez');
});

test('foto vieja (fuera de la ventana) no se usa', () => {
  const f = new I.FotosRecientes(5 * 60_000);
  f.recordar('conj', GRUPO, ANA, { key: { remoteJid: GRUPO, id: 'F1' }, message: foto() }, 0);
  assert.strictEqual(f.tomar('conj', GRUPO, ANA, 5 * 60_000 + 1), null);
});

test('la última foto del remitente reemplaza a la anterior', () => {
  const f = new I.FotosRecientes();
  f.recordar('conj', GRUPO, ANA, { key: { remoteJid: GRUPO, id: 'F1' }, message: foto() }, 0);
  f.recordar('conj', GRUPO, ANA, { key: { remoteJid: GRUPO, id: 'F2' }, message: foto() }, 10);
  assert.strictEqual(f.tomar('conj', GRUPO, ANA, 20).key.id, 'F2');
});

test('memoria acotada', () => {
  const f = new I.FotosRecientes(60_000, 3);
  for (let i = 0; i < 10; i++) f.recordar('conj', GRUPO, `57300000000${i}@s.whatsapp.net`, { key: { remoteJid: GRUPO, id: 'F' + i }, message: foto() }, i);
  assert.strictEqual(f.tamano, 3);
  assert.strictEqual(f.tomar('conj', GRUPO, '573000000009@s.whatsapp.net', 20).key.id, 'F9');
});
