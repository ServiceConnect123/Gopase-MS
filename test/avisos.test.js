// Avisos con la marca del conjunto: plantillas, dibujo del aviso, marca y publicación.
// Ejecutar: npm run test:wsp (compila y corre con el runner nativo de Node).
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const render = require(path.join(__dirname, '../dist/avisos/aviso-render.js'));
const { AvisosService } = require(path.join(__dirname, '../dist/avisos/avisos.service.js'));

// ---------------------------------------------------------------------------
// Firebase en memoria (solo lo que usa el servicio)
// ---------------------------------------------------------------------------
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
    get: async () => { const v = leer(p); return { exists: () => v !== undefined && v !== null, val: () => v }; },
    set: async (v) => escribir(p, v),
    update: async (patch) => { Object.entries(patch).forEach(([k, v]) => escribir(`${p}/${k}`, v)); },
    remove: async () => escribir(p, undefined),
    child: (k) => ref(`${p}/${k}`),
  });
  return { data, isEnabled: () => true, db: () => ({ ref }), liveVal: async (p) => leer(p) ?? null };
}

const CONJUNTOS = { mirror: { conjuntos: { c1: { id: 'c1', nombre: 'Conjunto Los Pinos', driveFolderId: 'carpeta1' } } } };

function servicio({ drive, noticias, inicial } = {}) {
  const fb = fakeFirebase(inicial || CONJUNTOS);
  const notis = [];
  const nts = noticias || {
    list: async () => notis,
    create: async (n) => { const id = `n${notis.length + 1}`; notis.push({ ...n, id }); return { success: true, id }; },
    update: async (id, n) => { const i = notis.findIndex((x) => x.id === id); notis[i] = { ...notis[i], ...n }; return { success: true }; },
  };
  const drv = drive || { uploadImage: async () => ({ success: true, directLink: 'https://drive.example/aviso.png' }) };
  return { svc: new AvisosService(fb, drv, nts), fb, notis };
}

// ---------------------------------------------------------------------------
// Dibujo del aviso
// ---------------------------------------------------------------------------

test('plantillas: seis tipos, cada una con título obligatorio', () => {
  assert.deepStrictEqual(render.PLANTILLAS.map((p) => p.id), ['corte', 'asamblea', 'mantenimiento', 'pago', 'evento', 'general']);
  for (const p of render.PLANTILLAS) {
    assert.ok(p.campos.find((c) => c.key === 'titulo' && c.requerido), p.id);
    assert.match(p.color, /^#[0-9A-F]{6}$/i);
  }
});

test('partirLineas: corta por palabras y pone «…» si no cabe', () => {
  assert.deepStrictEqual(render.partirLineas('Hola mundo grande', 200, 30, true, 2), ['Hola mundo', 'grande']);
  const l = render.partirLineas('uno dos tres cuatro cinco seis siete ocho nueve diez', 150, 30, false, 2);
  assert.strictEqual(l.length, 2);
  assert.ok(l[1].endsWith('…'));
  // Palabra más larga que la línea: se parte a la fuerza.
  assert.ok(render.partirLineas('a'.repeat(40), 100, 20, false, 5).every((x) => x.length <= 8));
});

test('el texto del admin se escapa en el SVG', () => {
  const svg = render.buildAvisoSvg(
    { plantilla: 'general', campos: { titulo: '<script>alert(1)</script>', mensaje: 'Tom & Jerry "hoy"' } },
    { conjunto: 'Los <Pinos>' },
  );
  assert.ok(!svg.includes('<script>'));
  assert.ok(svg.includes('&lt;script&gt;'));
  assert.ok(svg.includes('Tom &amp; Jerry &quot;hoy&quot;'));
  assert.ok(svg.includes('Los &lt;Pinos&gt;'));
});

test('formatos y diseños: tamaño y fondo', () => {
  const marca = { conjunto: 'Conjunto Los Pinos' };
  const cuadrado = render.buildAvisoSvg({ plantilla: 'corte', campos: {} }, marca);
  assert.match(cuadrado, /width="1080" height="1080"/);
  assert.match(cuadrado, /<rect width="1080" height="1080" fill="#FFFFFF"\/>/);
  const vertical = render.buildAvisoSvg({ plantilla: 'corte', formato: 'vertical', diseno: 'B', campos: {} }, marca);
  assert.match(vertical, /width="1080" height="1920"/);
  assert.match(vertical, /<rect width="1080" height="1920" fill="#0369A1"\/>/);
  // Color propio válido manda; uno inválido se ignora.
  assert.match(render.buildAvisoSvg({ plantilla: 'corte', diseno: 'B', color: '#112233', campos: {} }, marca), /fill="#112233"/);
  assert.match(render.buildAvisoSvg({ plantilla: 'corte', diseno: 'B', color: 'red;x', campos: {} }, marca), /fill="#0369A1"/);
});

test('logos: solo data URL PNG/JPEG; sin logo salen las iniciales', () => {
  const png = 'data:image/png;base64,iVBORw0KGgo=';
  const con = render.buildAvisoSvg({ plantilla: 'evento', campos: {} }, { conjunto: 'Conjunto Los Pinos', logoConjunto: png });
  assert.ok(con.includes(png));
  const externo = render.buildAvisoSvg({ plantilla: 'evento', campos: {} }, { conjunto: 'Conjunto Los Pinos', logoConjunto: 'https://malo.example/x.png' });
  assert.ok(!externo.includes('malo.example'));
  assert.ok(externo.includes('>LP<'));
});

test('administradora: «Administrado por» solo si se activa', () => {
  const base = { conjunto: 'Conjunto Los Pinos', adminNombre: 'Administración Horizonte' };
  assert.ok(!render.buildAvisoSvg({ plantilla: 'asamblea', campos: {} }, base).includes('Administrado por'));
  const con = render.buildAvisoSvg({ plantilla: 'asamblea', campos: {} }, { ...base, mostrarAdmin: true });
  assert.ok(con.includes('Administrado por'));
  assert.ok(con.includes('Administración Horizonte'));
});

test('filasAviso: solo los datos con valor, con su etiqueta', () => {
  const p = render.plantillaPorId('corte');
  assert.deepStrictEqual(render.filasAviso(p, { fecha: 'Martes 25', horario: '', afecta: 'Torre 1' }), [['Fecha', 'Martes 25'], ['Afecta', 'Torre 1']]);
});

// ---------------------------------------------------------------------------
// Servicio
// ---------------------------------------------------------------------------

test('limpiarDatos: solo campos de la plantilla y recortados', () => {
  const { svc } = servicio();
  const d = svc.limpiarDatos({ plantilla: 'corte', campos: { titulo: '  Corte   de agua ', fecha: 'x'.repeat(100), hack: 'no' }, formato: 'otro', diseno: 'Z', color: 'azul' });
  assert.deepStrictEqual(Object.keys(d.campos).sort(), ['fecha', 'titulo']);
  assert.strictEqual(d.campos.titulo, 'Corte de agua');
  assert.strictEqual(d.campos.fecha.length, 40);
  assert.strictEqual(d.formato, 'cuadrado');
  assert.strictEqual(d.diseno, 'A');
  assert.strictEqual(d.color, '');
  assert.strictEqual(svc.limpiarDatos({ plantilla: 'inventada' }).plantilla, 'general');
  assert.deepStrictEqual(svc.faltantes(d), []);
  assert.deepStrictEqual(svc.faltantes(svc.limpiarDatos({ plantilla: 'asamblea', campos: {} })), ['Título', 'Fecha']);
});

test('marca: colores validados y logos sin cambios si no vienen', async () => {
  const { svc, fb } = servicio();
  const malo = await svc.guardarMarca('Conjunto Los Pinos', { colorPrincipal: 'verde' });
  assert.strictEqual(malo.success, false);
  const ok = await svc.guardarMarca('c1', { colorPrincipal: '#0f766e', adminNombre: '  Administración Horizonte ', mostrarAdmin: true });
  assert.strictEqual(ok.success, true);
  assert.strictEqual(fb.data.mirror.marcas.c1.colorPrincipal, '#0F766E');
  assert.strictEqual(ok.data.adminNombre, 'Administración Horizonte');
  assert.strictEqual(ok.data.mostrarAdmin, true);
  assert.strictEqual(fb.data.mirror.marcas.c1.logoConjunto, undefined);
  assert.strictEqual((await svc.guardarMarca('No existe', {})).success, false);
});

test('borrador -> publicar: imagen en Drive, noticia creada y luego actualizada', async () => {
  render.renderAvisoPng = async () => Buffer.from('png');
  const subidas = [];
  const { svc, fb, notis } = servicio({
    drive: { uploadImage: async (...args) => { subidas.push(args); return { success: true, directLink: `https://drive.example/${subidas.length}.png` }; } },
  });
  const autor = { usuario: 'admin1', nombre: 'Yuranis' };
  const g = await svc.guardar('Conjunto Los Pinos', { plantilla: 'corte', campos: { titulo: 'Corte de agua', fecha: 'Martes 25', mensaje: 'Guarda agua.' } }, autor);
  assert.strictEqual(g.success, true);
  assert.strictEqual(g.data.estado, 'borrador');
  const id = g.data.id;

  const p1 = await svc.publicar(id, autor);
  assert.strictEqual(p1.success, true, p1.message);
  assert.strictEqual(subidas[0][2], 'carpeta1');
  assert.strictEqual(subidas[0][3], 'image/png');
  assert.strictEqual(notis.length, 1);
  assert.strictEqual(notis[0].titulo, 'Corte de agua');
  assert.strictEqual(notis[0].subtitulo, 'Corte de servicio');
  assert.strictEqual(notis[0].descripcion, 'Fecha: Martes 25\nGuarda agua.');
  assert.deepStrictEqual(notis[0].imagenes, ['https://drive.example/1.png']);
  assert.strictEqual(fb.data.mirror.avisos[id].estado, 'publicado');

  // Editar y volver a publicar: actualiza la misma noticia.
  await svc.guardar('c1', { plantilla: 'corte', campos: { titulo: 'Corte de agua (nuevo horario)', fecha: 'Miércoles 26' } }, autor, id);
  assert.strictEqual(fb.data.mirror.avisos[id].estado, 'publicado');
  const p2 = await svc.publicar(id, autor);
  assert.strictEqual(p2.success, true);
  assert.strictEqual(notis.length, 1);
  assert.strictEqual(notis[0].titulo, 'Corte de agua (nuevo horario)');
  assert.deepStrictEqual(notis[0].imagenes, ['https://drive.example/2.png']);
});

test('publicar: falta un dato obligatorio o falla Drive -> no publica', async () => {
  render.renderAvisoPng = async () => Buffer.from('png');
  const { svc, notis } = servicio({ drive: { uploadImage: async () => ({ success: false, message: 'Drive no configurado' }) } });
  const autor = { usuario: 'a', nombre: 'A' };
  const sinFecha = await svc.guardar('c1', { plantilla: 'asamblea', campos: { titulo: 'Asamblea' } }, autor);
  assert.match((await svc.publicar(sinFecha.data.id, autor)).message, /Completa: Fecha/);
  const completo = await svc.guardar('c1', { plantilla: 'asamblea', campos: { titulo: 'Asamblea', fecha: 'Sábado' } }, autor);
  const r = await svc.publicar(completo.data.id, autor);
  assert.strictEqual(r.success, false);
  assert.match(r.message, /Drive no configurado/);
  assert.strictEqual(notis.length, 0);
});

test('list: solo los avisos del conjunto, el más reciente primero', async () => {
  const { svc, fb } = servicio();
  fb.data.mirror.avisos = {
    a: { id: 'a', conjunto: 'Conjunto Los Pinos', actualizadoEn: '2026-11-20T10:00:00Z', _fbWrite: true },
    b: { id: 'b', conjunto: 'Otro', actualizadoEn: '2026-11-21T10:00:00Z' },
    c: { id: 'c', conjunto: 'conjunto los pinos', actualizadoEn: '2026-11-22T10:00:00Z' },
  };
  const l = await svc.list('c1');
  assert.deepStrictEqual(l.map((x) => x.id), ['c', 'a']);
  assert.strictEqual(l[1]._fbWrite, undefined);
});

test('guardar: no se puede editar un aviso de otro conjunto', async () => {
  const inicial = JSON.parse(JSON.stringify(CONJUNTOS));
  inicial.mirror.conjuntos.c2 = { id: 'c2', nombre: 'Otro' };
  inicial.mirror.avisos = { x: { id: 'x', conjunto: 'Otro' } };
  const { svc } = servicio({ inicial });
  const r = await svc.guardar('c1', { plantilla: 'general', campos: { titulo: 'Hola' } }, { usuario: 'a', nombre: 'A' }, 'x');
  assert.strictEqual(r.success, false);
});
