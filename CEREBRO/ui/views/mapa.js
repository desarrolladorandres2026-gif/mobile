// Mapa navegable: vista de módulos con zoom semántico (grupo → archivos) y vista de foco por símbolo.
import { esc, D, A, fmt, short, loc, symLink, debounce, confTag } from '../lib.js';
import { mountGraph, layoutLayers, layoutColumns } from '../graph.js';
import { openDrawer } from '../drawers.js';

const PKG_COLOR = { backend: '#E5B242', mobile: '#7DB4FF', admin: '#34D399', business: '#F59E0B', web: '#C084FC', desktop: '#F472B6', deploy: '#9DAAC4', scripts: '#9DAAC4', docs: '#9DAAC4' };

function grupo(file, nivel, foco) {
  const parts = file.split('/');
  const pkg = parts[0];
  if (nivel === 1) return pkg;
  let rest = parts.slice(1);
  if (rest[0] === 'src') rest = rest.slice(1);
  if (['backend'].includes(pkg) && rest[0] === '__tests__') return `${pkg}/pruebas`;
  const g = rest.length > 1 ? `${pkg}/${rest[0]}` : `${pkg}/(raíz)`;
  if (foco && g === foco) return file; // nivel archivo dentro del grupo enfocado
  return g;
}
function colOf(g) {
  if (/^(mobile|admin|business|web|desktop)(\/|$)/.test(g)) return 0;
  if (/^backend\/routes/.test(g)) return 1;
  if (/^backend\/(middlewares|validators|controllers)/.test(g)) return 2;
  if (/^backend\/(services)/.test(g)) return 3;
  if (/^backend\/(models|security|utils|cache|config|sockets|realtime|types|constants)/.test(g)) return 4;
  return 5;
}

export default async function render(el, params, { setParams, go }) {
  const foco = params.get('foco');
  if (foco) return renderFoco(el, params, foco, { setParams, go });
  return renderModulos(el, params, { setParams, go });
}

async function renderModulos(el, params, { setParams }) {
  const [inv, imps, calls, eps] = await Promise.all([D('inventario'), D('archivos-grafo'), D('llamadas-api'), D('endpoints')]);
  const nivel = Number(params.get('nivel') ?? 2);
  const drill = params.get('grupo') ?? '';
  const paq = params.get('paq') ?? '';
  const minW = Number(params.get('min') ?? 6);
  const files = inv.archivos.filter((f) => f.modo === 'ast' && f.clase !== 'prueba' && (!paq || f.paquete === paq));
  const fileSet = new Set(files.map((f) => f.ruta));
  const G = (f) => grupo(f, nivel, drill);
  const nodes = new Map();
  for (const f of files) {
    const g = G(f.ruta);
    if (!nodes.has(g)) nodes.set(g, { id: g, label: g === f.ruta ? g.split('/').slice(-1)[0] : g, files: 0, lines: 0, pkg: f.paquete, isFile: g === f.ruta });
    const n = nodes.get(g); n.files++; n.lines += f.lineas ?? 0;
  }
  const edgeMap = new Map();
  const addE = (a, b, w, kind) => {
    if (a === b || !nodes.has(a) || !nodes.has(b)) return;
    const k = `${a}>${b}>${kind}`;
    const e = edgeMap.get(k) ?? { a, b, w: 0, kind };
    e.w += w; edgeMap.set(k, e);
  };
  for (const [de, a, tipo] of imps.filas) { if (tipo === 'tipo' || !fileSet.has(de) || !fileSet.has(a)) continue; addE(G(de), G(a), 1, 'imp'); }
  const epFile = new Map(eps.endpoints.map((e) => [e.id, e.archivo]));
  for (const c of calls) for (const id of c.endpoints) { const ef = epFile.get(id); if (ef && fileSet.has(c.archivo) && fileSet.has(ef)) addE(G(c.archivo), G(ef), 1, 'api'); }
  let edges = [...edgeMap.values()].filter((e) => e.w >= (nivel === 1 ? 1 : minW) || (e.kind === 'api' && e.w >= 2));
  if (edges.length > 260) { edges.sort((a, b) => b.w - a.w); edges = edges.slice(0, 260); }
  const used = new Set(edges.flatMap((e) => [e.a, e.b]));
  const list = [...nodes.values()].filter((n) => used.has(n.id) || nivel === 1);
  for (const n of list) {
    n.sub = `${fmt(n.files)} arch. · ${fmt(n.lines)} líneas`;
    n.col = n.isFile ? colOf(drill) : colOf(n.id);
    n.color = PKG_COLOR[n.pkg] ?? '#9DAAC4';
    n.w = Math.max(130, Math.min(210, 60 + n.label.length * 7.2));
    n.h = 40;
    n.title = `${n.id}\n${n.sub}`;
  }
  // En nivel archivo, el col del grupo enfocado se hereda
  const gEdges = edges.map((e) => ({ a: e.a, b: e.b, w: e.w, estilo: e.kind === 'api' ? 'inf' : 'est', label: `${e.w} ${e.kind === 'api' ? 'llamadas HTTP' : 'imports'}` }));
  layoutLayers(list);

  const paquetes = [...new Set(inv.archivos.filter((f) => f.modo === 'ast').map((f) => f.paquete))];
  el.innerHTML = `
  <div class="page-head"><h1>Mapa</h1><p class="lede">${drill ? `Dentro de <b>${esc(drill)}</b>: sus archivos y las conexiones con el resto.` : 'Módulos del proyecto y sus dependencias reales (imports resueltos y llamadas HTTP). Arrastra para mover, rueda para acercar, clic en un módulo para ver qué contiene y doble clic para entrar.'}</p></div>
  <div class="filters">
    <label>Nivel <select id="nv"><option value="1" ${nivel === 1 ? 'selected' : ''}>aplicaciones</option><option value="2" ${nivel === 2 ? 'selected' : ''}>módulos</option></select></label>
    <label>App <select id="pq"><option value="">todas</option>${paquetes.map((p) => `<option ${paq === p ? 'selected' : ''}>${esc(p)}</option>`).join('')}</select></label>
    <label>Mostrar conexiones con ≥ <input id="mn" type="number" min="1" max="60" value="${minW}" style="width:60px"> enlaces</label>
    ${drill ? `<button class="btn quiet" id="up">← salir de ${esc(drill)}</button>` : ''}
    <label>Ir a <input id="goto" type="search" placeholder="símbolo o función…" style="width:240px"></label>
    <span class="small muted2">${fmt(list.length)} nodos · ${fmt(gEdges.length)} conexiones</span>
  </div>
  <div class="map-wrap"><div id="mw" class="map-canvas"></div><div class="map-tools"><button class="btn quiet" id="zi" title="Acercar">+</button><button class="btn quiet" id="zo" title="Alejar">−</button><button class="btn quiet" id="fit">Ajustar</button></div>
    <div class="map-legend"><span><i></i>import resuelto (estática)</span><span><i class="inf"></i>llamada HTTP entre apps</span></div></div>
  <div id="sel" class="small" style="margin-top:12px"></div>`;
  const $ = (s) => el.querySelector(s);
  const ctl = mountGraph($('#mw'), {
    nodes: list, edges: gEdges,
    onSelect: (n, ev, dbl) => {
      if (n.isFile) { openDrawer('archivo', n.id); return; }
      $('#sel').innerHTML = `<b>${esc(n.id)}</b> · ${esc(n.sub)} — <a href="#/mapa?grupo=${encodeURIComponent(n.id)}&nivel=2&paq=${esc(paq)}">entrar</a> · <a href="#/cobertura?q=${encodeURIComponent(n.id.replace('(raíz)', ''))}">ver cobertura</a>`;
      if (dbl && nivel === 2 && n.id.includes('/')) { setParams({ grupo: n.id }); renderModulos(el, new URLSearchParams(location.hash.split('?')[1] ?? ''), { setParams }); }
    },
  });
  $('#zi').onclick = () => ctl.zoom(1.3); $('#zo').onclick = () => ctl.zoom(1 / 1.3); $('#fit').onclick = () => ctl.fit();
  const re = () => renderModulos(el, new URLSearchParams(location.hash.split('?')[1] ?? ''), { setParams });
  $('#nv').onchange = (e) => { setParams({ nivel: e.target.value, grupo: '' }); re(); };
  $('#pq').onchange = (e) => { setParams({ paq: e.target.value }); re(); };
  $('#mn').onchange = (e) => { setParams({ min: e.target.value }); re(); };
  if ($('#up')) $('#up').onclick = () => { setParams({ grupo: '' }); re(); };
  $('#goto').addEventListener('keydown', async (ev) => {
    if (ev.key !== 'Enter') return;
    const r = await A(`/api/buscar?q=${encodeURIComponent(ev.target.value)}&n=1`);
    if (r.simbolos[0]) { location.hash = `#/mapa?foco=${encodeURIComponent(r.simbolos[0].id)}`; }
  });
}

async function renderFoco(el, params, foco, { setParams }) {
  const dir = params.get('dir') ?? 'both';
  const prof = Number(params.get('prof') ?? 1);
  const r = await A(`/api/vecindad?id=${encodeURIComponent(foco)}&dir=${dir}&prof=${prof}`);
  const center = r.nodos.find((n) => n.id === foco);
  if (!center) { el.innerHTML = `<div class="page-head"><h1>Mapa</h1></div><p class="note warn">El símbolo ya no existe en la instantánea actual.</p>`; return; }
  const isTest = (f) => /__tests__|\.test\.|\/test\//.test(f ?? '');
  const colOfNode = (n) => (n.lado === 'centro' ? 0 : n.lado === 'in' ? -n.nivel : n.nivel);
  const nodes = r.nodos.map((n) => ({
    id: n.id, label: n.ruta ?? n.nombre, sub: `${n.tipo} · ${short(n.archivo, 2)}`, col: colOfNode(n), grupo: n.archivo,
    color: n.id === foco ? '#E5B242' : (PKG_COLOR[n.paq] ?? '#9DAAC4'), title: `${n.id}\n${n.tipo}`, w: 220, h: 40,
  }));
  layoutColumns(nodes, { colW: 300, rowH: 58, nodeW: 220 });
  const edges = r.aristas.map((e) => ({ a: e.de, b: e.a, w: 1, estilo: isTest(e.de) ? 'tst' : e.conf === 'i' ? 'inf' : 'est', label: `${e.tipo}${e.via ? ' · ' + e.via : ''}${e.conf === 'i' ? ' (inferida)' : ''}` }));
  el.innerHTML = `
  <div class="page-head"><h1>Conexiones de <code>${esc(center.ruta ?? center.nombre)}</code></h1><p class="lede">Izquierda: quién lo usa. Derecha: de qué depende. ${loc(center.archivo, center.linea)}</p></div>
  <div class="filters">
    <label>Dirección <select id="dr"><option value="both" ${dir === 'both' ? 'selected' : ''}>ambas</option><option value="in" ${dir === 'in' ? 'selected' : ''}>quién lo usa</option><option value="out" ${dir === 'out' ? 'selected' : ''}>de qué depende</option></select></label>
    <label>Profundidad <select id="pf">${[1, 2, 3].map((n) => `<option ${prof === n ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
    <button class="btn quiet" id="back">← mapa de módulos</button>
    <button class="btn quiet" id="det">Abrir detalle</button>
    <span class="small muted2">${nodes.length} nodos${nodes.length >= 90 ? ' (recortado: baja la profundidad)' : ''} · ${edges.length} conexiones</span>
  </div>
  <div class="map-wrap"><div id="mw" class="map-canvas"></div><div class="map-tools"><button class="btn quiet" id="zi">+</button><button class="btn quiet" id="zo">−</button><button class="btn quiet" id="fit">Ajustar</button></div>
    <div class="map-legend"><span><i></i>estática (tipos)</span><span><i class="inf"></i>inferida (convención)</span><span><i class="tst"></i>desde una prueba</span><span><i class="unk"></i>sin confirmar</span></div></div>
  <p class="small muted2" style="margin-top:10px">Clic: abrir detalle · doble clic: centrar el mapa en ese símbolo. Una arista «estática» prueba que el código la contiene, no que se ejecute.</p>`;
  const $ = (s) => el.querySelector(s);
  const ctl = mountGraph($('#mw'), {
    nodes, edges, selected: foco,
    onSelect: (n, ev, dbl) => { if (dbl) { location.hash = `#/mapa?foco=${encodeURIComponent(n.id)}&dir=${dir}&prof=${prof}`; } else openDrawer('nodo', n.id); },
  });
  $('#zi').onclick = () => ctl.zoom(1.3); $('#zo').onclick = () => ctl.zoom(1 / 1.3); $('#fit').onclick = () => ctl.fit();
  $('#dr').onchange = (e) => { setParams({ dir: e.target.value }); renderFoco(el, new URLSearchParams(location.hash.split('?')[1] ?? ''), foco, { setParams }); };
  $('#pf').onchange = (e) => { setParams({ prof: e.target.value }); renderFoco(el, new URLSearchParams(location.hash.split('?')[1] ?? ''), foco, { setParams }); };
  $('#back').onclick = () => { location.hash = '#/mapa'; };
  $('#det').onclick = () => openDrawer('nodo', foco);
}
