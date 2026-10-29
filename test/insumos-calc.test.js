// Ejecutar: node --test test/insumos-calc.test.js  (desde croma-analisis-main)
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../insumos-calc.js');

const P = { dias: 90, plazo: 0, margen: 0 };
function fila(over) {
  return {
    codigo: 'BAG90', producto: 'BOLSA ZAPAS', stock_utilizable: 100, stock_deposito_90: 50,
    consumo_diario_estimado: 10, cobertura_dias: 10, cobertura_estado: 'calculada', ...over,
  };
}

test('validarParametros: dias > 0, plazo y margen >= 0, enteros', () => {
  assert.equal(C.validarParametros({ dias: 90, plazo: 0, margen: 0 }).ok, true);
  assert.equal(C.validarParametros({ dias: '30', plazo: '7', margen: '3' }).ok, true);
  assert.ok(C.validarParametros({ dias: 0, plazo: 0, margen: 0 }).errores.dias);
  assert.ok(C.validarParametros({ dias: '', plazo: 0, margen: 0 }).errores.dias);
  assert.ok(C.validarParametros({ dias: 90, plazo: -1, margen: 0 }).errores.plazo);
  assert.ok(C.validarParametros({ dias: 90, plazo: 0, margen: '1.5' }).errores.margen);
  assert.deepEqual(C.validarParametros({ dias: '45', plazo: '5', margen: '0' }).valores, { dias: 45, plazo: 5, margen: 0 });
});

test('pedido = ceil(consumo * (dias+plazo+margen) - stock), minimo 0', () => {
  // 10/dia * 90 - 100 = 800
  assert.deepEqual(C.pedidoSugerido(fila(), P), { estado: 'ok', cantidad: 800 });
  // plazo y margen se suman al horizonte: 10 * (90+15+5) - 100 = 1000
  assert.equal(C.pedidoSugerido(fila(), { dias: 90, plazo: 15, margen: 5 }).cantidad, 1000);
  // stock de sobra -> 0, nunca negativo
  assert.equal(C.pedidoSugerido(fila({ stock_utilizable: 5000 }), P).cantidad, 0);
});

test('pedido: redondea hacia arriba solo al final y tolera ruido de punto flotante', () => {
  // consumo 1/3 * 90 = 30 exacto aunque 1/3*90 pueda dar 30.000000000000004
  const f = fila({ consumo_diario_estimado: 100 / 3, stock_utilizable: 0 });
  assert.equal(C.pedidoSugerido(f, { dias: 90, plazo: 0, margen: 0 }).cantidad, 3000);
  // 0.5/dia * 91 - 0 = 45.5 -> 46
  assert.equal(C.pedidoSugerido(fila({ consumo_diario_estimado: 0.5, stock_utilizable: 0 }), { dias: 91, plazo: 0, margen: 0 }).cantidad, 46);
});

test('sin consumo: no hay compra automatica y se distingue de datos a revisar', () => {
  const sc = C.pedidoSugerido(fila({ consumo_diario_estimado: null, cobertura_dias: null, cobertura_estado: 'sin_consumo_medible' }), P);
  assert.deepEqual(sc, { estado: 'sin_consumo', cantidad: 0 });
  const rev = C.pedidoSugerido(fila({ cobertura_estado: 'datos_a_revisar' }), P);
  assert.deepEqual(rev, { estado: 'datos_a_revisar', cantidad: null });
});

test('stock cero con consumo positivo: pedido completo y cobertura 0 dias', () => {
  const f = fila({ stock_utilizable: 0, cobertura_dias: 0 });
  assert.equal(C.pedidoSugerido(f, P).cantidad, 900);
  assert.equal(C.estadoCobertura(f).color, 'rojo');
});

test('estadoCobertura: rojo <=15, ambar <=60, verde >60, gris con textos distintos', () => {
  assert.equal(C.estadoCobertura(fila({ cobertura_dias: 15 })).color, 'rojo');
  assert.equal(C.estadoCobertura(fila({ cobertura_dias: 15.1 })).color, 'ambar');
  assert.equal(C.estadoCobertura(fila({ cobertura_dias: 60 })).color, 'ambar');
  assert.equal(C.estadoCobertura(fila({ cobertura_dias: 60.1 })).color, 'verde');
  const sc = C.estadoCobertura(fila({ cobertura_dias: null, cobertura_estado: 'sin_consumo_medible' }));
  const rev = C.estadoCobertura(fila({ cobertura_estado: 'datos_a_revisar' }));
  assert.equal(sc.color, 'gris');
  assert.equal(rev.color, 'gris');
  assert.notEqual(sc.texto, rev.texto);
});

test('resumen: para reponer, stock en deposito 90 y pedido total', () => {
  const filas = [
    fila({ codigo: 'A', cobertura_dias: 8, stock_deposito_90: 50 }),
    fila({ codigo: 'B', cobertura_dias: 35, stock_deposito_90: 950, stock_utilizable: 400 }),
    fila({ codigo: 'C', cobertura_dias: 200, stock_deposito_90: 4400, stock_utilizable: 5000 }),
    fila({ codigo: 'D', cobertura_estado: 'sin_consumo_medible', consumo_diario_estimado: null, cobertura_dias: null, stock_deposito_90: 10 }),
  ];
  const r = C.resumen(filas, P, 60);
  assert.equal(r.paraReponer, 2);
  assert.equal(r.stockDeposito, 5410);
  assert.equal(r.pedidoTotal, 800 + 500);
  assert.equal(C.resumen(filas, null, 60).pedidoTotal, null);
});

test('prioritario: menor cobertura valida, ignora sin consumo y datos a revisar', () => {
  const filas = [
    fila({ codigo: 'A', cobertura_dias: 30 }),
    fila({ codigo: 'B', cobertura_dias: 8 }),
    fila({ codigo: 'C', cobertura_dias: 0, cobertura_estado: 'datos_a_revisar' }),
    fila({ codigo: 'D', cobertura_dias: null, cobertura_estado: 'sin_consumo_medible' }),
  ];
  assert.equal(C.prioritario(filas).codigo, 'B');
  assert.equal(C.prioritario([filas[3]]), null);
});

test('textoPedido: incluye fecha, parametros, lineas > 0, total y aclaracion', () => {
  const filas = [
    fila({ codigo: 'BAG90', producto: 'BOLSA ZAPAS' }),
    fila({ codigo: 'BAG92', producto: 'BOLSA ACCESORIOS', stock_utilizable: 99999 }),
  ];
  const t = C.textoPedido(filas, { dias: 90, plazo: 7, margen: 3 }, new Date(2026, 9, 13));
  assert.match(t, /13\/10\/2026/);
  assert.match(t, /Días a cubrir: 90 · Plazo del proveedor: 7 días · Margen de seguridad: 3 días/);
  assert.match(t, /- BAG90 · Bolsa zapas — 900 unidades/);
  assert.doesNotMatch(t, /BAG92/);
  assert.match(t, /Total: 900 unidades/);
  assert.match(t, /Estimación basada en el consumo reciente/);
});

test('textoPedido: null si no hay nada que pedir; asunto con DD/MM', () => {
  assert.equal(C.textoPedido([fila({ stock_utilizable: 99999 })], P, new Date(2026, 9, 13)), null);
  assert.equal(C.asuntoCorreo(new Date(2026, 9, 3)), 'INSUMOS DE BOLSAS – 03/10');
});

test('desglosePedido: solo cantidades > 0, total = suma exacta y coincide con resumen y texto', () => {
  const filas = [
    fila({ codigo: 'BAG90', producto: 'BOLSA ZAPAS' }),
    fila({ codigo: 'BAG91', producto: 'BOLSA REMERAS', consumo_diario_estimado: 38.6, stock_utilizable: 1382 }),
    fila({ codigo: 'BAG92', producto: 'BOLSA ACCESORIOS', stock_utilizable: 99999 }),
    fila({ codigo: 'BAG94', producto: 'BOLSA SIN VENTAS', consumo_diario_estimado: null, cobertura_dias: null, cobertura_estado: 'sin_consumo_medible' }),
    fila({ codigo: 'BAG95', producto: 'BOLSA REVISAR', cobertura_estado: 'datos_a_revisar' }),
  ];
  const d = C.desglosePedido(filas, P);
  assert.deepEqual(d.items.map(i => i.codigo), ['BAG90', 'BAG91']);
  assert.equal(d.items[0].nombre, 'Bolsa zapas');
  assert.equal(d.total, d.items.reduce((a, i) => a + i.cantidad, 0));
  assert.equal(C.resumen(filas, P, 60).pedidoTotal, d.total);
  const t = C.textoPedido(filas, P, new Date(2026, 9, 13));
  assert.match(t, new RegExp('Total: ' + C.formatoMiles(d.total) + ' unidades'));
  d.items.forEach(i => assert.ok(t.includes('- ' + i.codigo + ' · ' + i.nombre + ' — ' + C.formatoMiles(i.cantidad) + ' unidades')));
  assert.deepEqual(C.desglosePedido([filas[2]], P), { items: [], total: 0 });
});

test('nombreCorto y formato de miles es-AR', () => {
  assert.equal(C.nombreCorto({ producto: 'BOLSA ACCESORIOS', codigo: 'BAG92' }), 'Accesorios');
  assert.equal(C.formatoMiles(5755), '5.755');
  assert.equal(C.formatoMiles(1234567), '1.234.567');
});

// ── Insumos propios (cargados a mano) en el texto del pedido ──
const propio = (over = {}) => ({ id: 1, codigo: 'P1', nombre: 'Cinta de embalar', unidad: 'rollos', stock: 3, punto_reposicion: 5,
  cantidad_pedido: 20, estado: 'reponer', pedido_sugerido: 20, ...over });

test('propiosAReponer: solo los que estan en estado reponer', () => {
  const lista = [propio(), propio({ id: 2, estado: 'ok' }), propio({ id: 3, estado: 'sin_punto' })];
  assert.deepEqual(C.propiosAReponer(lista).map(p => p.id), [1]);
  assert.deepEqual(C.propiosAReponer(undefined), []);
});

test('textoPedido: sin propios el texto no cambia', () => {
  const filas = [fila({ stock_utilizable: 0, consumo_diario_estimado: 10 })];
  const a = C.textoPedido(filas, P, new Date(2026, 9, 13));
  const b = C.textoPedido(filas, P, new Date(2026, 9, 13), [propio({ estado: 'ok', pedido_sugerido: 0 })]);
  assert.equal(a, b);
  assert.match(a, /insumos de bolsas/);
});

test('textoPedido: bolsas + propios a reponer, con unidad y cantidad cargada', () => {
  const filas = [fila({ stock_utilizable: 0, consumo_diario_estimado: 10 })];
  const t = C.textoPedido(filas, P, new Date(2026, 9, 13), [propio()]);
  assert.match(t, /Pedido sugerido de insumos\n/);
  assert.match(t, /Otros insumos \(en o bajo su punto de reposición\):\n- Cinta de embalar — 20 rollos/);
  assert.match(t, /Total: /);
});

test('textoPedido: solo propios => hay texto aunque las bolsas no necesiten pedido; sin cantidad se pide definirla', () => {
  const filas = [fila({ stock_utilizable: 99999 })];
  const t = C.textoPedido(filas, P, new Date(2026, 9, 13), [propio({ cantidad_pedido: null, pedido_sugerido: null })]);
  assert.ok(t);
  assert.match(t, /Cinta de embalar — definir cantidad \(stock 3, punto de reposición 5\)/);
  assert.doesNotMatch(t, /Total:/);
  assert.match(t, /Las cantidades las definió el equipo/);
});

test('asuntoCorreo: con propios cambia el prefijo', () => {
  assert.equal(C.asuntoCorreo(new Date(2026, 9, 3), true), 'INSUMOS – 03/10');
});
