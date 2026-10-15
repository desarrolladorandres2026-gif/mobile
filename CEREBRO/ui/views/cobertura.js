// Registro de cobertura: inventario completo, líneas indexadas, líneas auditadas y rangos pendientes.
import { esc, D, fmt, pct, chips, pager, loc, debounce } from '../lib.js';

const fmtRanges = (r) => (r ?? []).slice(0, 4).map(([a, b]) => (a === b ? a : `${a}–${b}`)).join(', ') + ((r ?? []).length > 4 ? ` … (+${r.length - 4})` : '');

export default async function render(el, params, { setParams }) {
  const [cob, inv] = await Promise.all([D('cobertura'), D('inventario')]);
  const f = { paq: params.get('paq') ?? '', clase: params.get('clase') ?? '', est: params.get('est') ?? '', q: params.get('q') ?? '' };
  const r = cob.resumen;
  const all = cob.archivos;
  const paquetes = [...new Set(all.map((a) => a.paquete))];
  const clases = [...new Set(all.map((a) => a.clase))];
  el.innerHTML = `
  <div class="page-head"><h1>Cobertura del análisis</h1><p class="lede">Registro de qué se inventarió, qué analizó una herramienta automática y qué se auditó leyendo el código. Cada archivo excluido aparece aquí con su motivo: nada se omite en silencio.</p></div>
  <div class="kpis">
    <div class="kpi gold"><b>${fmt(r.total.archivos)}</b><span>archivos inventariados</span></div>
    <div class="kpi"><b>${fmt(r.total.lineas)}</b><span>líneas en total</span></div>
    <div class="kpi ok"><b>${pct(r.total.indexadasLineas, r.total.lineasAnalizables)}</b><span>indexado automáticamente (${fmt(r.total.indexadasLineas)} de ${fmt(r.total.lineasAnalizables)})</span></div>
    <div class="kpi ${r.total.auditadasLineas ? 'gold' : 'warn'}"><b>${pct(r.total.auditadasLineas, r.total.lineasAnalizables)}</b><span>auditado por lectura (${fmt(r.total.auditadasLineas)} líneas · ${fmt(r.total.auditadosArchivos)} archivos)</span></div>
    <div class="kpi"><b>${fmt(r.total.excluidos)}</b><span>excluidos (${fmt(r.total.lineasExcluidas)} líneas)</span></div>
    <div class="kpi ${r.total.sinHechos ? 'bad' : 'ok'}"><b>${fmt(r.total.sinHechos)}</b><span>analizables sin hechos</span></div>
  </div>
  <div class="section"><h2>Exclusiones del análisis</h2><ul class="plain">${inv.exclusiones.directorios.map((d) => `<li><code>${esc(d.patron)}</code> <span class="muted2">${esc(d.motivo)}</span></li>`).join('')}${inv.exclusiones.generado.map((d) => `<li><code>${esc(d.patron)}</code> <span class="muted2">${esc(d.motivo)}</span></li>`).join('')}<li><span class="muted2">Binarios y recursos (imágenes, fuentes, documentos), lockfiles y Markdown se inventarían con su motivo pero no se analizan como código.</span></li></ul>
    ${inv.excluidos.length ? `<p class="small muted2">Directorios excluidos presentes en disco: ${inv.excluidos.map((e) => `<code>${esc(e.ruta)}</code>`).join(' ')}</p>` : ''}</div>
  <div class="section"><h2>Por archivo</h2>
  <div id="cP"></div><div id="cK"></div><div id="cE"></div>
  <div class="filters"><label>Buscar <input id="q" type="search" value="${esc(f.q)}" placeholder="ruta…" style="width:280px"></label><span id="cnt" class="small muted2"></span></div>
  <div id="tbl"></div></div>`;
  const $ = (s) => el.querySelector(s);
  const draw = () => {
    $('#cP').innerHTML = chips([{ v: '', t: 'Todos los paquetes' }, ...paquetes.map((p) => ({ v: p, t: p, n: all.filter((a) => a.paquete === p).length }))], f.paq, 'paq');
    $('#cK').innerHTML = chips([{ v: '', t: 'Toda clase' }, ...clases.map((c) => ({ v: c, t: c, n: all.filter((a) => a.clase === c).length }))], f.clase, 'clase');
    $('#cE').innerHTML = chips([{ v: '', t: 'Todo nivel' }, { v: 'sinaudit', t: 'Sin auditar', n: all.filter((a) => a.nivel !== 'excluido' && !a.auditado?.lineas && a.lineas).length }, { v: 'audit', t: 'Con lectura', n: all.filter((a) => a.auditado?.lineas).length }, { v: 'revisar', t: 'Lectura obsoleta (cambió)', n: all.filter((a) => a.auditado?.pendienteDeRevision?.length).length }, { v: 'excluido', t: 'Excluidos', n: all.filter((a) => a.nivel === 'excluido').length }, { v: 'lim', t: 'Con limitaciones', n: all.filter((a) => a.limitaciones.length).length }], f.est, 'est');
    const q = f.q.toLowerCase();
    const rows = all.filter((a) => (!f.paq || a.paquete === f.paq) && (!f.clase || a.clase === f.clase) && (!q || a.ruta.toLowerCase().includes(q))
      && (!f.est || (f.est === 'sinaudit' ? a.nivel !== 'excluido' && !a.auditado?.lineas && a.lineas : f.est === 'audit' ? a.auditado?.lineas : f.est === 'revisar' ? a.auditado?.pendienteDeRevision?.length : f.est === 'excluido' ? a.nivel === 'excluido' : a.limitaciones.length)))
      .sort((a, b) => b.lineas - a.lineas);
    $('#cnt').textContent = `${fmt(rows.length)} de ${fmt(all.length)}`;
    pager($('#tbl'), rows, (a) => `<tr class="row" data-open="archivo" data-id="${esc(a.ruta)}"><td class="clip mono small">${esc(a.ruta)}</td><td class="small">${esc(a.clase)}</td><td class="num">${fmt(a.lineas)}</td><td class="small">${a.nivel === 'excluido' ? `<span class="tag dot3">excluido</span> <span class="muted2">${esc((a.motivoExclusion ?? '').slice(0, 60))}</span>` : a.indexado ? `${pct(a.indexado.lineas, a.lineas)} <span class="muted2">${esc(a.indexado.metodo)}</span>` : '<span class="tag bad">sin hechos</span>'}</td><td class="small">${a.auditado?.lineas ? `<span class="tag ok">${pct(a.auditado.lineas, a.lineas)}</span> <span class="muted2">${esc(fmtRanges(a.auditado.rangos))}</span>` : a.auditado?.pendienteDeRevision?.length ? '<span class="tag warn">revisar: cambió</span>' : '<span class="muted2">—</span>'}</td><td class="small muted2 clip">${esc(a.limitaciones[0] ?? '')}</td></tr>`, {
      header: '<thead><tr><th>Archivo</th><th>Clase</th><th class="num">Líneas</th><th>Indexado</th><th>Auditado (rangos)</th><th>Limitación</th></tr></thead>',
    });
  };
  el.addEventListener('click', (ev) => { const c = ev.target.closest('[data-chips] .chip'); if (c) { const k = c.parentElement.dataset.chips; f[k] = c.dataset.v; setParams({ [k]: f[k] }); draw(); } });
  $('#q').addEventListener('input', debounce((e) => { f.q = e.target.value; setParams({ q: f.q }); draw(); }, 180));
  draw();
}
