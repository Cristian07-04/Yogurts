/* ============================================================================
   YogurArte · Gestión de pedidos de yogur artesanal
   Js/Script.js
   ----------------------------------------------------------------------------
   Modelo:
     - "Lotes": pedidos de compra al proveedor. Cada lote tiene fecha de envío,
       fecha de recepción (cuando llegan los yogures) y una fecha límite ÚNICA
       de recaudo para toda la tanda, además de las cantidades a comprar por
       sabor (auto-calculadas desde los clientes y editables) y un estado:
         · proveedor → "Enviado al proveedor"
         · entrega   → "En entrega"
         · recaudo   → "En recaudo"
     - "Pedidos": pedidos de cada cliente, siempre ligados a un lote.
       Se marcan como entregado ("tachar") y como pagado.

   Organización del archivo:
     1. Configuración (precios, sabores, claves de almacenamiento)
     2. Estado y persistencia (localStorage) + migración desde v1
     3. Utilidades (dinero, fechas, id, HTML seguro)
     4. Selector de sabores + reconteo en tiempo real (pedido de cliente)
     5. Cálculos financieros (pedido, lote, resumen general)
     6. CRUD de lotes (pedido al proveedor)
     7. CRUD de pedidos de clientes
     8. Cambios de estado (entrega, pago, avance de fase del lote)
     9. Renderizado de las vistas (Proveedor, Pedidos, Entrega, Recaudo)
    10. Inicialización y eventos globales
   ============================================================================ */

/* 1. CONFIGURACIÓN ----------------------------------------------------------- */
const PRECIO_COSTO = 9000;      // costo por yogur al proveedor (COP)
const PRECIO_VENTA = 20000;     // precio de venta al cliente (COP)
const KEY_LOTES = 'yogurArte.lotes.v1';
const KEY_PEDIDOS = 'yogurArte.pedidos.v2';
const KEY_LEGACY = 'yogurArte.pedidos.v1';   // clave usada en la versión anterior

// Lista fija de sabores (no editable por el usuario)
const SABORES = [
  'Kiwi', 'Fresa', 'Kumis', 'Mora', 'Frutos rojos',
  'Melocotón', 'Vainilla', 'Arequipe', 'Guanábana'
];

// Fases por las que avanza cada pedido al proveedor (avance automático)
const ESTADOS_LOTE = {
  proveedor:  { etiqueta: 'Enviado al proveedor', badge: 'estado-proveedor',  icono: 'bi-send' },
  entrega:    { etiqueta: 'En entrega',           badge: 'estado-entrega',    icono: 'bi-bicycle' },
  recaudo:    { etiqueta: 'En recaudo',           badge: 'estado-recaudo',    icono: 'bi-cash-coin' },
  finalizado: { etiqueta: 'Finalizado',           badge: 'estado-finalizado', icono: 'bi-check2-circle' }
};
const ORDEN_ESTADOS = ['proveedor', 'entrega', 'recaudo', 'finalizado'];

/* 2. ESTADO Y PERSISTENCIA ---------------------------------------------------- */
let lotes = [];             // pedidos al proveedor
let pedidos = [];           // pedidos de clientes
let loteEnEdicion = null;   // id del lote en edición (null = nuevo)
let pedidoEnEdicion = null; // id del pedido de cliente en edición (null = nuevo)
const lotesColapsados = new Set(); // ids de pedidos cerrados en la pestaña Pedidos

// Lee lotes y pedidos desde localStorage
function cargarDatos() {
  try {
    lotes = JSON.parse(localStorage.getItem(KEY_LOTES) || '[]');
  } catch (error) {
    console.warn('No se pudieron cargar los lotes:', error);
    lotes = [];
  }
  try {
    pedidos = JSON.parse(localStorage.getItem(KEY_PEDIDOS) || '[]');
  } catch (error) {
    console.warn('No se pudieron cargar los pedidos:', error);
    pedidos = [];
  }
  normalizarDatos();
  migrarDesdeV1();
}

// Corrige lotes/pedidos con datos viejos o incompletos para que siempre se rendericen
function normalizarDatos() {
  if (!Array.isArray(lotes)) lotes = [];
  if (!Array.isArray(pedidos)) pedidos = [];
  lotes.forEach((l) => {
    if (!ESTADOS_LOTE[l.estado]) l.estado = 'proveedor';
    if (!l.numero) l.numero = 1;
    if (!l.fechaRecepcion) l.fechaRecepcion = hoyISO();
  });
  pedidos.forEach((p) => {
    if (!p.sabores) p.sabores = {};
    if (typeof p.entregado !== 'boolean') p.entregado = !!p.entregado;
    if (typeof p.pagado !== 'boolean') p.pagado = !!p.pagado;
  });
}

// Persiste lotes y pedidos en localStorage
function guardarDatos() {
  localStorage.setItem(KEY_LOTES, JSON.stringify(lotes));
  localStorage.setItem(KEY_PEDIDOS, JSON.stringify(pedidos));
}

// Borra todos los registros y vuelve a empezar desde cero
function resetearDatos() {
  const mensaje = '¿Restablecer todos los registros?\n\nSe eliminarán TODOS los pedidos al proveedor y todos los pedidos de clientes. Esta acción no se puede deshacer.';
  if (!confirm(mensaje)) return;
  localStorage.removeItem(KEY_LOTES);
  localStorage.removeItem(KEY_PEDIDOS);
  localStorage.removeItem(KEY_LEGACY);
  lotes = [];
  pedidos = [];
  loteEnEdicion = null;
  pedidoEnEdicion = null;
  renderTodo();
}

// Migra los datos de la versión anterior (pedidos sueltos) a un primer lote
function migrarDesdeV1() {
  if (lotes.length || pedidos.length) return;
  const legado = localStorage.getItem(KEY_LEGACY);
  if (!legado) return;
  let antiguos;
  try { antiguos = JSON.parse(legado); } catch (error) { return; }
  if (!Array.isArray(antiguos) || !antiguos.length) return;

  const lote = {
    id: generarId(),
    numero: 1,
    fechaRecepcion: hoyISO(),
    fechaLimiteCobro: fechaLimiteISO(),
    saboresProveedor: agregarSabores(antiguos),
    estado: 'proveedor',
    creadoEn: Date.now(),
  };
  lotes.push(lote);
  antiguos.forEach((p) => {
    pedidos.push({
      id: p.id || generarId(),
      loteId: lote.id,
      nombre: p.nombre || 'Sin nombre',
      sabores: p.sabores || {},
      entregado: !!p.entregado,
      pagado: !!p.pagado,
      creadoEn: p.creadoEn || Date.now(),
    });
  });
  guardarDatos();
  localStorage.removeItem(KEY_LEGACY);
}

/* 3. UTILIDADES --------------------------------------------------------------- */
const $ = (selector) => document.querySelector(selector);
const $todos = (selector) => Array.from(document.querySelectorAll(selector));

// Formatea un número como moneda colombiana: 20000 -> "$20.000"
function formatearCOP(valor) {
  return '$' + Math.round(valor).toLocaleString('es-CO');
}

// Convierte un objeto Date a string ISO (YYYY-MM-DD) sin problemas de zona horaria
function aISODate(fecha) {
  const y = fecha.getFullYear();
  const m = String(fecha.getMonth() + 1).padStart(2, '0');
  const d = String(fecha.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function hoyISO() {
  return aISODate(new Date());
}

// Fecha límite de recaudo por defecto: hoy + 7 días
function fechaLimiteISO() {
  const f = new Date();
  f.setDate(f.getDate() + 7);
  return aISODate(f);
}

// Próximo sábado (día en el que normalmente llegan los yogures)
function proximoSabado() {
  const f = new Date();
  const dia = f.getDay(); // 0 = domingo ... 6 = sábado
  f.setDate(f.getDate() + ((6 - dia + 7) % 7));
  return aISODate(f);
}

// Muestra una fecha ISO como dd/mm/aaaa
function fechaLegible(iso) {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

// Genera un id único
function generarId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
}

// Escapa texto para evitar inyección HTML al renderizar
function escaparHTML(texto) {
  const div = document.createElement('div');
  div.textContent = String(texto);
  return div.innerHTML;
}

/* 4. SELECTOR DE SABORES Y RECONTEO EN TIEMPO REAL ---------------------------- */

// Dibuja la lista de sabores con steppers (+ / -) para el pedido de cliente
function renderSelectorSabores() {
  $('#selectorSabores').innerHTML = SABORES.map((sabor) => `
    <div class="sabor-fila" data-sabor="${escaparHTML(sabor)}">
      <span class="sabor-nombre">${escaparHTML(sabor)}</span>
      <div class="stepper">
        <button type="button" class="stepper-btn" data-op="menos" aria-label="Quitar ${escaparHTML(sabor)}">−</button>
        <span class="stepper-cantidad" data-valor="0">0</span>
        <button type="button" class="stepper-btn" data-op="mas" aria-label="Agregar ${escaparHTML(sabor)}">+</button>
      </div>
    </div>
  `).join('');
}

// Ajusta la cantidad de un sabor y actualiza el reconteo
function cambiarCantidad(fila, delta) {
  const cantEl = fila.querySelector('.stepper-cantidad');
  const n = Math.max(0, (parseInt(cantEl.dataset.valor, 10) || 0) + delta);
  cantEl.dataset.valor = n;
  cantEl.textContent = n;
  fila.classList.toggle('activo', n > 0);
  actualizarReconteo();
}

// Devuelve { sabor: cantidad } con los sabores elegidos (solo cantidad > 0)
function saboresSeleccionados() {
  const resultado = {};
  $todos('#selectorSabores .sabor-fila').forEach((fila) => {
    const sabor = fila.dataset.sabor;
    const n = parseInt(fila.querySelector('.stepper-cantidad').dataset.valor, 10) || 0;
    if (n > 0) resultado[sabor] = n;
  });
  return resultado;
}

// Carga un pedido existente en los steppers (para editar)
function establecerSabores(sabores) {
  $todos('#selectorSabores .sabor-fila').forEach((fila) => {
    const n = (sabores && sabores[fila.dataset.sabor]) || 0;
    const cantEl = fila.querySelector('.stepper-cantidad');
    cantEl.dataset.valor = n;
    cantEl.textContent = n;
    fila.classList.toggle('activo', n > 0);
  });
}

// Reconteo en tiempo real: total de yogures, sabores distintos,
// unidades por sabor y proyección financiera del pedido en borrador
function actualizarReconteo() {
  const seleccion = saboresSeleccionados();
  const unidades = Object.values(seleccion).reduce((a, b) => a + b, 0);
  const distintos = Object.keys(seleccion).length;
  const inversion = unidades * PRECIO_COSTO;
  const ingresos = unidades * PRECIO_VENTA;
  const ganancia = ingresos - inversion;

  const detalle = Object.entries(seleccion)
    .map(([sabor, n]) => `<span class="reconteo-chip">${escaparHTML(sabor)} × ${n}</span>`)
    .join('') || '<span class="texto-suave">Aún no has elegido sabores.</span>';

  $('#reconteo').innerHTML = `
    <div class="reconteo-cabecera">
      <strong>${unidades}</strong> ${unidades === 1 ? 'yogur' : 'yogures'} ·
      <strong>${distintos}</strong> ${distintos === 1 ? 'sabor' : 'sabores'} distintos
    </div>
    <div class="reconteo-detalle">${detalle}</div>
    <div class="reconteo-finance">
      <span>Inversión ${formatearCOP(inversion)}</span>
      <span>Ingreso ${formatearCOP(ingresos)}</span>
      <span class="ganancia">Ganancia ${formatearCOP(ganancia)}</span>
    </div>
  `;
}

/* 5. CÁLCULOS FINANCIEROS ------------------------------------------------------ */

// Total de yogures de un pedido de cliente
function totalUnidades(pedido) {
  return Object.values(pedido.sabores || {}).reduce((a, b) => a + b, 0);
}

// Suma por sabor de una lista de pedidos: { sabor: cantidad }
function agregarSabores(lista) {
  const total = {};
  lista.forEach((p) => {
    Object.entries(p.sabores || {}).forEach(([sabor, n]) => {
      total[sabor] = (total[sabor] || 0) + n;
    });
  });
  return total;
}

// Totales financieros de un pedido de cliente
function totalesPedido(pedido) {
  const unidades = totalUnidades(pedido);
  return {
    unidades,
    saboresDistintos: Object.keys(pedido.sabores || {}).length,
    inversion: unidades * PRECIO_COSTO,
    ingresos: unidades * PRECIO_VENTA,
    ganancia: unidades * (PRECIO_VENTA - PRECIO_COSTO),
  };
}

// Totales de un lote (pedido al proveedor): compra, ventas y avances.
// Las cantidades a comprar se calculan automáticamente sumando los clientes.
function totalesLote(lote) {
  const lista = pedidosDeLote(lote.id);
  const saboresProveedor = agregarSabores(lista);
  const comprados = Object.values(saboresProveedor).reduce((a, b) => a + b, 0);
  const costo = comprados * PRECIO_COSTO;

  const saboresClientes = saboresProveedor;
  const unidadesClientes = comprados;
  const ingresos = unidadesClientes * PRECIO_VENTA;
  const ganancia = ingresos - costo;

  const entregados = lista.filter((p) => p.entregado);
  const pagados = lista.filter((p) => p.pagado);
  const recaudado = pagados.reduce((a, p) => a + totalUnidades(p) * PRECIO_VENTA, 0);

  return {
    comprados,
    costo,
    ingresos,
    ganancia,
    saboresClientes,
    unidadesClientes,
    saboresDistintosClientes: Object.keys(saboresClientes).length,
    pedidosLote: lista.length,
    entregados: entregados.length,
    unidadesEntregadas: entregados.reduce((a, p) => a + totalUnidades(p), 0),
    pagados: pagados.length,
    recaudado,
    pendientes: ingresos - recaudado,
  };
}

// Resumen general de todos los lotes
function resumenGeneral() {
  const r = {
    lotes: 0, pedidos: 0, comprados: 0, unidadesClientes: 0,
    inversion: 0, ingresos: 0, ganancia: 0,
    entregados: 0, unidadesEntregadas: 0,
    pagados: 0, recaudado: 0,
  };
  lotes.forEach((l) => {
    const t = totalesLote(l);
    r.lotes += 1;
    r.comprados += t.comprados;
    r.unidadesClientes += t.unidadesClientes;
    r.inversion += t.costo;
    r.ingresos += t.ingresos;
    r.ganancia += t.ganancia;
    r.entregados += t.entregados;
    r.unidadesEntregadas += t.unidadesEntregadas;
    r.pagados += t.pagados;
    r.recaudado += t.recaudado;
  });
  r.pedidos = pedidos.length;
  r.pendientes = r.ingresos - r.recaudado;
  return r;
}

/* 6. CRUD DE LOTES (PEDIDO AL PROVEEDOR) ---------------------------------------- */

function lotePorId(id) {
  return lotes.find((l) => l.id === id);
}

function pedidosDeLote(loteId) {
  return pedidos.filter((p) => p.loteId === loteId);
}

// Número correlativo de la tanda: #01, #02, #03...
function siguienteNumeroLote() {
  const nums = lotes.map((l) => l.numero || 0);
  return nums.length ? Math.max(...nums) + 1 : 1;
}

function etiquetaLote(lote) {
  if (!lote) return '—';
  return '#' + String(lote.numero || 0).padStart(2, '0');
}

// Abre el formulario de lote en modo "nuevo"
function abrirFormLoteNuevo() {
  loteEnEdicion = null;
  $('#tituloModalLote').textContent = 'Nuevo pedido al proveedor';
  $('#formLote').reset();
  $('#formLote').classList.remove('was-validated');
  $('#loteId').value = '';
  $('#fechaRecepcion').value = proximoSabado();
  $('#fechaLimiteCobro').value = fechaLimiteISO();
  limpiarErroresLote();
  bootstrap.Modal.getOrCreateInstance('#modalLote').show();
}

// Abre el formulario de lote en modo "editar"
function abrirFormLoteEditar(id) {
  const lote = lotePorId(id);
  if (!lote) return;
  loteEnEdicion = id;
  $('#tituloModalLote').textContent = 'Editar pedido al proveedor';
  $('#formLote').reset();
  $('#formLote').classList.remove('was-validated');
  $('#loteId').value = id;
  $('#fechaRecepcion').value = lote.fechaRecepcion;
  $('#fechaLimiteCobro').value = lote.fechaLimiteCobro || '';
  limpiarErroresLote();
  bootstrap.Modal.getOrCreateInstance('#modalLote').show();
}

// Guarda (crea o actualiza) el pedido al proveedor
function guardarLote(e) {
  e.preventDefault();
  const form = $('#formLote');
  form.classList.add('was-validated');
  limpiarErroresLote();

  const fr = $('#fechaRecepcion').value;
  const fl = $('#fechaLimiteCobro').value;
  if (!fr) return; // el campo required marca su propio error
  if (fl && fl < fr) {
    $('#fechaLimiteCobro').classList.add('is-invalid');
    $('#errorLimiteLote').textContent = 'La fecha límite de recaudo no puede ser anterior a la fecha de llegada.';
    $('#errorLimiteLote').style.display = 'block';
    return;
  }

  try {
    const original = loteEnEdicion ? lotePorId(loteEnEdicion) : null;
    const datos = {
      id: loteEnEdicion || generarId(),
      numero: original ? original.numero : siguienteNumeroLote(),
      fechaRecepcion: fr,
      fechaLimiteCobro: fl || '',
      estado: original ? original.estado : 'proveedor',
      creadoEn: original ? original.creadoEn : Date.now(),
    };

    if (loteEnEdicion) {
      lotes = lotes.map((l) => (l.id === loteEnEdicion ? datos : l));
    } else {
      lotes.push(datos);
    }

    guardarDatos();
    renderTodo();
  } finally {
    bootstrap.Modal.getInstance('#modalLote').hide();
  }
  mostrarPestanaPedidos();
}

// Elimina un lote y sus pedidos de clientes
function eliminarLote(id) {
  const lote = lotePorId(id);
  if (!lote) return;
  const n = pedidosDeLote(id).length;
  const mensaje = n
    ? `¿Eliminar el ${etiquetaLote(lote)} al proveedor? Se eliminarán también sus ${n} pedidos de clientes.`
    : `¿Eliminar el ${etiquetaLote(lote)} al proveedor?`;
  if (confirm(mensaje)) {
    pedidos = pedidos.filter((p) => p.loteId !== id);
    lotes = lotes.filter((l) => l.id !== id);
    guardarDatos();
    renderTodo();
  }
}

// Limpia los errores personalizados del formulario de lote
function limpiarErroresLote() {
  $('#fechaLimiteCobro').classList.remove('is-invalid');
  $('#errorLimiteLote').textContent = 'No puede ser anterior a la fecha de llegada.';
  $('#errorLimiteLote').style.display = 'none';
}

/* 7. CRUD DE PEDIDOS DE CLIENTES ------------------------------------------------ */

// Opciones del selector de tandas en el formulario de pedido
function opcionesLoteSelect() {
  if (!lotes.length) {
    return '<option value="" selected>Crea primero un pedido al proveedor</option>';
  }
  return lotes.map((l) => {
    const meta = ESTADOS_LOTE[l.estado] || ESTADOS_LOTE.proveedor;
    return `
      <option value="${l.id}">${etiquetaLote(l)} · Recepción ${fechaLegible(l.fechaRecepcion)} · ${meta.etiqueta}</option>
    `;
  }).join('');
}

// Abre el formulario de pedido de cliente en modo "nuevo".
// loteIdPreseleccionado: tanda a la que pertenecerá el cliente
function abrirFormNuevo(loteIdPreseleccionado) {
  if (!lotes.length) {
    alert('Primero debes crear un pedido al proveedor (pestaña Proveedor) para poder registrar personas.');
    return;
  }
  pedidoEnEdicion = null;
  $('#tituloModal').textContent = 'Nueva persona';
  $('#formPedido').reset();
  $('#formPedido').classList.remove('was-validated');
  $('#pedidoId').value = '';
  $('#loteSelect').innerHTML = opcionesLoteSelect();
  if (loteIdPreseleccionado) $('#loteSelect').value = loteIdPreseleccionado;
  establecerSabores({});
  limpiarErrores();
  actualizarReconteo();
  bootstrap.Modal.getOrCreateInstance('#modalPedido').show();
}

// Abre el formulario de pedido de cliente en modo "editar"
function abrirFormEditar(id) {
  const pedido = pedidos.find((p) => p.id === id);
  if (!pedido) return;
  pedidoEnEdicion = id;
  $('#tituloModal').textContent = 'Editar pedido de cliente';
  $('#formPedido').reset();
  $('#formPedido').classList.remove('was-validated');
  $('#pedidoId').value = id;
  $('#loteSelect').innerHTML = opcionesLoteSelect();
  $('#loteSelect').value = pedido.loteId;
  $('#nombre').value = pedido.nombre;
  establecerSabores(pedido.sabores);
  limpiarErrores();
  actualizarReconteo();
  bootstrap.Modal.getOrCreateInstance('#modalPedido').show();
}

// Guarda (crea o actualiza) el pedido de cliente
function guardarPedido(e) {
  e.preventDefault();
  const form = $('#formPedido');
  form.classList.add('was-validated');
  limpiarErrores();

  const loteId = $('#loteSelect').value;
  if (!loteId) return; // el select required marca su propio error

  const sabores = saboresSeleccionados();
  const tieneSabores = Object.keys(sabores).length > 0;
  $('#errorSabores').style.display = tieneSabores ? 'none' : 'block';
  if (!tieneSabores) return;

  const datos = {
    id: pedidoEnEdicion || generarId(),
    loteId,
    nombre: $('#nombre').value.trim(),
    sabores,
    entregado: false,
    pagado: false,
    creadoEn: Date.now(),
  };

  if (pedidoEnEdicion) {
    const original = pedidos.find((p) => p.id === pedidoEnEdicion);
    datos.entregado = original.entregado;
    datos.pagado = original.pagado;
    datos.creadoEn = original.creadoEn;
    pedidos = pedidos.map((p) => (p.id === pedidoEnEdicion ? datos : p));
    // Si el cliente cambió de tanda, se recalcula el estado de la tanda anterior
    const loteAnterior = lotePorId(original.loteId);
    if (loteAnterior) actualizarEstadoLote(loteAnterior);
  } else {
    pedidos.push(datos);
  }

  const loteNuevo = lotePorId(datos.loteId);
  if (loteNuevo) actualizarEstadoLote(loteNuevo);

  try {
    guardarDatos();
    renderTodo();
  } finally {
    bootstrap.Modal.getInstance('#modalPedido').hide();
  }
  mostrarPestanaPedidos();
}

// Elimina un pedido de cliente (con confirmación)
function eliminarPedido(id) {
  const pedido = pedidos.find((p) => p.id === id);
  if (!pedido) return;
  if (confirm(`¿Eliminar el pedido de "${pedido.nombre}"? Esta acción no se puede deshacer.`)) {
    const lote = lotePorId(pedido.loteId);
    pedidos = pedidos.filter((p) => p.id !== id);
    if (lote) actualizarEstadoLote(lote);
    guardarDatos();
    renderTodo();
  }
}

// Restablece los mensajes de error personalizados del pedido de cliente
function limpiarErrores() {
  $('#errorSabores').style.display = 'none';
}

/* 8. CAMBIOS DE ESTADO (ENTREGA, PAGO, AVANCE DE FASE) -------------------------- */

// Recalcula la fase de un pedido al proveedor según sus clientes:
// proveedor → entrega (primera entrega) → recaudo (primer pago) → finalizado (todos pagaron)
function actualizarEstadoLote(lote) {
  const lista = pedidosDeLote(lote.id);
  const total = lista.length;
  const entregados = lista.filter((p) => p.entregado).length;
  const pagados = lista.filter((p) => p.pagado).length;

  if (!total) lote.estado = 'proveedor';
  else if (pagados === total) lote.estado = 'finalizado';
  else if (pagados > 0) lote.estado = 'recaudo';
  else if (entregados > 0) lote.estado = 'entrega';
  else lote.estado = 'proveedor';
}

// Marca / desmarca la entrega de un pedido de cliente ("tachar")
function alternarEntrega(id) {
  const p = pedidos.find((x) => x.id === id);
  if (!p) return;
  p.entregado = !p.entregado;
  const lote = lotePorId(p.loteId);
  if (lote) actualizarEstadoLote(lote);
  guardarDatos();
  renderTodo();
}

// Marca / desmarca el pago de un pedido de cliente
function alternarPago(id) {
  const p = pedidos.find((x) => x.id === id);
  if (!p) return;
  p.pagado = !p.pagado;
  const lote = lotePorId(p.loteId);
  if (lote) actualizarEstadoLote(lote);
  guardarDatos();
  renderTodo();
}

/* 9. RENDERIZADO DE LAS VISTAS --------------------------------------------------- */

function vacioHTML(titulo, texto) {
  return `
    <div class="vacio">
      <i class="bi bi-inbox"></i>
      <p><strong>${titulo}</strong></p>
      <small>${texto}</small>
    </div>`;
}

function estadoEntrega(p) {
  return p.entregado
    ? '<span class="badge estado-ok">Entregado</span>'
    : '<span class="badge estado-pend">Por entregar</span>';
}

function estadoPago(p) {
  return p.pagado
    ? '<span class="badge estado-ok">Pagado</span>'
    : '<span class="badge estado-pend">Pendiente de pago</span>';
}

function listaSaboresHTML(sabores) {
  return Object.entries(sabores)
    .map(([sabor, n]) => `<span class="sabor-chip">${escaparHTML(sabor)} <strong>×${n}</strong></span>`)
    .join(' ');
}

function badgeEstadoLote(lote) {
  const e = ESTADOS_LOTE[lote.estado] || ESTADOS_LOTE.proveedor;
  return `<span class="badge ${e.badge}"><i class="bi ${e.icono}"></i> ${e.etiqueta}</span>`;
}

// FASE 1 · Proveedor: tarjetas de cada pedido de compra
// Ordena los lotes por fecha de llegada (más próximos primero)
function ordenLotesPorLlegada() {
  return lotes.slice().sort((a, b) => {
    const da = a.fechaRecepcion || '';
    const db = b.fechaRecepcion || '';
    if (da !== db) return da < db ? -1 : 1;
    return (a.numero || 0) - (b.numero || 0);
  });
}

function renderProveedor() {
  const cont = $('#listaLotes');
  if (!lotes.length) {
    cont.innerHTML = vacioHTML('No hay pedidos al proveedor', 'Crea el pedido de compra para poder registrar clientes.');
    return;
  }

  const orden = ordenLotesPorLlegada();
  cont.innerHTML = orden.map((l) => {
    const t = totalesLote(l);
    return `
      <article class="lote-card">
        <div class="pedido-cabecera">
          <div class="d-flex align-items-center gap-2 flex-wrap">
            <h2 class="h6 mb-0">Pedido ${etiquetaLote(l)}</h2>
            ${badgeEstadoLote(l)}
          </div>
          <div class="pedido-acciones">
            <button type="button" class="btn btn-icono" data-accion="editar-lote" data-id="${l.id}" title="Editar" aria-label="Editar pedido al proveedor">
              <i class="bi bi-pencil"></i>
            </button>
            <button type="button" class="btn btn-icono btn-icono-peligro" data-accion="eliminar-lote" data-id="${l.id}" title="Eliminar" aria-label="Eliminar pedido al proveedor">
              <i class="bi bi-trash"></i>
            </button>
          </div>
        </div>
        <div class="pedido-meta">
          <span><i class="bi bi-box-seam"></i> Llegada: ${fechaLegible(l.fechaRecepcion)}</span>
          ${l.fechaLimiteCobro ? `<span><i class="bi bi-cash-stack"></i> Límite recaudo: ${fechaLegible(l.fechaLimiteCobro)}</span>` : ''}
        </div>
        <div class="sabores">${listaSaboresHTML(t.saboresProveedor)}</div>
        <div class="lote-resumen">
          <span>Yogures <strong>${t.comprados}</strong></span>
          <span>Entregados <strong>${t.entregados}/${t.pedidosLote}</strong></span>
          <span>Pagados <strong>${t.pagados}/${t.pedidosLote}</strong></span>
        </div>
        <div class="financiero">
          <div><span class="etiqueta">Costo compra</span><strong>${formatearCOP(t.costo)}</strong></div>
          <div><span class="etiqueta">Ingresos</span><strong>${formatearCOP(t.ingresos)}</strong></div>
          <div class="financiero-ganancia"><span class="etiqueta">Ganancia</span><strong>${formatearCOP(t.ganancia)}</strong></div>
          <div><span class="etiqueta">Recaudado</span><strong>${formatearCOP(t.recaudado)}</strong></div>
        </div>
      </article>`;
  }).join('');
}

// Seguimiento de fases del pedido (mostrado al final del panel)
function fasesHTML(lote) {
  const idx = ORDEN_ESTADOS.indexOf(lote.estado);
  return `
    <div class="fases">
      ${ORDEN_ESTADOS.map((e, i) => {
        const meta = ESTADOS_LOTE[e];
        return `<span class="fase ${i === idx ? 'activa' : ''} ${i < idx ? 'hecha' : ''}"><i class="bi ${meta.icono}"></i> ${meta.etiqueta}</span>`;
      }).join('')}
    </div>`;
}

// FASE 2 · Pedidos: agrupados por estado (Enviado al proveedor / En entrega / En recaudo /
// Finalizado). Dentro de cada grupo un panel por pedido al proveedor, con las personas
// y sus yogures, y al final el seguimiento de fases del pedido.
function renderPedidos() {
  const r = resumenGeneral();
  $('#statPedidos').textContent = r.pedidos;
  $('#statUnidades').textContent = r.unidadesClientes;
  $('#statIngresos').textContent = formatearCOP(r.ingresos);
  $('#statGanancia').textContent = formatearCOP(r.ganancia);

  const cont = $('#listaPedidos');
  if (!lotes.length) {
    cont.innerHTML = vacioHTML('Aún no hay pedidos', 'Crea el primer pedido al proveedor con su fecha de llegada.') +
      `<button type="button" class="btn btn-primario" data-accion="nuevo-lote"><i class="bi bi-plus-lg"></i> Crear pedido al proveedor</button>`;
    return;
  }

  const orden = ordenLotesPorLlegada();

  // Un bloque (sección) por cada estado en el orden del flujo
  const bloques = ORDEN_ESTADOS.map((estado) => {
    const meta = ESTADOS_LOTE[estado];
    const lotesEstado = orden.filter((l) => (ESTADOS_LOTE[l.estado] ? l.estado : 'proveedor') === estado);
    if (!lotesEstado.length) return '';

    const paneles = lotesEstado.map((l) => {
      const t = totalesLote(l);
      const colapsado = lotesColapsados.has(l.id);
      const clientes = pedidosDeLote(l.id).slice().sort((a, b) => (b.creadoEn || 0) - (a.creadoEn || 0));

      const filas = clientes.map((p) => {
        const tp = totalesPedido(p);
        return `
          <article class="pedido-card">
            <div class="pedido-cabecera">
              <div class="d-flex align-items-center gap-2 flex-wrap">
                <h3 class="h6 mb-0">${escaparHTML(p.nombre)}</h3>
                ${estadoEntrega(p)} ${estadoPago(p)}
              </div>
              <div class="pedido-acciones">
                <button type="button" class="btn btn-icono" data-accion="editar" data-id="${p.id}" title="Editar" aria-label="Editar pedido">
                  <i class="bi bi-pencil"></i>
                </button>
                <button type="button" class="btn btn-icono btn-icono-peligro" data-accion="eliminar" data-id="${p.id}" title="Eliminar" aria-label="Eliminar pedido">
                  <i class="bi bi-trash"></i>
                </button>
              </div>
            </div>
            <div class="sabores">${listaSaboresHTML(p.sabores)}</div>
            <div class="unidades-persona"><i class="bi bi-basket"></i> ${tp.unidades} ${tp.unidades === 1 ? 'yogur' : 'yogures'}</div>
          </article>`;
      }).join('');

      return `
        <section class="lote-block ${colapsado ? 'lote-colapsado' : ''}">
          <div class="pedido-cabecera panel-cabecera">
            <div class="d-flex align-items-center gap-2 flex-wrap">
              <h2 class="h6 mb-0">Pedido ${etiquetaLote(l)}</h2>
              ${badgeEstadoLote(l)}
            </div>
            <div class="pedido-acciones">
              <button type="button" class="btn btn-icono" data-accion="exportar-pedido" data-id="${l.id}" title="Exportar archivo .txt" aria-label="Exportar conteo del pedido">
                <i class="bi bi-file-earmark-arrow-down"></i>
              </button>
              <button type="button" class="btn btn-icono" data-accion="alternar-lote" data-id="${l.id}" title="${colapsado ? 'Abrir pedido' : 'Cerrar pedido'}" aria-label="${colapsado ? 'Abrir pedido' : 'Cerrar pedido'}">
                <i class="bi ${colapsado ? 'bi-chevron-down' : 'bi-chevron-up'}"></i>
              </button>
              <button type="button" class="btn btn-primario btn-sm" data-accion="nuevo" data-id="${l.id}">
                <i class="bi bi-person-plus"></i> Agregar persona
              </button>
            </div>
          </div>
          <div class="lote-cuerpo ${colapsado ? 'd-none' : ''}">
            <div class="pedido-meta">
              <span><i class="bi bi-box-seam"></i> Llegada: ${fechaLegible(l.fechaRecepcion)}</span>
              ${l.fechaLimiteCobro ? `<span><i class="bi bi-cash-stack"></i> Límite recaudo: ${fechaLegible(l.fechaLimiteCobro)}</span>` : ''}
              <span><i class="bi bi-people"></i> Personas: ${t.pedidosLote} · Yogures: ${t.unidadesClientes}</span>
            </div>
            ${clientes.length
              ? `<div class="d-grid gap-3 mt-3">${filas}</div>`
              : '<div class="sin-clientes">Aún no hay personas en este pedido. Usa "Agregar persona".</div>'}
            <div class="financiero">
              <div><span class="etiqueta">Unidades</span><strong>${t.unidadesClientes}</strong></div>
              <div><span class="etiqueta">Inversión</span><strong>${formatearCOP(t.costo)}</strong></div>
              <div><span class="etiqueta">Ingresos</span><strong>${formatearCOP(t.ingresos)}</strong></div>
              <div class="financiero-ganancia"><span class="etiqueta">Ganancia</span><strong>${formatearCOP(t.ganancia)}</strong></div>
            </div>
            ${fasesHTML(l)}
          </div>
        </section>`;
    }).join('');

    return `
      <section class="estado-seccion">
        <div class="estado-seccion-titulo">
          <i class="bi ${meta.icono}"></i>
          <h2 class="h6 mb-0">${meta.etiqueta}</h2>
          <span class="badge estado-contador">${lotesEstado.length}</span>
        </div>
        <div class="d-grid gap-3">${paneles}</div>
      </section>`;
  }).join('');

  cont.innerHTML = bloques;
}

// Abre o cierra (colapsa) el detalle de un pedido en la pestaña Pedidos
function alternarColapsoLote(id) {
  if (lotesColapsados.has(id)) lotesColapsados.delete(id);
  else lotesColapsados.add(id);
  renderPedidos();
}

// Exporta el conteo de un pedido a un archivo .txt descargable
function exportarPedidoTxt(id) {
  const lote = lotePorId(id);
  if (!lote) return;
  const t = totalesLote(lote);
  const lista = pedidosDeLote(lote.id);
  const sabores = agregarSabores(lista);

  const lineas = [
    `CONTEO DE YOGURES - PEDIDO ${etiquetaLote(lote)}`,
    '',
    `Fecha de llegada: ${fechaLegible(lote.fechaRecepcion)}`,
    `Fecha límite de recaudo: ${lote.fechaLimiteCobro ? fechaLegible(lote.fechaLimiteCobro) : 'Sin definir'}`,
    `Estado: ${ESTADOS_LOTE[lote.estado] ? ESTADOS_LOTE[lote.estado].etiqueta : ''}`,
    `Personas: ${t.pedidosLote}`,
    '',
    `TOTAL DE YOGURES: ${t.comprados}`,
    `INVERSIÓN (pago al proveedor): ${formatearCOP(t.costo)}`,
    `INGRESOS: ${formatearCOP(t.ingresos)}`,
    `GANANCIA: ${formatearCOP(t.ganancia)}`,
    '',
    'SABORES Y CANTIDADES:',
  ];

  Object.entries(sabores)
    .sort((a, b) => b[1] - a[1])
    .forEach(([sabor, cantidad]) => {
      lineas.push(`- ${sabor}: ${cantidad}`);
    });

  if (!Object.keys(sabores).length) lineas.push('- Sin sabores registrados');

  lineas.push('');
  lineas.push('Personas del pedido:');
  if (lista.length) {
    lista.forEach((p) => {
      lineas.push(`- ${p.nombre}: ${totalUnidades(p)} yogures`);
    });
  } else {
    lineas.push('- Sin personas registradas');
  }

  const contenido = lineas.join('\r\n');
  const blob = new Blob([contenido], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const enlace = document.createElement('a');
  enlace.href = url;
  enlace.download = `Conteo de yogures pedido ${lote.numero}.txt`;
  document.body.appendChild(enlace);
  enlace.click();
  document.body.removeChild(enlace);
  URL.revokeObjectURL(url);
}

// FASE 3 · Entrega: progreso global + bloques por tanda para "tachar" entregas
function renderEntrega() {
  const r = resumenGeneral();
  const pct = r.unidadesClientes ? Math.round((r.unidadesEntregadas / r.unidadesClientes) * 100) : 0;

  const resumen = `
    <div class="progreso-box mb-3">
      <div class="d-flex justify-content-between align-items-center mb-1">
        <h2>Entrega de yogures</h2>
        <span class="progreso-num">${r.unidadesEntregadas} de ${r.unidadesClientes} yogures</span>
      </div>
      <div class="progress rounded-pill mb-2">
        <div class="progress-bar" style="width:${pct}%">${pct}%</div>
      </div>
      <small class="text-muted fw-bold">${r.entregados} de ${r.pedidos} personas entregadas</small>
    </div>`;

  const cont = $('#listaEntrega');
  if (!lotes.length) {
    cont.innerHTML = resumen + vacioHTML('No hay pedidos para entregar', 'Crea primero un pedido al proveedor.');
    return;
  }

  const bloques = lotes.map((l) => {
    const lista = pedidosDeLote(l.id);
    if (!lista.length) return null;
    const t = totalesLote(l);
    const lpct = t.unidadesClientes ? Math.round((t.unidadesEntregadas / t.unidadesClientes) * 100) : 0;
    const filas = lista.map((p) => {
      const tp = totalesPedido(p);
      return `
        <div class="fila-entrega ${p.entregado ? 'entregado' : ''}">
          <div class="fila-info">
            <strong class="${p.entregado ? 'tachado' : ''}">${escaparHTML(p.nombre)}</strong>
            <small>${tp.unidades} ${tp.unidades === 1 ? 'yogur' : 'yogures'}</small>
          </div>
          <button type="button" class="btn btn-sm ${p.entregado ? 'btn-ok' : 'btn-outline'}" data-accion="alternar-entrega" data-id="${p.id}">
            ${p.entregado ? '<i class="bi bi-check2-circle"></i> Entregado' : '<i class="bi bi-truck"></i> Marcar entregado'}
          </button>
        </div>`;
    }).join('');
    return `
      <div class="lote-block">
        <div class="d-flex justify-content-between align-items-center mb-1">
          <h3 class="h6 mb-0">Pedido ${etiquetaLote(l)} ${badgeEstadoLote(l)}</h3>
          <span class="progreso-num">${t.unidadesEntregadas}/${t.unidadesClientes}</span>
        </div>
        <div class="progress rounded-pill mb-3">
          <div class="progress-bar" style="width:${lpct}%">${lpct}%</div>
        </div>
        <div class="d-grid gap-2">${filas}</div>
      </div>`;
  }).filter(Boolean).join('');

  cont.innerHTML = resumen + bloques;
}

// FASE 4 · Recaudo: recaudado vs pendiente con fecha límite única por tanda
function renderRecaudo() {
  const r = resumenGeneral();
  $('#cobroRecaudado').textContent = formatearCOP(r.recaudado);
  $('#cobroPendiente').textContent = formatearCOP(r.pendientes);
  $('#cobroPendiente').classList.toggle('peligro', r.pendientes > 0);

  const pct = r.ingresos ? Math.round((r.recaudado / r.ingresos) * 100) : 0;
  const resumen = `
    <div class="progreso-box mb-3">
      <div class="d-flex justify-content-between align-items-center mb-1">
        <h2>Avance del recaudo</h2>
        <span class="progreso-num">${formatearCOP(r.recaudado)} de ${formatearCOP(r.ingresos)}</span>
      </div>
      <div class="progress rounded-pill">
        <div class="progress-bar" style="width:${pct}%">${pct}%</div>
      </div>
    </div>`;

  const cont = $('#listaCobros');
  if (!lotes.length) {
    cont.innerHTML = resumen + vacioHTML('No hay pedidos para cobrar', 'Crea primero un pedido al proveedor.');
    return;
  }

  const hoy = hoyISO();
  const bloques = lotes.map((l) => {
    const lista = pedidosDeLote(l.id);
    if (!lista.length) return null;
    const t = totalesLote(l);
    const vencio = t.pendientes > 0 && l.fechaLimiteCobro && l.fechaLimiteCobro < hoy;
    const lpct = t.ingresos ? Math.round((t.recaudado / t.ingresos) * 100) : 0;

    // Pendientes primero para visibilidad clara de lo que falta
    const filas = lista.slice().sort((a, b) => (a.pagado ? 1 : 0) - (b.pagado ? 1 : 0)).map((p) => {
      const tp = totalesPedido(p);
      return `
        <div class="fila-cobro ${p.pagado ? 'pagado' : 'pendiente'}">
          <div class="fila-info">
            <strong class="${p.pagado ? 'tachado' : ''}">${escaparHTML(p.nombre)}</strong>
            <small>${formatearCOP(tp.ingresos)} · ${tp.unidades} ${tp.unidades === 1 ? 'yogur' : 'yogures'}</small>
          </div>
          ${p.pagado
            ? `<button type="button" class="btn btn-sm btn-ok" data-accion="alternar-pago" data-id="${p.id}"><i class="bi bi-check2-circle"></i> Pagado</button>`
            : `<button type="button" class="btn btn-sm btn-outline" data-accion="alternar-pago" data-id="${p.id}"><i class="bi bi-cash-coin"></i> Marcar pagado</button>`}
        </div>`;
    }).join('');

    return `
      <div class="lote-block">
        <div class="d-flex justify-content-between align-items-center mb-1 flex-wrap gap-2">
          <h3 class="h6 mb-0">Pedido ${etiquetaLote(l)} ${badgeEstadoLote(l)}</h3>
          ${vencio ? '<span class="badge estado-vencido">Fecha límite vencida</span>' : ''}
        </div>
        <div class="recaudo-fecha ${vencio ? 'vencida' : ''}">
          <i class="bi bi-alarm"></i> Límite de recaudo: <strong>${l.fechaLimiteCobro ? fechaLegible(l.fechaLimiteCobro) : 'Sin definir'}</strong>
          ${vencio ? `<span class="peligro">· Pendiente ${formatearCOP(t.pendientes)}</span>` : ''}
        </div>
        <div class="progress rounded-pill mb-3">
          <div class="progress-bar" style="width:${lpct}%">${lpct}%</div>
        </div>
        <div class="d-grid gap-2">${filas}</div>
      </div>`;
  }).filter(Boolean).join('');

  cont.innerHTML = resumen + bloques;
}

// Repinta todas las vistas (aisladas: un fallo no bloquea al resto)
function renderTodo() {
  const vistas = [
    ['renderProveedor', renderProveedor],
    ['renderPedidos', renderPedidos],
    ['renderEntrega', renderEntrega],
    ['renderRecaudo', renderRecaudo],
  ];
  vistas.forEach(([nombre, fn]) => {
    try {
      fn();
    } catch (error) {
      console.error('Error al renderizar ' + nombre + ':', error);
    }
  });
}

// Cambia a la pestaña de Pedidos tras guardar para que se vea el resultado al instante
function mostrarPestanaPedidos() {
  const pestana = document.getElementById('tab-pedidos-b');
  if (pestana && window.bootstrap && bootstrap.Tab) {
    bootstrap.Tab.getOrCreateInstance(pestana).show();
  }
}

/* 10. INICIALIZACIÓN Y EVENTOS GLOBALES ------------------------------------------ */

// Delegación de clics para todas las acciones con data-accion
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-accion]');
  if (!btn) return;
  const accion = btn.dataset.accion;
  const id = btn.dataset.id;
  switch (accion) {
    case 'nuevo': abrirFormNuevo(id); break;
    case 'editar': abrirFormEditar(id); break;
    case 'eliminar': eliminarPedido(id); break;
    case 'nuevo-lote': abrirFormLoteNuevo(); break;
    case 'editar-lote': abrirFormLoteEditar(id); break;
    case 'eliminar-lote': eliminarLote(id); break;
    case 'alternar-entrega': alternarEntrega(id); break;
    case 'alternar-pago': alternarPago(id); break;
    case 'alternar-lote': alternarColapsoLote(id); break;
    case 'exportar-pedido': exportarPedidoTxt(id); break;
    case 'resetear-datos': resetearDatos(); break;
  }
});

// Eventos del selector de sabores (delegación sobre el contenedor)
function configurarSelectorSabores() {
  $('#selectorSabores').addEventListener('click', (e) => {
    const btn = e.target.closest('.stepper-btn');
    if (!btn) return;
    const fila = btn.closest('.sabor-fila');
    cambiarCantidad(fila, btn.dataset.op === 'mas' ? 1 : -1);
  });
}

// Eventos del formulario de pedido de cliente
function configurarFormulario() {
  $('#formPedido').addEventListener('submit', guardarPedido);
  $('#modalPedido').addEventListener('shown.bs.modal', () => $('#nombre').focus());
}

// Eventos del formulario de lote (pedido al proveedor)
function configurarFormularioLote() {
  $('#formLote').addEventListener('submit', guardarLote);

  // Al corregir la fecha límite se oculta el error personalizado
  $('#fechaLimiteCobro').addEventListener('input', () => {
    $('#fechaLimiteCobro').classList.remove('is-invalid');
    $('#errorLimiteLote').textContent = 'No puede ser anterior a la fecha de llegada.';
    $('#errorLimiteLote').style.display = 'none';
  });

  $('#modalLote').addEventListener('shown.bs.modal', () => $('#fechaRecepcion').focus());
}

// Punto de entrada de la aplicación
document.addEventListener('DOMContentLoaded', () => {
  cargarDatos();
  renderSelectorSabores();
  configurarSelectorSabores();
  configurarFormulario();
  configurarFormularioLote();
  renderTodo();
});