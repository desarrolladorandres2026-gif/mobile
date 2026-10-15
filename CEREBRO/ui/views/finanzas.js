// Mapa financiero: flujos de dinero reconstruidos del código, con fórmulas, responsables y evidencia verificable.
import { esc, D, fmt, loc, symLink, short, chips, confTag } from '../lib.js';
import { mountGraph, layoutColumns } from '../graph.js';
import { flujo } from './pedidos.js';

export default async function render(el, params, { setParams }) {
  const [din, hall, models] = await Promise.all([D('dinero'), D('hallazgos'), D('modelos')]);
  const sel = params.get('f') ?? din.flujos[0]?.id;
  const fl = din.flujos.find((x) => x.id === sel) ?? din.flujos[0];
  const fin = hall.filter((h) => h.area === 'finanzas');
  const moneyFields = [];
  const MONEY = /amount|price|total|fee|commission|payout|discount|balance|tip|cost|revenue|tax|subtotal|cashback|points|credit|debt|refund|bps|margin|expense|surcharge|deposit/i;
  for (const m of models) for (const c of m.campos) if (MONEY.test(c.nombre) && /Number/.test(c.tipo ?? '')) moneyFields.push({ modelo: m.nombre, campo: c.nombre, entero: c.validador, archivo: m.archivo, linea: c.linea });
  el.innerHTML = `
  <div class="page-head"><h1>Finanzas</h1><p class="lede">Flujos económicos reconstruidos de principio a fin. Regla de la casa: ninguna conclusión de rentabilidad sin <b>todos</b> los costes (comisión, domicilio, pago al repartidor, descuentos, promociones, cashback, coste de Wompi, transferencia, impuestos, devoluciones, cancelaciones). Si una cifra no está respaldada por una referencia viva al código, no aparece aquí como hecho.</p></div>
  ${din.flujos.length ? chips(din.flujos.map((x) => ({ v: x.id, t: x.titulo.length > 38 ? x.titulo.slice(0, 36) + '…' : x.titulo })), fl?.id, 'f') : ''}
  ${fl ? `<div class="section">${actoresDiagrama(fl)}${flujo(fl)}${fl.importes?.length ? `<h2>Importes del flujo</h2><div class="twrap"><table><thead><tr><th>Importe</th><th>Cómo se calcula</th><th>Origen</th><th>Destino</th><th>Quién lo calcula</th></tr></thead><tbody>${fl.importes.map((i) => `<tr><td><b>${esc(i.nombre)}</b></td><td class="small"><code>${esc(i.formula ?? '')}</code></td><td class="small">${esc(i.origen ?? '')}</td><td class="small">${esc(i.destino ?? '')}</td><td class="small">${i.simbolo ? symLink(i.simbolo, short(i.simbolo.split('#')[1], 2)) : ''}</td></tr>`).join('')}</tbody></table></div>` : ''}</div>` : '<p class="empty" style="margin-top:20px">Aún no hay flujos en <code>CEREBRO/manual/flujos-dinero.json</code>.</p>'}
  <div class="section"><h2>Hallazgos financieros (${fin.length})</h2>${fin.length ? `<ul class="plain">${fin.slice(0, 40).map((h) => `<li><span class="sev-${esc(h.severidad)}">${esc(h.severidad)}</span> <span class="tag">${esc(h.confianza)}</span> <span class="sym" data-open="hallazgo" data-id="${esc(h.id)}">${esc(h.titulo)}</span></li>`).join('')}</ul>` : '<p class="empty">Ninguno registrado.</p>'}</div>
  <div class="section"><h2>Constantes y tarifas en el código</h2><div class="twrap"><table><thead><tr><th>Constante</th><th>Valor / expresión</th><th>Usos</th><th>Definida en</th></tr></thead><tbody>${din.constantes.map((c) => `<tr><td class="mono">${esc(c.nombre)}</td><td class="small mono">${esc(c.texto)}</td><td class="num">${c.consumidores}</td><td class="small">${loc(c.archivo, c.linea, short(c.archivo, 2) + ':' + c.linea)}</td></tr>`).join('')}</tbody></table></div>
    <p class="small muted2" style="margin-top:6px">Las tarifas configurables desde el panel (por ejemplo la comisión) viven en la base de datos (<code>PlatformPricingConfig</code>), no aquí; estas son solo las constantes de código.</p></div>
  <div class="section"><h2>Campos numéricos con dinero (${moneyFields.length})</h2><div class="twrap"><table><thead><tr><th>Modelo</th><th>Campo</th><th>Validador entero</th><th></th></tr></thead><tbody>${moneyFields.slice(0, 200).map((f) => `<tr><td>${esc(f.modelo)}</td><td class="mono">${esc(f.campo)}</td><td>${f.entero ? '<span class="tag ok">sí</span>' : '<span class="tag dot3">no declarado</span>'}</td><td class="small">${loc(f.archivo, f.linea, ':' + f.linea)}</td></tr>`).join('')}</tbody></table></div><p class="small muted2">Invariante de ZIPP: el dinero es entero en COP. «No declarado» significa que el esquema no valida enteros en ese campo (puede validarse en el servicio).</p></div>`;
  el.querySelector('.chips')?.addEventListener('click', (ev) => { const c = ev.target.closest('.chip'); if (c) { setParams({ f: c.dataset.v }); render(el, new URLSearchParams(location.hash.split('?')[1] ?? ''), { setParams }); } });
  if (fl?.movimientos?.length) {
    const nodesMap = new Map();
    for (const m of fl.movimientos) for (const x of [m.de, m.a]) if (!nodesMap.has(x)) nodesMap.set(x, { id: x, label: x, col: 0 });
    const inc = new Map([...nodesMap.keys()].map((k) => [k, 0]));
    for (const m of fl.movimientos) inc.set(m.a, inc.get(m.a) + 1);
    const level = new Map();
    const roots = [...nodesMap.keys()].filter((k) => !inc.get(k));
    const queue = roots.map((r) => { level.set(r, 0); return r; });
    while (queue.length) { const c = queue.shift(); for (const m of fl.movimientos) if (m.de === c && !level.has(m.a)) { level.set(m.a, level.get(c) + 1); queue.push(m.a); } }
    const nodes = [...nodesMap.values()].map((n) => ({ ...n, col: level.get(n.id) ?? 1, w: 160, h: 38 }));
    layoutColumns(nodes, { colW: 250, rowH: 62, nodeW: 160 });
    const edges = fl.movimientos.map((m) => ({ a: m.de, b: m.a, w: 2, estilo: m.certeza === 'inferida' ? 'inf' : m.certeza === 'sin-confirmar' ? 'unk' : 'est', label: `${m.concepto}${m.formula ? ' = ' + m.formula : ''}` }));
    const host = el.querySelector('#actores');
    if (host) mountGraph(host, { nodes, edges, onSelect: () => {} });
  }
}

function actoresDiagrama(fl) {
  if (!fl.movimientos?.length) return '';
  return `<h2>Quién paga a quién</h2><div class="map-wrap" id="actores" style="height:360px"></div>
  <div class="twrap" style="margin:12px 0 22px"><table><thead><tr><th>De</th><th>A</th><th>Concepto</th><th>Fórmula / regla</th><th>Certeza</th></tr></thead><tbody>${fl.movimientos.map((m) => `<tr><td>${esc(m.de)}</td><td>${esc(m.a)}</td><td><b>${esc(m.concepto)}</b></td><td class="small"><code>${esc(m.formula ?? '')}</code></td><td>${confTag(m.certeza === 'inferida' ? 'inferida' : m.certeza === 'sin-confirmar' ? 'sin' : 'estatica')}</td></tr>`).join('')}</tbody></table></div>`;
}
