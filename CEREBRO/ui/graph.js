// Visor de grafos en SVG: pan, zoom, resaltado de vecinos, aristas con estilo según certeza.
import { esc } from './lib.js';

const NS = 'http://www.w3.org/2000/svg';

/**
 * nodes: [{id, label, sub, x, y, w, h, color, kind}]
 * edges: [{a, b, w, estilo:'est'|'inf'|'tst'|'unk', label}]
 */
export function mountGraph(container, { nodes, edges, onSelect, selected = null, fit = true }) {
  container.innerHTML = '';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('role', 'img');
  const defs = document.createElementNS(NS, 'defs');
  defs.innerHTML = `
    <marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#D69E26"/></marker>
    <marker id="arrI" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#7DB4FF"/></marker>
    <marker id="arrT" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#34D399"/></marker>
    <marker id="arrU" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#9DAAC4"/></marker>`;
  svg.appendChild(defs);
  const root = document.createElementNS(NS, 'g');
  svg.appendChild(root);
  const gE = document.createElementNS(NS, 'g');
  const gN = document.createElementNS(NS, 'g');
  root.append(gE, gN);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const MARK = { est: 'arr', inf: 'arrI', tst: 'arrT', unk: 'arrU' };

  const edgeEls = [];
  for (const e of edges) {
    const a = byId.get(e.a);
    const b = byId.get(e.b);
    if (!a || !b) continue;
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('class', `gedge ${e.estilo === 'inf' ? 'inf' : e.estilo === 'tst' ? 'tst' : e.estilo === 'unk' ? 'unk' : ''}`);
    p.setAttribute('marker-end', `url(#${MARK[e.estilo] ?? 'arr'})`);
    p.setAttribute('stroke-width', String(Math.min(5, 1 + Math.log2(1 + (e.w ?? 1)) * 0.6)));
    const title = document.createElementNS(NS, 'title');
    title.textContent = e.label ?? '';
    p.appendChild(title);
    gE.appendChild(p);
    edgeEls.push({ e, p, a, b });
  }
  const nodeEls = new Map();
  for (const n of nodes) {
    const g = document.createElementNS(NS, 'g');
    g.setAttribute('class', 'gnode' + (n.id === selected ? ' sel' : ''));
    g.dataset.id = n.id;
    const w = n.w ?? 170;
    const h = n.h ?? 36;
    n.w = w; n.h = h;
    const r = document.createElementNS(NS, 'rect');
    r.setAttribute('rx', '7'); r.setAttribute('width', w); r.setAttribute('height', h);
    if (n.color) r.setAttribute('style', `stroke:${n.color}`);
    const t = document.createElementNS(NS, 'text');
    t.setAttribute('x', 10); t.setAttribute('y', n.sub ? 15 : h / 2 + 4);
    t.textContent = clip(n.label, Math.floor((w - 16) / 6.6));
    g.append(r, t);
    if (n.sub) {
      const s = document.createElementNS(NS, 'text');
      s.setAttribute('class', 'sub'); s.setAttribute('x', 10); s.setAttribute('y', h - 8);
      s.textContent = clip(n.sub, Math.floor((w - 16) / 6.2));
      g.appendChild(s);
    }
    const tt = document.createElementNS(NS, 'title');
    tt.textContent = n.title ?? `${n.label}${n.sub ? ' · ' + n.sub : ''}`;
    g.appendChild(tt);
    gN.appendChild(g);
    nodeEls.set(n.id, g);
  }

  const place = () => {
    for (const n of nodes) nodeEls.get(n.id).setAttribute('transform', `translate(${n.x - n.w / 2},${n.y - n.h / 2})`);
    for (const { e, p, a, b } of edgeEls) {
      const horiz = Math.abs(b.x - a.x) >= Math.abs(b.y - a.y);
      let x1, y1, x2, y2;
      if (horiz) {
        const dir = b.x >= a.x ? 1 : -1;
        x1 = a.x + dir * a.w / 2; y1 = a.y; x2 = b.x - dir * b.w / 2; y2 = b.y;
        const mx = (x1 + x2) / 2;
        p.setAttribute('d', `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`);
      } else {
        const dir = b.y >= a.y ? 1 : -1;
        x1 = a.x; y1 = a.y + dir * a.h / 2; x2 = b.x; y2 = b.y - dir * b.h / 2;
        const my = (y1 + y2) / 2;
        p.setAttribute('d', `M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}`);
      }
    }
  };
  place();

  // — pan / zoom —
  const view = { x: 0, y: 0, k: 1 };
  const apply = () => root.setAttribute('transform', `translate(${view.x},${view.y}) scale(${view.k})`);
  const fitView = () => {
    if (!nodes.length) return;
    const xs = nodes.flatMap((n) => [n.x - n.w / 2, n.x + n.w / 2]);
    const ys = nodes.flatMap((n) => [n.y - n.h / 2, n.y + n.h / 2]);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const W = container.clientWidth || 900, H = container.clientHeight || 520;
    const k = Math.min(1.2, Math.min((W - 60) / Math.max(1, maxX - minX), (H - 60) / Math.max(1, maxY - minY)));
    view.k = k;
    view.x = (W - (maxX - minX) * k) / 2 - minX * k;
    view.y = (H - (maxY - minY) * k) / 2 - minY * k;
    apply();
  };
  container.appendChild(svg);
  if (fit) fitView(); else apply();
  svg.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const rect = svg.getBoundingClientRect();
    const px = ev.clientX - rect.left, py = ev.clientY - rect.top;
    const f = Math.exp(-ev.deltaY * 0.0016);
    const nk = Math.max(0.12, Math.min(4, view.k * f));
    view.x = px - (px - view.x) * (nk / view.k);
    view.y = py - (py - view.y) * (nk / view.k);
    view.k = nk;
    apply();
  }, { passive: false });
  let drag = null;
  svg.addEventListener('pointerdown', (ev) => {
    if (ev.target.closest('.gnode')) return;
    drag = { x: ev.clientX, y: ev.clientY, vx: view.x, vy: view.y };
    svg.setPointerCapture(ev.pointerId);
    svg.classList.add('dragging');
  });
  svg.addEventListener('pointermove', (ev) => {
    if (!drag) return;
    view.x = drag.vx + ev.clientX - drag.x;
    view.y = drag.vy + ev.clientY - drag.y;
    apply();
  });
  const end = () => { drag = null; svg.classList.remove('dragging'); };
  svg.addEventListener('pointerup', end);
  svg.addEventListener('pointercancel', end);

  // — resaltado de vecinos —
  const neigh = new Map();
  for (const { e } of edgeEls) {
    if (!neigh.has(e.a)) neigh.set(e.a, new Set());
    if (!neigh.has(e.b)) neigh.set(e.b, new Set());
    neigh.get(e.a).add(e.b); neigh.get(e.b).add(e.a);
  }
  const highlight = (id) => {
    const ns = id ? neigh.get(id) ?? new Set() : null;
    for (const [nid, g] of nodeEls) g.classList.toggle('dim', !!id && nid !== id && !ns.has(nid));
    for (const { e, p } of edgeEls) {
      const on = !!id && (e.a === id || e.b === id);
      p.classList.toggle('hi', on);
      p.classList.toggle('dim', !!id && !on);
    }
  };
  gN.addEventListener('pointerover', (ev) => { const g = ev.target.closest('.gnode'); if (g) highlight(g.dataset.id); });
  gN.addEventListener('pointerout', () => highlight(null));
  gN.addEventListener('click', (ev) => {
    const g = ev.target.closest('.gnode');
    if (!g) return;
    for (const x of nodeEls.values()) x.classList.remove('sel');
    g.classList.add('sel');
    onSelect?.(byId.get(g.dataset.id), ev);
  });
  gN.addEventListener('dblclick', (ev) => { const g = ev.target.closest('.gnode'); if (g) onSelect?.(byId.get(g.dataset.id), ev, true); });

  return {
    fit: fitView,
    zoom: (f) => { const W = container.clientWidth / 2, H = container.clientHeight / 2; const nk = Math.max(0.12, Math.min(4, view.k * f)); view.x = W - (W - view.x) * (nk / view.k); view.y = H - (H - view.y) * (nk / view.k); view.k = nk; apply(); },
    focus: (id) => { const n = byId.get(id); if (!n) return; const W = container.clientWidth, H = container.clientHeight; view.k = Math.max(view.k, 0.9); view.x = W / 2 - n.x * view.k; view.y = H / 2 - n.y * view.k; apply(); },
  };
}

function clip(s, n) {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, Math.max(1, n - 1)) + '…' : s;
}

/** Distribución en columnas por «nivel»: izquierda (consumidores) → centro → derecha (dependencias). */
export function layoutColumns(nodes, { colW = 230, rowH = 56, nodeW = 190 } = {}) {
  const cols = new Map();
  for (const n of nodes) {
    const c = n.col ?? 0;
    if (!cols.has(c)) cols.set(c, []);
    cols.get(c).push(n);
  }
  for (const [c, list] of cols) {
    list.sort((a, b) => String(a.grupo ?? '').localeCompare(String(b.grupo ?? '')) || String(a.label).localeCompare(String(b.label)));
    const H = (list.length - 1) * rowH;
    list.forEach((n, i) => { n.x = c * colW; n.y = i * rowH - H / 2; n.w = nodeW; });
  }
  return nodes;
}

/** Distribución por fuerzas con sesgo horizontal por columna (para el mapa de módulos). */
export function layoutForce(nodes, edges, { iterations = 380, width = 1400, height = 760 } = {}) {
  const idx = new Map(nodes.map((n, i) => [n.id, i]));
  const rnd = (() => { let s = 7; return () => ((s = (s * 16807) % 2147483647) / 2147483647); })();
  for (const n of nodes) {
    n.x = (n.col ?? 0) * (width / 4) + (rnd() - 0.5) * 60;
    n.y = (rnd() - 0.5) * height;
    n.vx = 0; n.vy = 0;
  }
  for (let it = 0; it < iterations; it++) {
    const cool = 1 - it / iterations;
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j];
        let dx = a.x - b.x, dy = a.y - b.y;
        const d2 = dx * dx + dy * dy + 0.01;
        const minD = (a.w + b.w) / 2 + 24;
        const f = (9000 / d2) * cool;
        const d = Math.sqrt(d2);
        dx /= d; dy /= d;
        a.vx += dx * f; a.vy += dy * f; b.vx -= dx * f; b.vy -= dy * f;
        // anti-solapamiento
        if (Math.abs(a.x - b.x) < minD && Math.abs(a.y - b.y) < (a.h + b.h) / 2 + 10) {
          const push = ((a.h + b.h) / 2 + 10 - Math.abs(a.y - b.y)) * 0.25;
          const s = a.y >= b.y ? 1 : -1;
          a.vy += push * s; b.vy -= push * s;
        }
      }
    }
    for (const e of edges) {
      const a = nodes[idx.get(e.a)], b = nodes[idx.get(e.b)];
      if (!a || !b) continue;
      const k = 0.012 * Math.min(4, 1 + Math.log2(1 + (e.w ?? 1)));
      a.vx += (b.x - a.x) * k; a.vy += (b.y - a.y) * k;
      b.vx += (a.x - b.x) * k; b.vy += (a.y - b.y) * k;
    }
    for (const n of nodes) {
      const target = (n.col ?? 0) * (width / 4);
      n.vx += (target - n.x) * 0.06;
      n.x += Math.max(-30, Math.min(30, n.vx)) * 0.6;
      n.y += Math.max(-30, Math.min(30, n.vy)) * 0.6;
      n.vx *= 0.6; n.vy *= 0.6;
    }
  }
  return nodes;
}

export const _esc = esc;
