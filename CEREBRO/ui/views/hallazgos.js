// Registro de hallazgos: errores confirmados, riesgos probables e hipótesis, cada uno con evidencia localizable.
import { esc, D, fmt, chips, pager, sevTag, confianzaTag, loc, debounce } from '../lib.js';
import { openDrawer } from '../drawers.js';

const SEV = ['CRITICO', 'ALTO', 'MEDIO', 'BAJO'];

export default async function render(el, params, { setParams }) {
  const all = await D('hallazgos');
  const f = { sev: params.get('sev') ?? '', conf: params.get('conf') ?? '', area: params.get('area') ?? '', regla: params.get('regla') ?? '', origen: params.get('origen') ?? '', q: params.get('q') ?? '' };
  const cnt = (fn) => { const m = new Map(); for (const h of all) { const k = fn(h); if (k != null) m.set(k, (m.get(k) ?? 0) + 1); } return m; };
  const bySev = cnt((h) => h.severidad);
  const byConf = cnt((h) => h.confianza);
  const byArea = cnt((h) => h.area ?? 'calidad');
  const byRegla = cnt((h) => h.regla ?? 'manual');
  el.innerHTML = `
  <div class="page-head"><h1>Hallazgos</h1><p class="lede">Lo que está mal, lo que falta y lo que puede romperse. <b>Confirmado</b> = demostrado por el código; <b>probable</b> = el patrón apunta al problema pero falta un dato; <b>hipótesis</b> = hay que comprobarlo antes de actuar. Ninguno de estos hallazgos se ha corregido: la auditoría no modifica el código de producción.</p></div>
  <div id="cS"></div><div id="cC"></div><div id="cA"></div>
  <div class="filters"><label>Regla <select id="fR"><option value="">todas</option>${[...byRegla.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `<option value="${esc(k)}" ${f.regla === k ? 'selected' : ''}>${esc(k)} (${n})</option>`).join('')}</select></label>
  <label>Origen <select id="fO"><option value="">todos</option><option value="manual" ${f.origen === 'manual' ? 'selected' : ''}>auditoría manual</option><option value="auto" ${f.origen === 'auto' ? 'selected' : ''}>reglas automáticas</option></select></label>
  <label>Buscar <input id="q" type="search" value="${esc(f.q)}" placeholder="texto, archivo…" style="width:260px"></label><span id="cnt" class="small muted2"></span></div>
  <div id="tbl"></div>`;
  const $ = (s) => el.querySelector(s);
  const draw = () => {
    $('#cS').innerHTML = chips([{ v: '', t: 'Toda gravedad', n: all.length }, ...SEV.filter((s) => bySev.has(s)).map((s) => ({ v: s, t: s, n: bySev.get(s) }))], f.sev, 'sev');
    $('#cC').innerHTML = chips([{ v: '', t: 'Toda confianza' }, ...['confirmado', 'probable', 'hipotesis'].filter((s) => byConf.has(s)).map((s) => ({ v: s, t: s, n: byConf.get(s) }))], f.conf, 'conf');
    $('#cA').innerHTML = chips([{ v: '', t: 'Todas las áreas' }, ...[...byArea.entries()].map(([k, n]) => ({ v: k, t: k, n }))], f.area, 'area');
    const q = f.q.toLowerCase();
    const rows = all.filter((h) => (!f.sev || h.severidad === f.sev) && (!f.conf || h.confianza === f.conf) && (!f.area || (h.area ?? 'calidad') === f.area) && (!f.regla || (h.regla ?? 'manual') === f.regla) && (!f.origen || h.origen === f.origen)
      && (!q || `${h.titulo} ${h.descripcion ?? ''} ${(h.evidencia ?? []).map((e) => e.archivo).join(' ')}`.toLowerCase().includes(q)))
      .sort((a, b) => SEV.indexOf(a.severidad) - SEV.indexOf(b.severidad) || (a.origen === 'manual' ? -1 : 1) - (b.origen === 'manual' ? -1 : 1));
    $('#cnt').textContent = `${fmt(rows.length)} de ${fmt(all.length)}`;
    pager($('#tbl'), rows, (h) => `<tr class="row" data-open="hallazgo" data-id="${esc(h.id)}"><td>${sevTag(h.severidad)}</td><td>${confianzaTag(h.confianza)}</td><td><b>${esc(h.titulo)}</b>${h.estado && h.estado !== 'abierto' ? ` <span class="tag warn">${esc(h.estado)}</span>` : ''}</td><td class="small">${esc(h.area ?? '')}</td><td class="small">${h.origen === 'manual' ? '<span class="tag gold">auditoría</span>' : '<span class="tag">auto</span>'}</td><td class="small">${h.evidencia?.[0] ? loc(h.evidencia[0].archivo, h.evidencia[0].linea, (h.evidencia[0].archivo.split('/').pop()) + ':' + (h.evidencia[0].linea ?? '')) : ''}</td></tr>`, {
      header: '<thead><tr><th>Gravedad</th><th>Confianza</th><th>Hallazgo</th><th>Área</th><th>Origen</th><th>Evidencia</th></tr></thead>',
    });
  };
  el.addEventListener('click', (ev) => { const c = ev.target.closest('[data-chips] .chip'); if (c) { const k = c.parentElement.dataset.chips; f[k] = c.dataset.v; setParams({ [k]: f[k] }); draw(); } });
  $('#fR').addEventListener('change', (e) => { f.regla = e.target.value; setParams({ regla: f.regla }); draw(); });
  $('#fO').addEventListener('change', (e) => { f.origen = e.target.value; setParams({ origen: f.origen }); draw(); });
  $('#q').addEventListener('input', debounce((e) => { f.q = e.target.value; setParams({ q: f.q }); draw(); }, 180));
  draw();
  if (params.get('sel')) openDrawer('hallazgo', params.get('sel'), { silent: true });
}
