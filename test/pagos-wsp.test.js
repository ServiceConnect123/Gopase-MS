// Pagos por WhatsApp: lectura del mensaje #pago e identificación del pagador.
// Ejecutar: npm run test:wsp (compila y corre con el runner nativo de Node).
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const P = require(path.join(__dirname, '../dist/pagos-whatsapp/pagos-wsp.parser.js'));
const M = require(path.join(__dirname, '../dist/pagos-whatsapp/pagos-wsp.matcher.js'));

const meses = (r) => r.meses.map((m) => m.mes + (m.anio ? ' ' + m.anio : ''));

test('sin #pago no es un pago', () => {
  assert.strictEqual(P.parsearMensajePago('Buenos días vecinos, alguien tiene el número del portero?').esPago, false);
  assert.strictEqual(P.parsearMensajePago('').esPago, false);
});

test('formato largo con etiquetas', () => {
  const r = P.parsearMensajePago('#pago\nUsuario: Alex97\nMes: noviembre\nValor: $120.000\nFondo: Cuota extra');
  assert.deepStrictEqual(r.identificador, { tipo: 'usuario', valor: 'Alex97' });
  assert.deepStrictEqual(meses(r), ['Noviembre']);
  assert.strictEqual(r.valor, 120000);
  assert.strictEqual(r.fondo, 'Cuota extra');
});

test('etiquetas de documento y teléfono, con tildes y mayúsculas', () => {
  assert.deepStrictEqual(P.parsearMensajePago('#PAGO\nCédula: 1.020.304.050').identificador, { tipo: 'documento', valor: '1020304050' });
  assert.deepStrictEqual(P.parsearMensajePago('#pago\nTeléfono: +57 300 123 4567').identificador, { tipo: 'telefono', valor: '573001234567' });
});

test('formato corto', () => {
  const r = P.parsearMensajePago('#pago alex97 nov 120000');
  assert.deepStrictEqual(r.identificador, { tipo: 'usuario', valor: 'alex97' });
  assert.deepStrictEqual(meses(r), ['Noviembre']);
  assert.strictEqual(r.valor, 120000);
  const n = P.parsearMensajePago('#pago 3001234567 oct-dic 2026 $360.000');
  assert.deepStrictEqual(n.identificador, { tipo: 'numero', valor: '3001234567' });
  assert.deepStrictEqual(meses(n), ['Octubre 2026', 'Noviembre 2026', 'Diciembre 2026']);
  assert.strictEqual(n.valor, 360000);
  const solo = P.parsearMensajePago('Hola #pago');
  assert.strictEqual(solo.esPago, true);
  assert.strictEqual(solo.identificador, undefined);
});

test('meses: rangos, listas y cruce de año', () => {
  assert.deepStrictEqual(meses({ meses: P.parsearMeses('octubre y noviembre') }), ['Octubre', 'Noviembre']);
  assert.deepStrictEqual(meses({ meses: P.parsearMeses('nov a feb') }), ['Noviembre', 'Diciembre', 'Enero', 'Febrero']);
  assert.deepStrictEqual(meses({ meses: P.parsearMeses('ene, ene, feb') }), ['Enero', 'Febrero']);
});

test('valores en distintos formatos', () => {
  assert.strictEqual(P.parsearValor('120.000'), 120000);
  assert.strictEqual(P.parsearValor('$ 120.000,00'), 120000);
  assert.strictEqual(P.parsearValor('120,000.00'), 120000);
  assert.strictEqual(P.parsearValor('1.200.000'), 1200000);
  assert.strictEqual(P.parsearValor('60000'), 60000);
  assert.strictEqual(P.parsearValor('abc'), undefined);
});

test('plantillas para copiar', () => {
  const p = P.plantillasPago('alex97');
  assert.match(p.larga, /^#pago\nUsuario: alex97\n/);
  assert.strictEqual(p.corta, '#pago alex97 nov 120000');
  assert.deepStrictEqual(P.parsearMensajePago(p.larga).identificador, { tipo: 'usuario', valor: 'alex97' });
});

const USUARIOS = [
  { usuario: 'alex97', nombre: 'Alex Gómez Ruiz', rol: 'propietario', phone: '3001234567', docNum: '1020304050', conjunto: 'Villa Mayra' },
  { usuario: 'ana12', nombre: 'Ana Pérez', rol: 'propietario', phone: '+57 310 555 0000', docNum: '52111222', conjunto: 'Villa Mayra' },
  { usuario: 'otro', nombre: 'Otro Conjunto', rol: 'propietario', phone: '3209998888', docNum: '999', conjunto: 'Los Pinos' },
  { usuario: 'vig', nombre: 'Vigilante', rol: 'vigilante', phone: '3150000000', conjunto: 'Villa Mayra' },
  { usuario: 'laura', nombre: 'Laura Inquilina', rol: 'inquilino', phone: '3017777777', conjunto: 'Villa Mayra',
    inquilino: { propietario: 'alex97', pagaAdministracion: true, inicio: '2026-01-01', fin: '2099-12-31' } },
  { usuario: 'pedro', nombre: 'Pedro Inquilino', rol: 'inquilino', phone: '3018888888', conjunto: 'Villa Mayra',
    inquilino: { propietario: 'ana12', pagaAdministracion: false, inicio: '2026-01-01', fin: '2099-12-31' } },
];
const id = (texto, remitente) => M.identificarPagador({ usuarios: USUARIOS, conjunto: 'villa mayra', parseado: P.parsearMensajePago(texto), telefonoRemitente: remitente });

test('identifica por usuario, documento y teléfono', () => {
  const u = id('#pago Usuario: ALEX97', '573001234567');
  assert.deepStrictEqual([u.ok, u.cuenta.usuario, u.via, u.enviadoPorOtro], [true, 'alex97', 'usuario', false]);
  assert.strictEqual(id('#pago Documento: 52.111.222').cuenta.usuario, 'ana12');
  assert.strictEqual(id('#pago Tel: 3105550000').cuenta.usuario, 'ana12');
  assert.strictEqual(id('#pago 1020304050 nov').via, 'documento');
  assert.strictEqual(id('#pago 3001234567').via, 'telefono');
});

test('sin identificador usa el teléfono del remitente', () => {
  const r = id('#pago nov', '573105550000');
  assert.deepStrictEqual([r.ok, r.cuenta.usuario, r.via], [true, 'ana12', 'remitente']);
  assert.strictEqual(id('#pago', '573009990000').motivo, 'sin_identificador');
  assert.strictEqual(id('#pago').motivo, 'sin_identificador');
});

test('solo busca en el conjunto del número vinculado', () => {
  assert.strictEqual(id('#pago Usuario: otro').motivo, 'no_encontrado');
});

test('enviado por otra persona queda marcado', () => {
  const r = id('#pago Usuario: alex97', '573150000000');
  assert.deepStrictEqual([r.ok, r.enviadoPorOtro], [true, true]);
});

test('inquilino: paga en la cuenta del propietario solo si está habilitado', () => {
  const r = id('#pago', '573017777777');
  assert.deepStrictEqual([r.ok, r.cuenta.usuario, r.persona.usuario, r.pagadoPor.rol], [true, 'alex97', 'laura', 'inquilino']);
  assert.strictEqual(id('#pago', '573018888888').motivo, 'inquilino_sin_permiso');
});

test('roles sin cartera no reciben pagos', () => {
  assert.strictEqual(id('#pago Usuario: vig').motivo, 'sin_cartera');
});

test('número que coincide con teléfono de uno y documento de otro: ambiguo', () => {
  const usuarios = [...USUARIOS, { usuario: 'z', nombre: 'Z', rol: 'propietario', docNum: '3001234567', conjunto: 'Villa Mayra' }];
  const r = M.identificarPagador({ usuarios, conjunto: 'Villa Mayra', parseado: P.parsearMensajePago('#pago 3001234567') });
  assert.strictEqual(r.motivo, 'ambiguo');
});

test('nombre corto para la confirmación', () => {
  assert.strictEqual(M.nombreCorto('Alex Gómez Ruiz'), 'Alex G.');
  assert.strictEqual(M.nombreCorto('Ana'), 'Ana');
});

// ---------------------------------------------------------------- servicio
const { PagosWspService, resolverPeriodos } = require(path.join(__dirname, '../dist/pagos-whatsapp/pagos-wsp.service.js'));

function fakeFirebase(inicial = {}) {
  const data = JSON.parse(JSON.stringify(inicial));
  const partes = (p) => p.split('/').filter(Boolean);
  const leer = (p) => partes(p).reduce((o, k) => (o == null ? undefined : o[k]), data);
  const escribir = (p, v) => { const ks = partes(p); let o = data; ks.slice(0, -1).forEach((k) => { o[k] = o[k] || {}; o = o[k]; }); o[ks[ks.length - 1]] = JSON.parse(JSON.stringify(v)); };
  return {
    data,
    isEnabled: () => true,
    liveVal: async (p) => leer(p) ?? null,
    liveValues: async (p) => Object.values(leer(p) || {}),
    db: () => ({ ref: (p) => ({ set: async (v) => escribir(p, v) }) }),
  };
}

const PAGABLES = {
  cuota: 60000,
  primeroPagable: { anio: 2026, mes: 'Marzo' },
  meses: ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre']
    .map((mes, i) => ({ anio: 2026, mes, idx: 2026 * 12 + i, estado: i < 2 ? 'revision' : i === 5 || i === 6 ? 'pagado' : i <= 10 ? 'pendiente' : 'disponible' })),
};

test('resolverPeriodos: meses escritos, por valor o el siguiente pendiente', () => {
  const p = (texto, valor) => resolverPeriodos(PAGABLES, P.parsearMensajePago(texto), valor);
  assert.deepStrictEqual(p('#pago nov').periodos, [{ mes: 'Noviembre', anio: 2026 }]);
  assert.deepStrictEqual(p('#pago').periodos, [{ mes: 'Marzo', anio: 2026 }]);
  assert.deepStrictEqual(p('#pago', 120000).periodos, [{ mes: 'Marzo', anio: 2026 }, { mes: 'Abril', anio: 2026 }]);
  // Mayo y luego junio pagado: no salta meses
  assert.deepStrictEqual(p('#pago', 240000).periodos.map((x) => x.mes), ['Marzo', 'Abril', 'Mayo']);
  assert.match(p('#pago junio').message, /ya está pagado/);
});

function armar({ ia = { success: true, monto: 60000, analysis: { esAutentico: true, checkedDestinatario: true, destinatarioCorrecto: true } }, crear } = {}) {
  const fb = fakeFirebase({
    mirror: { usuarios: {
      a: { usuario: 'alex97', nombre: 'Alex Gómez', rol: 'propietario', phone: '3001234567', docNum: '1020304050', conjunto: 'Villa Mayra', parcela: '97' },
      l: { usuario: 'laura', nombre: 'Laura', rol: 'inquilino', phone: '3017777777', conjunto: 'Villa Mayra', inquilino: { propietario: 'alex97', pagaAdministracion: true, inicio: '2026-01-01', fin: '2099-12-31' } },
    } },
  });
  const creados = [];
  const payments = {
    analyzeReceipt: async () => ia,
    getPayableMonths: async () => PAGABLES,
    createPayments: async (input) => { creados.push(input); return crear ? crear(input) : { success: true, ids: ['p1'] }; },
  };
  const drive = { uploadImage: async () => ({ success: true, directLink: 'https://drive/x.jpg' }) };
  const props = { getSecretsByConjunto: async () => ({ driveFolderId: 'F' }) };
  const wsp = { alRecibirMensaje() {}, configurarLectura() {} };
  return { svc: new PagosWspService(fb, payments, drive, props, wsp), fb, creados };
}
const msg = (o = {}) => ({ conjunto: 'Villa Mayra', sesion: 'villa mayra', id: 'M1', clave: {}, esGrupo: true, chatJid: 'g@g.us', responderA: '573001234567@s.whatsapp.net', telefono: '573001234567', texto: '#pago nov', imagen: Buffer.from('img-1'), ...o });

test('registra el pago En revisión y responde en privado', async () => {
  const { svc, creados, fb } = armar();
  const s = await svc.procesar(msg());
  assert.strictEqual(s.estado, 'registrado');
  assert.strictEqual(s.reaccion, '✅');
  assert.match(s.respuesta, /noviembre 2026 por \$60\.000 \(Alex G\. · 97\)/);
  const c = creados[0];
  assert.deepStrictEqual([c.usuario, c.estado, c.montoPerMonth, c.tipoRecaudo], ['alex97', 'Pendiente', '60000', 'Administración']);
  assert.deepStrictEqual(c.periodos, [{ mes: 'Noviembre', anio: 2026 }]);
  assert.match(c.referencia, /^IMG:https:\/\/drive\/x\.jpg \| WhatsApp grupo desde \+573001234567$/);
  assert.strictEqual(fb.data.wsp_pagos.registros['villa mayra'].M1.estado, 'registrado');
});

test('el mismo mensaje o el mismo comprobante no se registran dos veces', async () => {
  const { svc, creados, fb } = armar();
  await svc.procesar(msg());
  fb.data.mirror.pagos = { p1: { id: 'p1', estado: 'Pendiente' } };
  assert.strictEqual((await svc.procesar(msg())).estado, 'duplicado');
  const otro = await svc.procesar(msg({ id: 'M2' }));
  assert.deepStrictEqual([otro.estado, creados.length], ['duplicado', 1]);
  assert.match(otro.respuesta, /ya se había registrado/);
});

test('sin foto o sin identificar: rechaza con instrucción', async () => {
  const { svc, creados } = armar();
  assert.match((await svc.procesar(msg({ imagen: null }))).respuesta, /foto del comprobante/);
  const r = await svc.procesar(msg({ id: 'M3', telefono: '573009990000', texto: '#pago' }));
  assert.deepStrictEqual([r.estado, r.reaccion], ['rechazado', '❓']);
  assert.strictEqual(creados.length, 0);
});

test('enviado por otro número: avisa al titular', async () => {
  const { svc } = armar();
  const s = await svc.procesar(msg({ telefono: '573150000000', texto: '#pago Usuario: alex97 nov' }));
  assert.strictEqual(s.estado, 'registrado');
  assert.strictEqual(s.aviso.telefono, '3001234567');
  assert.match(s.aviso.texto, /a tu nombre, enviado desde otro número/);
});

test('inquilino habilitado: va a la cuenta del propietario con pagadoPor', async () => {
  const { svc, creados } = armar();
  await svc.procesar(msg({ telefono: '573017777777', texto: '#pago' }));
  assert.deepStrictEqual([creados[0].usuario, creados[0].pagadoPor.usuario], ['alex97', 'laura']);
});

test('valor escrito distinto al leído y cuenta de destino equivocada: marcas para el admin', async () => {
  const { svc, creados } = armar({ ia: { success: true, monto: 60000, analysis: { esAutentico: false, checkedDestinatario: true, destinatarioCorrecto: false } } });
  const s = await svc.procesar(msg({ texto: '#pago nov 90000' }));
  assert.match(creados[0].referencia, /\[AI:MANIPULACION,DESTINATARIO,MONTO\]$/);
  assert.match(s.respuesta, /cuenta de destino/);
});

test('sin valor escrito usa el leído por la IA; si la IA falla usa la cuota', async () => {
  const a = armar({ ia: { success: true, monto: 120000, analysis: null } });
  await a.svc.procesar(msg({ texto: '#pago' }));
  assert.deepStrictEqual(a.creados[0].periodos.map((p) => p.mes), ['Marzo', 'Abril']);
  const b = armar({ ia: { success: false, iaNoDisponible: true } });
  await b.svc.procesar(msg({ texto: '#pago' }));
  assert.deepStrictEqual([b.creados[0].montoPerMonth, b.creados[0].periodos.length], ['60000', 1]);
});

test('la IA dice que no es un comprobante: no crea el pago y explica', async () => {
  const { svc, creados, fb } = armar({ ia: { success: true, monto: 0, analysis: { esComprobante: false, esAutentico: true, motivo: 'selfie' } } });
  const s = await svc.procesar(msg());
  assert.deepStrictEqual([s.estado, s.reaccion, creados.length], ['rechazado', '❓', 0]);
  assert.match(s.respuesta, /no parece un comprobante/);
  assert.match(fb.data.wsp_pagos.registros['villa mayra'].M1.motivo, /^no_es_comprobante/);
});

test('sin lectura de la IA: el pago queda marcado SIN_VALIDAR', async () => {
  const { svc, creados } = armar({ ia: { success: false, iaNoDisponible: true } });
  const s = await svc.procesar(msg());
  assert.strictEqual(s.estado, 'registrado');
  assert.match(creados[0].referencia, /\[AI:SIN_VALIDAR\]$/);
});

test('documento en el grupo: registra pero sugiere usar usuario o teléfono', async () => {
  const { svc } = armar();
  const s = await svc.procesar(msg({ texto: '#pago Documento: 1020304050 nov' }));
  assert.match(s.respuesta, /por privacidad/i);
  const chat = await armar().svc.procesar(msg({ esGrupo: false, texto: '#pago Documento: 1020304050 nov' }));
  assert.doesNotMatch(chat.respuesta, /privacidad/i);
  assert.strictEqual(chat.reaccion, undefined);
});

test('si createPayments rechaza (meses no seguidos) se informa', async () => {
  const { svc } = armar({ crear: () => ({ success: false, ids: [], message: 'Primero paga marzo.' }) });
  const s = await svc.procesar(msg());
  assert.deepStrictEqual([s.estado, s.respuesta], ['rechazado', 'No pude registrar el pago: Primero paga marzo.']);
});

// ---------------------------------------------------------------- ajustes
test('meses mal escritos se corrigen; nombres cortos de usuario no', () => {
  const r = P.parsearMensajePago('#pago alex97 novimbre');
  assert.deepStrictEqual([meses(r), r.desconocidos], [['Noviembre'], []]);
  assert.deepStrictEqual(meses(P.parsearMensajePago('#pago\nMes: dicienbre')), ['Diciembre']);
  assert.deepStrictEqual(meses(P.parsearMensajePago('#pago\nMes: setiembre')), ['Septiembre']);
  assert.deepStrictEqual(meses(P.parsearMensajePago('#pago\nMes: agsto')), ['Agosto']); // en la línea Mes: también 5 letras
  // "julia" no es julio (5 letras, sin etiqueta): es el usuario.
  const u = P.parsearMensajePago('#pago julia nov');
  assert.deepStrictEqual([u.identificador, meses(u)], [{ tipo: 'usuario', valor: 'julia' }, ['Noviembre']]);
});

test('palabras que no se entienden se reportan (en vez de suponer el mes)', () => {
  const r = P.parsearMensajePago('#pago alex97 nvbre');
  assert.deepStrictEqual([meses(r), r.desconocidos], [[], ['nvbre']]);
  assert.deepStrictEqual(P.parsearMensajePago('#pago\nMes: xyz').desconocidos, ['xyz']);
  // Relleno común no cuenta como desconocido.
  assert.deepStrictEqual(P.parsearMensajePago('#pago de noviembre, gracias alex97').desconocidos, []);
});

test('el servicio pide corregir si no entiende una palabra', async () => {
  const { svc, creados } = armar();
  const s = await svc.procesar(msg({ texto: '#pago alex97 nvbre' }));
  assert.deepStrictEqual([s.estado, s.reaccion, creados.length], ['rechazado', '❓', 0]);
  assert.match(s.respuesta, /No entendí «nvbre»/);
});

test('se puede reenviar el comprobante si el pago anterior fue rechazado', async () => {
  const { svc, creados, fb } = armar();
  await svc.procesar(msg());
  fb.data.mirror.pagos = { p1: { id: 'p1', estado: 'Pendiente' } };
  assert.strictEqual((await svc.procesar(msg({ id: 'M2' }))).estado, 'duplicado');
  fb.data.mirror.pagos.p1.estado = 'Rechazado';
  assert.strictEqual((await svc.procesar(msg({ id: 'M3' }))).estado, 'registrado');
  assert.strictEqual(creados.length, 2);
});

test('lectura de WhatsApp: solo lo permitido; exceso a la cola; cola llena se anota', async () => {
  process.env.WSP_LECTURA_MAX_MIN = '5';
  process.env.WSP_LECTURA_MAX_COLA = '50';
  delete require.cache[require.resolve(path.join(__dirname, '../dist/whatsapp/whatsapp.service.js'))];
  const { WhatsappService } = require(path.join(__dirname, '../dist/whatsapp/whatsapp.service.js'));
  const escritos = [];
  const fb = { isEnabled: () => false, liveVal: async () => null, db: () => ({ ref: (p) => ({ set: async (v) => escritos.push([p, v]) }) }) };
  const w = new WhatsappService(fb);
  const acks = [];
  const session = { key: 'villa mayra', sock: { sendMessageAck: async (n) => acks.push(n) } };
  w.configurarLectura('Villa Mayra', { grupos: ['123@g.us'], chats: false });
  const nodo = (from, extra = {}) => ({ attrs: { from, ...extra } });
  assert.strictEqual(w.decisionLectura(session, nodo('999@g.us')), 'ignorar');
  assert.strictEqual(w.decisionLectura(session, nodo('573001234567@s.whatsapp.net')), 'ignorar'); // chats apagado
  assert.strictEqual(w.decisionLectura(session, nodo('123@g.us', { category: 'peer' })), 'ignorar');
  for (let i = 0; i < 5; i++) assert.strictEqual(w.decisionLectura(session, nodo('123@g.us')), 'leer');
  assert.strictEqual(w.decisionLectura(session, nodo('123@g.us')), 'encolar');
  const leidos = [];
  for (let i = 0; i < 52; i++) w.encolarLectura(session, [(n) => leidos.push(n)], nodo('123@g.us'));
  assert.strictEqual(acks.length, 2); // 50 en cola, 2 confirmados sin leer
  assert.strictEqual(w.decisionLectura(session, nodo('123@g.us')), 'encolar'); // con cola, respeta el orden
  const q = w.colasLectura.get('villa mayra');
  clearInterval(q.timer);
  clearTimeout(w.descartesTimer);
  assert.strictEqual(w.descartesPendientes.get('villa mayra').n, 2);
  w.configurarLectura('Villa Mayra', { grupos: [], chats: false });
  assert.strictEqual(w.decisionLectura(session, nodo('123@g.us')), 'ignorar');
});
