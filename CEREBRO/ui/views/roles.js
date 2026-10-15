// Roles y permisos efectivos: matrices declaradas en código, guardas reales de cada ruta y compuertas de interfaz.
import { esc, D, fmt, chips, pager, loc, short, debounce } from '../lib.js';

const flat = (v) => {
  if (v == null) return v;
  if (typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(flat);
  return v;
};

export default async function render(el, params, { setParams }) {
  const r = await D('roles');
  const tab = params.get('t') ?? 'rutas';
  const TABS = [{ v: 'rutas', t: 'Guardas por ruta' }, { v: 'matrices', t: 'Matrices rol → permiso' }, { v: 'permisos', t: 'Permisos' }, { v: 'ui', t: 'Compuertas de interfaz' }, { v: 'notas', t: 'Notas de auditoría' }];
  el.innerHTML = `<div class="page-head"><h1>Roles y permisos</h1><p class="lede">Lo que cada rol puede hacer según lo que el <b>backend</b> aplica realmente. Ocultar un botón en un panel no protege nada: por eso la tabla de rutas sale del código de los routers, no de los menús.</p></div>
  <div class="kpis" style="margin-bottom:14px">${Object.entries(r.porRol).map(([k, v]) => `<div class="kpi"><b>${fmt(v.rutas)}</b><span>${esc(k)} · ${fmt(v.escritura)} escriben · ${fmt(v.conPermiso)} con permiso RBAC</span></div>`).join('')}</div>
  ${chips(TABS, tab, 't')}<div id="body"></div>`;
  el.querySelector('.chips').addEventListener('click', (ev) => { const c = ev.target.closest('.chip'); if (c) { setParams({ t: c.dataset.v }); render(el, new URLSearchParams(location.hash.split('?')[1] ?? ''), { setParams }); } });
  const body = el.querySelector('#body');
  if (tab === 'rutas') {
    body.innerHTML = `<div class="filters"><label>Rol <select id="rol"><option value="">todos</option><option value="PUBLICA">pública</option><option>ADMIN</option><option>BUSINESS</option><option>DRIVER</option><option>CLIENT</option></select></label><label><input id="solo" type="checkbox"> solo las que escriben</label><label>Buscar <input id="q" type="search" style="width:240px"></label><span id="cnt" class="small muted2"></span></div><div id="tbl"></div>`;
    const draw = () => {
      const rol = body.querySelector('#rol').value; const solo = body.querySelector('#solo').checked; const q = body.querySelector('#q').value.toLowerCase();
      const rows = r.guardas.filter((g) => (!rol || (rol === 'PUBLICA' ? g.publica : g.roles.includes(rol))) && (!solo || g.escribe || g.metodo !== 'GET') && (!q || `${g.id} ${g.permisos.join(' ')} ${g.soloAdminPermisos.join(' ')}`.toLowerCase().includes(q)));
      body.querySelector('#cnt').textContent = `${fmt(rows.length)} rutas`;
      pager(body.querySelector('#tbl'), rows, (g) => `<tr class="row" data-open="endpoint" data-id="${esc(g.id)}"><td><b>${esc(g.metodo)}</b></td><td class="mono clip">${esc(g.ruta.replace('/api/v1', ''))}</td><td>${g.publica ? '<span class="tag warn">pública</span>' : g.roles.length ? g.roles.map((x) => `<span class="tag gold">${esc(x)}</span>`).join(' ') : '<span class="tag">cualquier sesión</span>'}</td><td class="small">${[...g.permisos.map((p) => `<span class="tag">${esc(p)}</span>`), ...g.permisosCualquiera.map((p) => `<span class="tag dash">alguno: ${esc(p)}</span>`), ...g.soloAdminPermisos.map((p) => `<span class="tag info">solo admin: ${esc(p)}</span>`)].join(' ') || '<span class="muted2">—</span>'}${g.permisosInternos.length ? `<div class="muted2 small">dentro: ${esc(g.permisosInternos.join(', '))}</div>` : ''}</td><td class="small">${g.rechazaMostrador ? 'rechaza mostrador' : ''}</td></tr>`, { header: '<thead><tr><th>Método</th><th>Ruta</th><th>Cuenta</th><th>Permisos</th><th></th></tr></thead>' });
    };
    body.addEventListener('input', debounce(draw, 120)); body.addEventListener('change', draw); draw();
  } else if (tab === 'matrices') {
    body.innerHTML = r.matrices.length ? r.matrices.map((m) => matriz(m)).join('') : '<p class="empty">No se detectaron matrices.</p>';
  } else if (tab === 'permisos') {
    const en = r.enums;
    body.innerHTML = `<p class="lede">${Object.entries(en).map(([k, v]) => `<b>${esc(k)}</b> (${v.miembros.length}) ${loc(v.archivo, v.linea, '')}`).join(' · ')}</p>
    <div class="twrap"><table><thead><tr><th>Permiso (enum Permission)</th><th class="num">Rutas que lo exigen</th><th></th></tr></thead><tbody>${r.permisos.sort((a, b) => a.rutas - b.rutas).map((p) => `<tr><td class="mono">${esc(p.miembro)}</td><td class="num">${p.rutas}</td><td>${p.rutas === 0 ? '<span class="tag warn">ninguna ruta lo exige directamente</span>' : ''}</td></tr>`).join('')}</tbody></table></div>
    <p class="small muted2" style="margin-top:8px">Un permiso sin rutas puede aplicarse por dentro de un controlador (<code>can(req, …)</code>), en un servicio o en una compuerta de interfaz; el análisis intenta detectarlo en la columna «dentro» de la tabla de rutas.</p>`;
  } else if (tab === 'ui') {
    body.innerHTML = r.compuertasUi.length ? `<p class="lede">Rutas de los paneles protegidas en la interfaz. Son solo comodidad de usuario: la protección real es la del backend.</p><div class="twrap"><table><thead><tr><th>Panel</th><th>Ruta</th><th>Compuerta</th><th>Condición</th></tr></thead><tbody>${r.compuertasUi.map((c) => `<tr><td>${esc(c.paquete)}</td><td class="mono">${esc(c.ruta)}</td><td>${esc(c.componente)}</td><td class="small"><code>${esc(JSON.stringify(c.atributos))}</code> ${loc(c.archivo, c.linea, ':' + c.linea)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="empty">No se detectaron compuertas por ruta.</p>';
  } else {
    body.innerHTML = r.notas.length ? r.notas.map((n) => `<div class="note ${n.gravedad === 'alta' ? 'bad' : 'warn'}" style="margin-bottom:12px"><b>${esc(n.titulo)}</b><br>${esc(n.texto)}${(n.refs ?? []).map((x) => ' ' + loc(x.archivo, x.linea)).join('')}</div>`).join('') : '<p class="empty">Aún sin notas manuales en <code>CEREBRO/manual/roles.json</code>.</p>';
  }
}

function matriz(m) {
  const v = m.valor;
  const head = `<h3 style="margin-top:20px">${esc(m.nombre)} <span class="small muted2">${loc(m.archivo, m.linea, short(m.archivo, 2) + ':' + m.linea)}</span></h3>`;
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const rows = Object.entries(v).filter(([k]) => !k.startsWith('_'));
    return `${head}<div class="twrap"><table><thead><tr><th>Clave</th><th>Valor</th></tr></thead><tbody>${rows.map(([k, x]) => `<tr><td class="mono">${esc(k)}</td><td class="small">${Array.isArray(x) ? x.map((e) => `<span class="tag">${esc(typeof e === 'string' ? e.replace(/^[A-Za-z]+\./, '') : JSON.stringify(e))}</span>`).join(' ') || '<span class="muted2">vacío</span>' : esc(typeof x === 'object' ? JSON.stringify(x) : x)}</td></tr>`).join('')}${v._spreads ? `<tr><td class="mono">…</td><td class="small">hereda de ${v._spreads.map((s) => `<code>${esc(s)}</code>`).join(' ')}</td></tr>` : ''}</tbody></table></div>`;
  }
  return `${head}<pre class="code"><div><i></i><span>${esc(JSON.stringify(flat(v), null, 1).slice(0, 2000))}</span></div></pre>`;
}
