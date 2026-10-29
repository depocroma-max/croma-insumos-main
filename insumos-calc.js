/* Lógica pura de la pestaña Insumos (simulación de reposición, estados, texto del
   pedido). Sin DOM ni red: se carga con <script> en index.html y se testea en Node
   (test/insumos-calc.test.js). Los datos de entrada son las filas de GET
   /analisis/insumos; nunca se inventa un consumo ni una compra automática. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.InsumosCalc = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var UMBRAL_ROJO_DIAS = 15;   // cobertura <= 15 días: urgente
  var DEFAULTS = { dias: 90, plazo: 0, margen: 0 };

  function esEntero(v) {
    if (typeof v === 'number') return Number.isInteger(v) && v >= 0;
    return typeof v === 'string' && /^\d+$/.test(v.trim());
  }

  // Días calendario: "días a cubrir" entero > 0; plazo y margen enteros >= 0.
  function validarParametros(p) {
    var errores = {};
    if (!esEntero(p.dias) || Number(p.dias) < 1) errores.dias = 'Ingresá un entero mayor que 0';
    if (!esEntero(p.plazo)) errores.plazo = 'Ingresá un entero de 0 o más';
    if (!esEntero(p.margen)) errores.margen = 'Ingresá un entero de 0 o más';
    var ok = Object.keys(errores).length === 0;
    return {
      ok: ok,
      errores: errores,
      valores: ok ? { dias: Number(p.dias), plazo: Number(p.plazo), margen: Number(p.margen) } : null,
    };
  }

  // pedido = max(0, ceil(consumo * (dias + plazo + margen) - stock utilizable)).
  // Precisión completa; solo se redondea el resultado final. El redondeo a 6 decimales
  // antes del ceil evita que ruido de punto flotante (5000.000000001) sume una unidad.
  // Devuelve { estado, cantidad }:
  //   'ok'               -> cantidad >= 0
  //   'sin_consumo'      -> sin consumo reciente: cantidad 0, no hay compra automática
  //   'datos_a_revisar'  -> inconsistencias de stock: cantidad null (no se recomienda)
  function pedidoSugerido(fila, params) {
    if (fila.cobertura_estado === 'datos_a_revisar') return { estado: 'datos_a_revisar', cantidad: null };
    var consumo = fila.consumo_diario_estimado;
    if (consumo === null || consumo === undefined || !(consumo > 0)) {
      return { estado: 'sin_consumo', cantidad: 0 };
    }
    var horizonte = params.dias + params.plazo + params.margen;
    var bruto = consumo * horizonte - fila.stock_utilizable;
    var cantidad = Math.max(0, Math.ceil(Math.round(bruto * 1e6) / 1e6));
    return { estado: 'ok', cantidad: cantidad };
  }

  // Estado visual de la cobertura. El texto siempre acompaña al color.
  function estadoCobertura(fila, umbral) {
    var u = umbral || 60;
    if (fila.cobertura_estado === 'datos_a_revisar') {
      return { clave: 'revisar', color: 'gris', texto: 'Datos a revisar' };
    }
    if (fila.cobertura_estado === 'sin_consumo_medible' || fila.cobertura_dias === null || fila.cobertura_dias === undefined) {
      return { clave: 'sin_consumo', color: 'gris', texto: 'Sin consumo reciente' };
    }
    if (fila.cobertura_dias <= UMBRAL_ROJO_DIAS) return { clave: 'urgente', color: 'rojo', texto: 'Urgente' };
    if (fila.cobertura_dias <= u) return { clave: 'reponer', color: 'ambar', texto: 'Reponer pronto' };
    return { clave: 'ok', color: 'verde', texto: 'Cobertura suficiente' };
  }

  // "BOLSA ZAPAS" -> "Bolsa zapas" (nombre legible para el desglose y los textos).
  function nombreBolsa(fila) {
    var n = (fila.producto || fila.codigo || '').trim().toLowerCase();
    return n.replace(/^./, function (c) { return c.toUpperCase(); }) || fila.codigo;
  }

  // Desglose del pedido: solo artículos con cantidad sugerida > 0, en el orden de la
  // tabla. total = suma exacta de las cantidades listadas (única fuente para tarjeta,
  // textos de copiar/correo y resumen).
  function desglosePedido(filas, params) {
    var items = [], total = 0;
    filas.forEach(function (f) {
      var p = pedidoSugerido(f, params);
      if (p.estado === 'ok' && p.cantidad > 0) {
        items.push({ codigo: f.codigo, nombre: nombreBolsa(f), cantidad: p.cantidad });
        total += p.cantidad;
      }
    });
    return { items: items, total: total };
  }

  // Resumen para las tarjetas. Con parámetros inválidos, pedidoTotal es null.
  function resumen(filas, params, umbral) {
    var u = umbral || 60;
    var paraReponer = 0, stockDeposito = 0, conAlerta = 0;
    filas.forEach(function (f) {
      if (f.cobertura_estado === 'calculada' && f.cobertura_dias <= u) paraReponer++;
      stockDeposito += f.stock_deposito_90 || 0;
      if (f.cobertura_estado === 'datos_a_revisar') conAlerta++;
    });
    // El total sale del mismo desglose que se muestra en la tarjeta y en los textos:
    // una sola fuente, no pueden diferir.
    var desglose = params ? desglosePedido(filas, params) : null;
    return {
      paraReponer: paraReponer, stockDeposito: stockDeposito,
      pedidoTotal: desglose ? desglose.total : null,
      desglose: desglose ? desglose.items : null,
      conDatosARevisar: conAlerta,
    };
  }

  // Artículo prioritario: menor cobertura válida (no cuenta sin consumo ni a revisar).
  function prioritario(filas) {
    var mejor = null;
    filas.forEach(function (f) {
      if (f.cobertura_estado !== 'calculada') return;
      if (mejor === null || f.cobertura_dias < mejor.cobertura_dias) mejor = f;
    });
    return mejor;
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function formatoFecha(d) { return pad2(d.getDate()) + '/' + pad2(d.getMonth() + 1) + '/' + d.getFullYear(); }

  function formatoMiles(n) {
    return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  }

  function nombreCorto(fila) {
    var n = (fila.producto || fila.codigo || '').trim();
    return n.replace(/^BOLSA\s+/i, '').toLowerCase().replace(/^./, function (c) { return c.toUpperCase(); }) || fila.codigo;
  }

  // Insumos propios (cargados a mano) que están en o bajo su punto de reposición.
  function propiosAReponer(propios) {
    return (propios || []).filter(function (p) { return p.estado === 'reponer'; });
  }

  function lineaPropio(p) {
    var cant = p.pedido_sugerido !== null && p.pedido_sugerido !== undefined
      ? formatoMiles(p.pedido_sugerido) + ' ' + (p.unidad || 'u.')
      : 'definir cantidad (stock ' + formatoMiles(p.stock) + ', punto de reposición ' + formatoMiles(p.punto_reposicion) + ')';
    return '- ' + p.nombre + ' — ' + cant;
  }

  // Texto del pedido (solo artículos con cantidad > 0, más los insumos propios que hay
  // que reponer). null si no hay nada que pedir. Sin propios el texto es el de siempre.
  function textoPedido(filas, params, fecha, propios) {
    var d = desglosePedido(filas, params);
    var total = d.total;
    var lineas = d.items.map(function (it) {
      return '- ' + it.codigo + ' · ' + it.nombre + ' — ' + formatoMiles(it.cantidad) + ' unidades';
    });
    var rep = propiosAReponer(propios);
    if (!lineas.length && !rep.length) return null;
    var cuerpo = [
      rep.length ? 'Pedido sugerido de insumos' : 'Pedido sugerido de insumos de bolsas',
      'Fecha: ' + formatoFecha(fecha),
      'Días a cubrir: ' + params.dias + ' · Plazo del proveedor: ' + params.plazo + ' días · Margen de seguridad: ' + params.margen + ' días',
      '',
    ];
    if (lineas.length) {
      cuerpo = cuerpo.concat(lineas).concat(['', 'Total: ' + formatoMiles(total) + ' unidades', '']);
    }
    if (rep.length) {
      cuerpo = cuerpo.concat(['Otros insumos (en o bajo su punto de reposición):']).concat(rep.map(lineaPropio)).concat(['']);
    }
    cuerpo.push(lineas.length
      ? 'Estimación basada en el consumo reciente (últimos 90 días); confirmar antes de realizar el pedido.'
      : 'Las cantidades las definió el equipo en cada insumo; confirmar antes de realizar el pedido.');
    return cuerpo.join('\n');
  }

  function asuntoCorreo(fecha, conPropios) {
    return (conPropios ? 'INSUMOS – ' : 'INSUMOS DE BOLSAS – ') + pad2(fecha.getDate()) + '/' + pad2(fecha.getMonth() + 1);
  }

  return {
    DEFAULTS: DEFAULTS,
    UMBRAL_ROJO_DIAS: UMBRAL_ROJO_DIAS,
    validarParametros: validarParametros,
    pedidoSugerido: pedidoSugerido,
    estadoCobertura: estadoCobertura,
    resumen: resumen,
    desglosePedido: desglosePedido,
    propiosAReponer: propiosAReponer,
    nombreBolsa: nombreBolsa,
    prioritario: prioritario,
    textoPedido: textoPedido,
    asuntoCorreo: asuntoCorreo,
    nombreCorto: nombreCorto,
    formatoMiles: formatoMiles,
    formatoFecha: formatoFecha,
  };
});
