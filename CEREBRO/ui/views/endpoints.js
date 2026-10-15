// Mapa de endpoints: guardas, qué escriben, quién los consume y qué pruebas los ejercitan.
import { esc, D, fmt, chips, pager, loc, short, debounce } from '../lib.js';
import { openDrawer } from '../drawers.js';

export default async function render(el, params, { setParams }) {
  const [{ endpoints }] = await Promise.all([D('endpoints')]);
  const f = { m: params.get('m') ?? '', g: params.get('g') ?? '', c: params.get('c') ?? '', q: params.get('q') ?? '' };
  const mounted = endpoints.filter((e) => e.montada);
  const conRol = (r) => mounted.filter((e) => e.guardas.roles.includes(r)).length;
  el.innerHTML = `
  <div class="page-head"><h1>Endpoints</h1><p class="lede">Rutas HTTP reales del backend, con la cadena de middlewares tal como las ejecuta Express y lo que cada manejador alcanza (servicios, modelos, libro mayor, eventos). Los consumidores salen de las llamadas axios/fetch de los frontends.</p></div>
  <div class="kpis" style="margin-bottom:14px">
    <div class="kpi"><b>${fmt(mounted.length)}</b><span>montados</span></div>
    <div class="kpi warn"><b>${fmt(mounted.filter((e) => e.guardas.publica).length)}</b><span>públicos (sin sesión)</span></div>
    <div class="kpi"><b>${fmt(mounted.filter((e) => e.escribe).length)}</b><span>escriben en base de datos</span></div>
    <div class="kpi"><b>${fmt(mounted.filter((e) => e.cierre?.libroMayor).length)}</b><span>tocan el libro mayor</span></div>
    <div class="kpi ${mounted.filter((e) => !e.consumidores?.length).length ? 'warn' : ''}"><b>${fmt(mounted.filter((e) => !e.consumidores?.length).length)}</b><span>sin consumidor en el repo</span></div>
    <div class="kpi"><b>${fmt(mounted.filter((e) => e.pruebas?.length).length)}</b><span>ejercitados por una prueba HTTP</span></div>
  </div>
  <div id="cM"></div><div id="cG"></div><div id="cC"></div>
  <div class="filters"><label>Buscar <input id="q" type="search" value="${esc(f.q)}" placeholder="ruta, permiso, controlador…" style="width:300px"></label><span id="cnt" class="small muted2"></span></div>
  <div id="tbl"></div>`;
  const $ = (s) => el.querySelector(s);
  const draw = () => {
    $('#cM').innerHTML = chips([{ v: '', t: 'Todos los métodos' }, ...['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => ({ v: m, t: m, n: mounted.filter((e) => e.metodo === m).length }))], f.m, 'm');
    $('#cG').innerHTML = chips([
      { v: '', t: 'Cualquier guarda' }, { v: 'publica', t: 'Pública', n: mounted.filter((e) => e.guardas.publica).length },
      ...['ADMIN', 'BUSINESS', 'DRIVER', 'CLIENT'].map((r) => ({ v: 'rol:' + r, t: 'authorize ' + r, n: conRol(r) })),
      { v: 'perm', t: 'Con permiso RBAC', n: mounted.filter((e) => e.guardas.permisos.length || e.guardas.permisosCualquiera.length || e.guardas.soloAdminPermisos.length).length },
      { v: 'sinval', t: 'Sin validate()', n: mounted.filter((e) => e.metodo !== 'GET' && !e.guardas.validadores.length).length },
    ], f.g, 'g');
    $('#cC').innerHTML = chips([
      { v: '', t: 'Cualquier uso' }, { v: 'sinc', t: 'Sin consumidor', n: mounted.filter((e) => !e.consumidores?.length).length },
      { v: 'sinp', t: 'Sin prueba HTTP', n: mounted.filter((e) => !e.pruebas?.length).length }, { v: 'esc', t: 'Escribe en BD', n: mounted.filter((e) => e.escribe).length }, { v: 'libro', t: 'Libro mayor', n: mounted.filter((e) => e.cierre?.libroMayor).length },
    ], f.c, 'c');
    const q = f.q.toLowerCase();
    const rows = mounted.filter((e) => (!f.m || e.metodo === f.m)
      && (!f.g || (f.g === 'publica' ? e.guardas.publica : f.g.startsWith('rol:') ? e.guardas.roles.includes(f.g.slice(4)) : f.g === 'perm' ? (e.guardas.permisos.length || e.guardas.permisosCualquiera.length || e.guardas.soloAdminPermisos.length) : f.g === 'sinval' ? (e.metodo !== 'GET' && !e.guardas.validadores.length) : true))
      && (!f.c || (f.c === 'sinc' ? !e.consumidores?.length : f.c === 'sinp' ? !e.pruebas?.length : f.c === 'esc' ? e.escribe : f.c === 'libro' ? e.cierre?.libroMayor : true))
      && (!q || `${e.id} ${e.manejador ?? ''} ${e.guardas.permisos.join(' ')} ${e.guardas.soloAdminPermisos.join(' ')} ${e.archivo}`.toLowerCase().includes(q)))
      .sort((a, b) => a.ruta.localeCompare(b.ruta) || a.metodo.localeCompare(b.metodo));
    $('#cnt').textContent = `${fmt(rows.length)} de ${fmt(mounted.length)}`;
    pager($('#tbl'), rows, (e) => {
      const g = e.guardas;
      const acceso = g.publica ? '<span class="tag warn">pública</span>' : [g.roles.length ? g.roles.map((r) => `<span class="tag gold">${esc(r)}</span>`).join(' ') : '<span class="tag">sesión</span>', ...[...g.permisos, ...g.permisosCualquiera, ...g.soloAdminPermisos].slice(0, 3).map((p) => `<span class="tag">${esc(p)}</span>`)].join(' ');
      const mods = e.cierre ? Object.entries(e.cierre.modelos).filter(([, v]) => v.escribe).map(([k]) => k) : [];
      return `<tr class="row" data-open="endpoint" data-id="${esc(e.id)}"><td><b>${esc(e.metodo)}</b></td><td class="mono clip">${esc(e.ruta.replace('/api/v1', ''))}</td><td>${acceso}</td><td class="small">${g.validadores.length ? 'sí' : e.metodo === 'GET' ? '—' : '<span class="sev-MEDIO">no</span>'}</td><td class="small clip">${esc((e.manejador ?? '').split('#')[1] ?? '—')}</td><td class="small clip">${mods.length ? esc(mods.slice(0, 4).join(', ')) : '—'}${e.cierre?.libroMayor ? ' <span class="tag warn">libro</span>' : ''}</td><td class="num">${fmt(e.consumidores?.length ?? 0)}</td><td class="num">${fmt(e.pruebas?.length ?? 0)}</td></tr>`;
    }, { header: '<thead><tr><th>Método</th><th>Ruta</th><th>Acceso</th><th>validate</th><th>Manejador</th><th>Escribe</th><th class="num">Usos</th><th class="num">Pruebas</th></tr></thead>' });
  };
  el.addEventListener('click', (ev) => { const c = ev.target.closest('[data-chips] .chip'); if (c) { const k = c.parentElement.dataset.chips; f[k] = c.dataset.v; setParams({ [k]: f[k] }); draw(); } });
  $('#q').addEventListener('input', debounce((e) => { f.q = e.target.value; setParams({ q: f.q }); draw(); }, 180));
  draw();
  if (params.get('sel')) openDrawer('endpoint', params.get('sel'), { silent: true });
}
