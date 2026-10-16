// Carcasa de CEREBRO: navegación por hash, panel de detalle, paleta de búsqueda y actualización en vivo.
import { esc, A, D, clearCache, state, ago, fmt, toast, debounce, loc, short } from './lib.js';
import { openDrawer, closeDrawer, drawerBack, loadCode, loadImpact } from './drawers.js';

const VIEWS = {
  resumen: { t: 'Resumen', g: 'Panorama', m: () => import('./views/resumen.js') },
  mapa: { t: 'Mapa', g: 'Panorama', m: () => import('./views/mapa.js') },
  acciones: { t: 'Botones y acciones', g: 'Trazabilidad', m: () => import('./views/acciones.js'), n: (m) => m.conteos.acciones },
  endpoints: { t: 'Endpoints', g: 'Trazabilidad', m: () => import('./views/endpoints.js'), n: (m) => m.conteos.endpoints },
  modelos: { t: 'Modelos de datos', g: 'Trazabilidad', m: () => import('./views/modelos.js'), n: (m) => m.conteos.modelos },
  conexiones: { t: 'Eventos e integraciones', g: 'Trazabilidad', m: () => import('./views/conexiones.js'), n: (m) => m.conteos.eventos },
  finanzas: { t: 'Finanzas', g: 'Negocio', m: () => import('./views/finanzas.js') },
  pedidos: { t: 'Pedidos y estados', g: 'Negocio', m: () => import('./views/pedidos.js') },
  roles: { t: 'Roles y permisos', g: 'Negocio', m: () => import('./views/roles.js') },
  hallazgos: { t: 'Hallazgos', g: 'Calidad', m: () => import('./views/hallazgos.js'), n: (m) => m.conteos.hallazgos },
  cobertura: { t: 'Cobertura', g: 'Calidad', m: () => import('./views/cobertura.js') },
  cambios: { t: 'Cambios', g: 'Calidad', m: () => import('./views/cambios.js') },
  sistema: { t: 'Sistema y vigilante', g: 'Calidad', m: () => import('./views/sistema.js') },
};

const $ = (s) => document.querySelector(s);
let currentView = null;

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, qs] = raw.split('?');
  return { vista: path || 'resumen', params: new URLSearchParams(qs ?? '') };
}
export function go(vista, params = {}) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') p.set(k, v);
  location.hash = `#/${vista}${p.toString() ? '?' + p.toString() : ''}`;
}
export function setParams(patch) {
  const { vista, params } = parseHash();
  for (const [k, v] of Object.entries(patch)) { if (v == null || v === '') params.delete(k); else params.set(k, v); }
  history.replaceState(null, '', `#/${vista}${params.toString() ? '?' + params.toString() : ''}`);
}

function renderNav() {
  const meta = state.meta;
  const { vista } = parseHash();
  let html = '';
  let g = '';
  for (const [k, v] of Object.entries(VIEWS)) {
    if (v.g !== g) { g = v.g; html += `<div class="nav-group">${esc(g)}</div>`; }
    const n = meta && v.n ? v.n(meta) : null;
    html += `<a class="nav-item ${k === vista ? 'active' : ''}" href="#/${k}"><span>${esc(v.t)}</span>${n != null ? `<span class="nav-count">${fmt(n)}</span>` : ''}</a>`;
  }
  $('#nav').innerHTML = html;
}

function renderRailStatus() {
  const e = state.estado;
  const st = e?.estadoVigilante;
  let dot = 'off';
  let txt = 'Vigilante detenido';
  if (e?.vigilante === 'activo') {
    if (st?.fase === 'analizando') { dot = 'work'; txt = `Actualizando (${st.pendientes ?? 0} archivos)…`; }
    else { dot = 'on'; txt = 'Vigilante activo'; }
  }
  const fr = state.frescura;
  $('#railStatus').innerHTML = `<div><span class="dot ${dot}"></span>${esc(txt)}</div>
    <div class="muted2">Datos de ${esc(ago(state.meta?.generadoEn))}</div>
    <div class="muted2">${esc(state.meta?.git?.branch ?? '')}${state.meta?.git?.archivosConCambiosSinCommit != null ? ` · ${state.meta.git.archivosConCambiosSinCommit} sin commit` : ''}</div>`;
  const f = $('#freshness');
  if (fr && fr.total > 0 && e?.vigilante !== 'activo') { f.className = 'fresh stale'; f.textContent = `${fr.total} archivo(s) cambiaron y no están analizados`; }
  else if (fr && fr.total > 0) { f.className = 'fresh stale'; f.textContent = `Analizando ${fr.total} cambio(s)…`; }
  else { f.className = 'fresh'; f.textContent = `Al día · ${ago(state.meta?.generadoEn)}`; }
}

async function loadState() {
  const [estado, frescura] = await Promise.all([A('/api/estado'), A('/api/frescura').catch(() => null)]);
  state.estado = estado;
  state.meta = estado.meta;
  state.frescura = frescura;
  state.raiz = estado.raiz ?? state.raiz;
}

async function show() {
  const { vista, params } = parseHash();
  const v = VIEWS[vista] ?? VIEWS.resumen;
  renderNav();
  const el = $('#view');
  document.title = `${v.t} · CEREBRO`;
  if (!state.meta) {
    el.innerHTML = `<div class="page-head"><h1>Sin datos todavía</h1></div><p class="lede">No hay ninguna instantánea. Ejecuta <code>node CEREBRO/scripts/cerebro.mjs construir</code> (unos minutos la primera vez) y recarga.</p>`;
    return;
  }
  el.innerHTML = '<p class="empty">Cargando…</p>';
  try {
    const mod = await v.m();
    currentView = { vista, mod };
    await mod.default(el, params, { go, setParams });
  } catch (e) {
    console.error(e);
    el.innerHTML = `<div class="note bad"><b>No se pudo mostrar esta vista.</b><br>${esc(e.message)}</div>`;
  }
  const d = params.get('d');
  if (d && $('#drawer').hidden) {
    const i = d.indexOf(':');
    openDrawer(d.slice(0, i), d.slice(i + 1), { push: false, silent: true });
  }
}

// — Paleta de búsqueda —
const palette = $('#palette');
const pInput = $('#paletteInput');
const pRes = $('#paletteResults');
let pItems = [];
let pSel = 0;
function openPalette() { palette.hidden = false; pInput.value = ''; pRes.innerHTML = '<p class="empty" style="padding-left:18px">Escribe al menos 2 letras. Ejemplos: «cancelOrder», «refund», «POST /orders», «Pagar», «Payout».</p>'; pInput.focus(); }
function closePalette() { palette.hidden = true; }
const search = debounce(async () => {
  const q = pInput.value.trim();
  if (q.length < 2) return;
  try {
    const r = await A(`/api/buscar?q=${encodeURIComponent(q)}&n=30`);
    pItems = [
      ...r.otros.map((o) => ({ k: o.clase, id: o.id, t: o.titulo, s: o.sub, tipo: o.clase === 'accion' ? 'accion' : o.clase === 'endpoint' ? 'endpoint' : o.clase === 'archivo' ? 'archivo' : 'nodo', estado: o.estado })),
      ...r.simbolos.map((s) => ({ k: s.tipo, id: s.id, t: s.ruta ?? s.nombre, s: `${s.paq} · ${short(s.archivo, 2)}:${s.linea}`, tipo: 'nodo' })),
    ];
    pSel = 0;
    pRes.innerHTML = pItems.length ? pItems.map((it, i) => `<div class="pr ${i === 0 ? 'sel' : ''}" data-i="${i}"><span class="k">${esc(it.k)}</span><span class="t">${esc(it.t)}</span><span class="s">${esc(it.s ?? '')}</span></div>`).join('') : '<p class="empty" style="padding-left:18px">Sin resultados.</p>';
  } catch (e) { pRes.innerHTML = `<p class="note bad" style="margin:12px 18px">${esc(e.message)}</p>`; }
}, 140);
pInput.addEventListener('input', search);
pInput.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') closePalette();
  else if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
    ev.preventDefault();
    pSel = Math.max(0, Math.min(pItems.length - 1, pSel + (ev.key === 'ArrowDown' ? 1 : -1)));
    [...pRes.children].forEach((c, i) => c.classList.toggle('sel', i === pSel));
    pRes.children[pSel]?.scrollIntoView({ block: 'nearest' });
  } else if (ev.key === 'Enter' && pItems[pSel]) { choose(pItems[pSel]); }
});
pRes.addEventListener('click', (ev) => { const r = ev.target.closest('.pr'); if (r) choose(pItems[Number(r.dataset.i)]); });
palette.addEventListener('click', (ev) => { if (ev.target === palette) closePalette(); });
function choose(it) { closePalette(); openDrawer(it.tipo, it.id); }
$('#searchBtn').addEventListener('click', openPalette);

document.addEventListener('keydown', (ev) => {
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'k') { ev.preventDefault(); openPalette(); }
  else if (ev.key === 'Escape' && !palette.hidden) closePalette();
  else if (ev.key === 'Escape' && !$('#drawer').hidden && !/INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName ?? '')) closeDrawer();
});

// — Delegación global de acciones —
document.addEventListener('click', (ev) => {
  const t = ev.target;
  const open = t.closest('[data-open]');
  if (open) { ev.preventDefault(); openDrawer(open.dataset.open, open.dataset.id); return; }
  if (t.closest('[data-close]')) { closeDrawer(); return; }
  if (t.closest('[data-back]')) { drawerBack(); return; }
  const gob = t.closest('[data-go]');
  if (gob) { const p = {}; if (gob.dataset.focus) p.foco = gob.dataset.focus; if (gob.dataset.dir) p.dir = gob.dataset.dir; if (gob.dataset.prof) p.prof = gob.dataset.prof; go(gob.dataset.go, p); return; }
  const code = t.closest('[data-code]');
  if (code) {
    const host = code.closest('.drawer-body, .section, section') ?? document;
    let slot = host.querySelector('#dz-extra') ?? document.getElementById('dz-extra');
    if (slot) loadCode(slot, code.dataset.code, Number(code.dataset.l1 ?? 1), Number(code.dataset.l2 ?? 60), code.dataset.hl);
    return;
  }
  const imp = t.closest('[data-impact]');
  if (imp) { const slot = document.getElementById('dz-extra'); if (slot) loadImpact(slot, imp.dataset.impact); }
});

$('#rebuildBtn').addEventListener('click', async () => {
  const b = $('#rebuildBtn');
  b.disabled = true;
  try {
    await fetch('/api/reconstruir?modo=incremental', { method: 'POST', headers: { 'X-Cerebro': '1' } });
    toast('Actualización solicitada…');
  } catch (e) { toast('No se pudo solicitar: ' + e.message); }
  setTimeout(() => { b.disabled = false; }, 2500);
});

// — Tiempo real —
function connectEvents() {
  const es = new EventSource('/api/eventos');
  es.onmessage = async (m) => {
    const ev = JSON.parse(m.data);
    if (ev.tipo === 'instantanea') {
      clearCache();
      await loadState();
      renderRailStatus();
      toast('Datos actualizados');
      show();
    } else if (ev.tipo === 'estado') {
      await loadState().catch(() => {});
      renderRailStatus();
    }
  };
  es.onerror = () => { /* reintenta solo */ };
}

window.addEventListener('hashchange', () => { show(); });
if (!location.search.includes("estatico")) setInterval(() => { loadState().then(renderRailStatus).catch(() => {}); }, 15000);

(async function init() {
  try { await loadState(); } catch (e) { console.error(e); }
  renderRailStatus();
  await show();
  if (!location.search.includes("estatico")) connectEvents();
})();
