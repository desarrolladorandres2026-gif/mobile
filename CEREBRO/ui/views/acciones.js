// Catálogo de botones y acciones con su estado y evidencia; cada fila abre el recorrido completo.
import { esc, D, fmt, chips, pager, estadoTag, loc, short, ESTADO_LABEL, debounce } from '../lib.js';
import { openDrawer } from '../drawers.js';

export default async function render(el, params, { setParams }) {
  const data = await D('acciones');
  const all = data.acciones;
  const f = {
    estado: params.get('estado') ?? '', paq: params.get('paq') ?? '', tipo: params.get('tipo') ?? '', nat: params.get('nat') ?? '', q: params.get('q') ?? '', pantalla: params.get('pantalla') ?? '',
  };
  const count = (key, fn) => { const m = new Map(); for (const a of all) for (const k of fn(a)) m.set(k, (m.get(k) ?? 0) + 1); return m; };
  const porEstado = count('estado', (a) => [a.estado]);
  const porPaq = count('paq', (a) => [a.paquete]);
  const porTipo = count('tipo', (a) => [a.tipo]);
  const porNat = count('nat', (a) => (a.naturaleza.length ? a.naturaleza : ['ninguna']));
  const ORDER = ['con_errores', 'desconectada', 'sin_implementar', 'parcial', 'pendiente', 'verificada', 'no_aplica'];

  el.innerHTML = `
  <div class="page-head"><h1>Botones y acciones</h1>
    <p class="lede">Cada control interactivo (botón, enlace, formulario, interruptor…) con su recorrido real. Que tenga un manejador no lo hace «funcional»: el estado sale de seguir la cadena hasta su efecto y de si una ejecución la ha demostrado.</p></div>
  <div id="fE"></div><div id="fP"></div><div id="fN"></div>
  <div class="filters"><label>Tipo <select id="fT"><option value="">todos</option>${[...porTipo.entries()].sort().map(([k, n]) => `<option value="${esc(k)}" ${f.tipo === k ? 'selected' : ''}>${esc(k)} (${n})</option>`).join('')}</select></label>
    <label>Buscar <input id="fQ" type="search" value="${esc(f.q)}" placeholder="texto, archivo, ruta de API…" style="width:260px"></label>
    ${f.pantalla ? `<span class="tag gold">pantalla: ${esc(f.pantalla)} <button class="x" id="clearScr" style="font-size:14px;padding:0 0 0 4px">×</button></span>` : ''}
    <span id="cnt" class="small muted2"></span></div>
  <div id="tbl"></div>`;

  const draw = () => {
    $('#fE').innerHTML = chips([{ v: '', t: 'Todos los estados', n: all.length }, ...ORDER.filter((k) => porEstado.has(k)).map((k) => ({ v: k, t: ESTADO_LABEL[k], n: porEstado.get(k) }))], f.estado, 'estado');
    $('#fP').innerHTML = chips([{ v: '', t: 'Todas las apps' }, ...[...porPaq.entries()].map(([k, n]) => ({ v: k, t: k, n }))], f.paq, 'paq');
    $('#fN').innerHTML = chips([{ v: '', t: 'Cualquier naturaleza' }, ...[...porNat.entries()].sort().map(([k, n]) => ({ v: k, t: k, n }))], f.nat, 'nat');
    const q = f.q.toLowerCase();
    const rows = all.filter((a) => (!f.estado || a.estado === f.estado) && (!f.paq || a.paquete === f.paq) && (!f.tipo || a.tipo === f.tipo)
      && (!f.nat || (f.nat === 'ninguna' ? !a.naturaleza.length : a.naturaleza.includes(f.nat)))
      && (!f.pantalla || a.pantallas.includes(f.pantalla))
      && (!q || `${a.etiqueta} ${a.archivo} ${a.tag} ${a.llamadasApi.map((l) => l.plantilla).join(' ')} ${a.razon.join(' ')}`.toLowerCase().includes(q)))
      .sort((a, b) => ORDER.indexOf(a.estado) - ORDER.indexOf(b.estado) || a.archivo.localeCompare(b.archivo) || a.linea - b.linea);
    $('#cnt').textContent = `${fmt(rows.length)} de ${fmt(all.length)}`;
    pager($('#tbl'), rows, (a) => `<tr class="row" data-open="accion" data-id="${esc(a.id)}"><td>${estadoTag(a.estado)}</td><td><b>${esc(a.tag)}</b> ${a.etiqueta ? '«' + esc(a.etiqueta.slice(0, 60)) + '»' : '<span class="muted2">(sin texto)</span>'}</td><td class="small">${esc(a.paquete)}${a.actor ? ' · ' + esc(a.actor) : ''}</td><td class="small clip">${a.llamadasApi.length ? a.llamadasApi.slice(0, 2).map((l) => `<code>${esc(l.metodo)} ${esc(l.plantilla)}</code>`).join(' ') : (a.naturaleza.join(', ') || '—')}</td><td class="small">${loc(a.archivo, a.linea, short(a.archivo, 2) + ':' + a.linea)}</td><td class="small muted2 clip">${esc((a.razon[0] ?? '').slice(0, 110))}</td></tr>`, {
      header: '<thead><tr><th>Estado</th><th>Control</th><th>App</th><th>Efecto</th><th>Ubicación</th><th>Evidencia</th></tr></thead>',
    });
  };
  const $ = (s) => el.querySelector(s);
  el.addEventListener('click', (ev) => {
    const c = ev.target.closest('[data-chips] .chip');
    if (c) { const k = c.parentElement.dataset.chips; f[k] = c.dataset.v; setParams({ [k]: f[k] }); draw(); }
    if (ev.target.closest('#clearScr')) { f.pantalla = ''; setParams({ pantalla: '' }); render(el, new URLSearchParams(location.hash.split('?')[1] ?? ''), { setParams }); }
  });
  $('#fT').addEventListener('change', (e) => { f.tipo = e.target.value; setParams({ tipo: f.tipo }); draw(); });
  $('#fQ').addEventListener('input', debounce((e) => { f.q = e.target.value; setParams({ q: f.q }); draw(); }, 180));
  draw();
  const sel = params.get('sel');
  if (sel) openDrawer('accion', sel, { silent: true });
}
