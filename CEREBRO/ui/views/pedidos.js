// Ciclo de vida del pedido y demás máquinas de estado: transiciones, quién las aplica y dónde se escribe el estado.
import { esc, D, fmt, loc, symLink, short, chips } from '../lib.js';
import { mountGraph, layoutColumns } from '../graph.js';

const MEM = (v) => (v && v._enum ? v.miembro : typeof v === 'string' ? v : v && v._texto ? `⟨${v._texto}⟩` : JSON.stringify(v));
const KEY = (k) => String(k).replace(/^[A-Za-z]+\./, '');

function transitions(t) {
  // valor: { 'OrderStatus.PENDING': [ {_enum, miembro} ... ] }
  const v = t.valor;
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const map = {};
  for (const [k, arr] of Object.entries(v)) {
    if (k.startsWith('_')) continue;
    if (!Array.isArray(arr)) return null;
    map[KEY(k)] = arr.map(MEM);
  }
  return Object.keys(map).length ? map : null;
}

function diagram(el, map, { onClick } = {}) {
  const states = new Set(Object.keys(map));
  for (const arr of Object.values(map)) for (const s of arr) states.add(s);
  // niveles por BFS desde estados sin entradas
  const incoming = new Map([...states].map((s) => [s, 0]));
  for (const arr of Object.values(map)) for (const s of arr) incoming.set(s, (incoming.get(s) ?? 0) + 1);
  const roots = [...states].filter((s) => !incoming.get(s));
  const level = new Map();
  const q = (roots.length ? roots : [...states].slice(0, 1)).map((r) => { level.set(r, 0); return r; });
  while (q.length) {
    const c = q.shift();
    for (const n of map[c] ?? []) if (!level.has(n) && n !== c) { level.set(n, level.get(c) + 1); q.push(n); }
  }
  const nodes = [...states].map((s) => ({ id: s, label: s, col: level.get(s) ?? 0, w: 150, h: 34, color: (map[s] ?? []).length === 0 ? '#E5B242' : undefined, title: (map[s] ?? []).length === 0 ? `${s} (terminal)` : s }));
  layoutColumns(nodes, { colW: 210, rowH: 52, nodeW: 150 });
  const edges = [];
  for (const [a, arr] of Object.entries(map)) for (const b of arr) edges.push({ a, b, estilo: b === 'CANCELLED' || b === 'REJECTED' || b === 'FAILED' ? 'unk' : 'est', label: `${a} → ${b}` });
  mountGraph(el, { nodes, edges, onSelect: onClick });
}

export default async function render(el, params, { setParams }) {
  const est = await D('estados');
  const orden = est.tablas.filter((t) => transitions(t));
  const sel = params.get('t') ?? 'VALID_TRANSITIONS';
  const t = orden.find((x) => x.nombre === sel) ?? orden[0];
  const writes = est.escriturasDeEstado.OrderStatus;
  const flujos = est.flujosNegocio ?? [];
  const otras = est.tablas.filter((x) => !transitions(x) && /ALLOWED|CANCELLABLE|ASSIGNABLE|TERMINAL|CANCELLER|ACTIVE|OPEN|STATUSES/.test(x.nombre));
  el.innerHTML = `
  <div class="page-head"><h1>Pedidos y estados</h1><p class="lede">Las máquinas de estado salen de las tablas reales del código (por ejemplo <code>VALID_TRANSITIONS</code> en <code>order.service.ts</code>), no de un diagrama dibujado a mano. Debajo: quién escribe cada estado y los procesos de negocio documentados.</p></div>
  ${chips(orden.map((x) => ({ v: x.nombre, t: x.nombre })), t?.nombre, 't')}
  ${t ? `<div class="small muted2" style="margin-bottom:6px">${loc(t.archivo, t.linea)} · amarillo = estado terminal · punteado = cancelación/rechazo · ${t.consumidores.length} funciones consultan esta tabla</div><div class="map-wrap" id="dg" style="height:440px"></div>` : '<p class="empty">No se encontraron tablas de transición.</p>'}
  ${t ? `<div class="section"><h2>Transiciones</h2><div class="twrap"><table><thead><tr><th>Desde</th><th>Puede pasar a</th></tr></thead><tbody>${Object.entries(transitions(t)).map(([k, v]) => `<tr><td><b>${esc(k)}</b></td><td>${v.length ? v.map((x) => `<span class="tag ${x === 'CANCELLED' ? 'bad' : ''}">${esc(x)}</span>`).join(' ') : '<span class="muted2">terminal: no sale de aquí</span>'}</td></tr>`).join('')}</tbody></table></div>
    <p class="small muted2" style="margin-top:6px">Funciones que consultan la tabla: ${t.consumidores.slice(0, 8).map((c) => symLink(c.de, short(c.de.split('#')[1], 1))).join(' · ') || '—'}</p></div>` : ''}

  ${writes ? `<div class="section"><h2>Dónde se escribe el estado del pedido</h2>
    <p class="lede">Cada fila es una función de producción que asigna ese estado (<code>status: OrderStatus.X</code> o una asignación). Si una escritura está fuera de la función que valida <code>VALID_TRANSITIONS</code>, la transición no pasa por la máquina de estados: hay que revisarla.</p>
    <div class="twrap"><table><thead><tr><th>Estado</th><th>Escritores</th><th>Comparaciones</th></tr></thead><tbody>${writes.miembros.map((m) => { const u = writes.usos[m] ?? { escribe: [], compara: [] }; return `<tr><td><b>${esc(m)}</b></td><td class="small">${u.escribe.slice(0, 6).map((x) => `${symLink(x.de, short(x.de.split('#')[1], 2))} <span class="muted2">:${x.linea}</span>`).join('<br>') || '<span class="muted2">ninguno</span>'}${u.escribe.length > 6 ? `<br><span class="muted2">+${u.escribe.length - 6}</span>` : ''}</td><td class="small num">${u.compara.length}</td></tr>`; }).join('')}</tbody></table></div></div>` : ''}

  <div class="section"><h2>Reglas por rol y condiciones</h2><div class="twrap"><table><thead><tr><th>Tabla</th><th>Contenido</th><th>Definida en</th></tr></thead><tbody>${otras.slice(0, 40).map((x) => `<tr><td class="mono">${esc(x.nombre)}</td><td class="small clip">${esc(x.texto)}</td><td class="small">${loc(x.archivo, x.linea, short(x.archivo, 2) + ':' + x.linea)}</td></tr>`).join('')}</tbody></table></div></div>

  <div class="section"><h2>Procesos de negocio documentados</h2>
    ${flujos.length ? flujos.map((fl) => flujo(fl)).join('') : '<p class="empty">Aún no hay procesos documentados en <code>CEREBRO/manual/flujos-negocio.json</code>.</p>'}
  </div>`;
  if (t) diagram(el.querySelector('#dg'), transitions(t), {});
  el.querySelector('.chips')?.addEventListener('click', (ev) => { const c = ev.target.closest('.chip'); if (c) { setParams({ t: c.dataset.v }); render(el, new URLSearchParams(location.hash.split('?')[1] ?? ''), { setParams }); } });
}

export function flujo(fl) {
  return `<details class="flow" style="margin:0 0 16px" ${fl.vigencia !== 'vigente' ? '' : ''} open>
    <summary style="cursor:pointer;display:flex;gap:12px;align-items:baseline;flex-wrap:wrap"><h3 style="display:inline">${esc(fl.titulo)}</h3> ${fl.vigencia === 'vigente' ? '<span class="tag ok">referencias vigentes</span>' : `<span class="tag warn">pendiente de revisión · ${fl.referenciasRotas} referencia(s) ya no coinciden</span>`} ${fl.estadoVerificacion ? `<span class="tag">${esc(fl.estadoVerificacion)}</span>` : ''}</summary>
    ${fl.descripcion ? `<p class="muted2">${esc(fl.descripcion)}</p>` : ''}
    <div class="trace">${(fl.pasos ?? []).map((p) => `<div class="step ${p.estadoPaso === 'obsoleto' ? 'bad' : p.estadoPaso === 'revisar' ? 'gap' : p.certeza === 'inferida' ? 'inf' : ''}"><div class="step-h"><span class="step-k">${esc(p.actor ?? p.orden ?? '')}</span><span class="step-t">${esc(p.titulo)}</span>${p.certeza ? `<span class="tag ${p.certeza === 'verificada-en-prueba' ? 'ok' : p.certeza === 'inferida' ? 'info dash' : 'gold'}">${esc(p.certeza)}</span>` : ''}${(p.refs ?? []).map((r) => (r.archivo ? loc(r.archivo, r.linea, short(r.archivo, 2) + ':' + r.linea) : '') + (r.estadoRef && r.estadoRef !== 'ok' && r.estadoRef !== 'sin-ancla' ? ` <span class="tag warn">${esc(r.estadoRef)}</span>` : '')).join(' ')}</div>
      ${p.descripcion ? `<div class="step-d">${esc(p.descripcion)}</div>` : ''}${p.formula ? `<div class="step-d"><code>${esc(p.formula)}</code></div>` : ''}${p.entradas?.length ? `<div class="step-d small">Entradas: ${p.entradas.map((x) => `<code>${esc(x)}</code>`).join(' ')}</div>` : ''}${p.salidas?.length ? `<div class="step-d small">Resultado: ${p.salidas.map((x) => `<code>${esc(x)}</code>`).join(' ')}</div>` : ''}${p.riesgo ? `<div class="note warn small" style="margin-top:4px">${esc(p.riesgo)}</div>` : ''}</div>`).join('')}</div></details>`;
}
