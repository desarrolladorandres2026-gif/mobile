// Utilidades de interfaz compartidas por todas las vistas.
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const state = { raiz: '', meta: null, estado: null, frescura: null };

const cache = new Map();
export async function D(name) {
  if (cache.has(name)) return cache.get(name);
  const p = fetch(`/api/datos/${name}`).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${name}: ${r.status}`))));
  cache.set(name, p);
  try { return await p; } catch (e) { cache.delete(name); throw e; }
}
export const clearCache = () => cache.clear();
export async function A(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
}

/** Enlace que abre el archivo y la línea en VS Code. */
export function editorHref(archivo, linea) {
  const base = state.raiz.replace(/\\/g, '/').replace(/\/$/, '');
  return `vscode://file/${encodeURI(`${base}/${archivo}`)}${linea ? `:${linea}` : ''}`;
}
export function loc(archivo, linea, texto) {
  if (!archivo) return '';
  const t = texto ?? `${archivo}${linea ? `:${linea}` : ''}`;
  return `<a class="loc" href="${esc(editorHref(archivo, linea))}" title="Abrir en el editor">${esc(t)}</a>`;
}
export const short = (p, n = 2) => String(p ?? '').split('/').slice(-n).join('/');

export function symLink(id, label) {
  if (!id) return '';
  const [f, rest] = String(id).split('#');
  const text = label ?? (rest ? rest.replace(/<module>/, '‹módulo›') : short(f));
  return `<span class="sym" data-open="nodo" data-id="${esc(id)}" title="${esc(id)}">${esc(text)}</span>`;
}

export const ESTADO_LABEL = {
  verificada: 'Funcional y verificada', parcial: 'Parcialmente funcional', desconectada: 'Desconectada', sin_implementar: 'Sin implementar',
  con_errores: 'Con errores', pendiente: 'Pendiente de verificación', no_aplica: 'Entrada de datos',
};
export const ESTADO_CLASE = { verificada: 'ok', parcial: 'warn', desconectada: 'bad', sin_implementar: 'bad', con_errores: 'bad', pendiente: 'info', no_aplica: '' };
export const estadoTag = (e) => `<span class="tag ${ESTADO_CLASE[e] ?? ''}">${esc(ESTADO_LABEL[e] ?? e)}</span>`;

export const CONF_LABEL = { estatica: 'estática', inferida: 'inferida', probada: 'probada', sin: 'sin confirmar', e: 'estática', i: 'inferida' };
export function confTag(c) {
  const k = c === 'e' ? 'estatica' : c === 'i' ? 'inferida' : c;
  const cls = k === 'estatica' ? 'gold' : k === 'inferida' ? 'info dash' : k === 'probada' ? 'ok' : 'dot3';
  return `<span class="tag ${cls}" title="${k === 'estatica' ? 'Resuelta por el verificador de tipos' : k === 'inferida' ? 'Inferida por convención; no demostrada por tipos' : k === 'probada' ? 'Ejercitada por una prueba que pasó' : 'No se pudo confirmar'}">${esc(CONF_LABEL[k] ?? k)}</span>`;
}
export const sevTag = (s) => `<span class="sev-${esc(s)}">${esc(s)}</span>`;
export const confianzaTag = (c) => `<span class="tag ${c === 'confirmado' ? 'bad' : c === 'probable' ? 'warn' : 'dot3'}">${esc(c)}</span>`;

export function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('es-CO', { dateStyle: 'medium', timeStyle: 'short' });
}
export function ago(iso) {
  if (!iso) return '—';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'hace un momento';
  if (s < 3600) return `hace ${Math.round(s / 60)} min`;
  if (s < 86400) return `hace ${Math.round(s / 3600)} h`;
  return `hace ${Math.round(s / 86400)} d`;
}
export const fmt = (n) => (n == null ? '—' : Number(n).toLocaleString('es-CO'));
export const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(a === b ? 0 : 1)}%` : '—');

export function chips(items, selected, attr) {
  return `<div class="chips" data-chips="${attr}">${items.map((i) => `<button type="button" class="chip ${selected === i.v ? 'on' : ''}" data-v="${esc(i.v)}">${esc(i.t)}${i.n != null ? `<small>${fmt(i.n)}</small>` : ''}</button>`).join('')}</div>`;
}

export function bar(parts) {
  const total = parts.reduce((a, p) => a + p.n, 0) || 1;
  return `<div class="bar" role="img">${parts.map((p) => `<i style="width:${(p.n / total) * 100}%;background:${p.c}" title="${esc(p.t)}: ${fmt(p.n)}"></i>`).join('')}</div>
  <div class="legend">${parts.map((p) => `<span><i style="background:${p.c}"></i>${esc(p.t)} · ${fmt(p.n)}</span>`).join('')}</div>`;
}

export function toast(msg, ms = 3200) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, ms);
}

/** Pagina una lista renderizando de a `step` filas. */
export function pager(el, rows, renderRow, { step = 200, header = '', empty = 'Sin resultados.' } = {}) {
  let shown = 0;
  const draw = () => {
    const slice = rows.slice(0, shown + step);
    shown = slice.length;
    el.innerHTML = rows.length
      ? `<div class="twrap"><table>${header}<tbody>${slice.map(renderRow).join('')}</tbody></table></div>${rows.length > shown ? `<p><button class="btn quiet" data-more>Mostrar más (${fmt(rows.length - shown)} restantes)</button></p>` : ''}`
      : `<p class="empty">${esc(empty)}</p>`;
    el.querySelector('[data-more]')?.addEventListener('click', draw);
  };
  draw();
}

export function debounce(fn, ms = 160) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

/** Bloque de código con líneas resaltadas. */
export function codeBlock(slice, resaltar) {
  const hl = new Set(resaltar ?? []);
  return `<pre class="code">${slice.lineas.map((l, i) => { const n = slice.desde + i; return `<div class="${hl.has(n) ? 'hl' : ''}"><i>${n}</i><span>${esc(l)}</span></div>`; }).join('')}</pre>`;
}
