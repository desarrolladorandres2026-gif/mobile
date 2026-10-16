// Panel lateral de detalle: símbolo, archivo, acción (recorrido), endpoint, modelo y hallazgo.
import { esc, D, A, loc, symLink, short, estadoTag, confTag, sevTag, confianzaTag, fmt, pct, codeBlock, state, ESTADO_LABEL } from './lib.js';

const stack = [];
let current = null;

export function drawerEl() { return document.getElementById('drawer'); }
export function closeDrawer() {
  document.getElementById('app').classList.remove('with-drawer');
  drawerEl().hidden = true;
  current = null;
  stack.length = 0;
  const h = new URL(location.href);
  const q = (h.hash.split('?')[1] ?? '');
  const p = new URLSearchParams(q);
  p.delete('d');
  const base = h.hash.split('?')[0] || '#/resumen';
  history.replaceState(null, '', `${base}${p.toString() ? '?' + p.toString() : ''}`);
}

export async function openDrawer(tipo, id, { push = true, silent = false } = {}) {
  if (push && current) stack.push(current);
  current = { tipo, id };
  const d = drawerEl();
  document.getElementById('app').classList.add('with-drawer');
  d.hidden = false;
  d.innerHTML = `<div class="drawer-head"><h3>Cargando…</h3><button class="x" data-close aria-label="Cerrar">×</button></div>`;
  try {
    let html;
    if (tipo === 'nodo') html = await nodoHtml(id);
    else if (tipo === 'accion') html = await accionHtml(id);
    else if (tipo === 'endpoint') html = await endpointHtml(id);
    else if (tipo === 'hallazgo') html = await hallazgoHtml(id);
    else if (tipo === 'modelo') html = await modeloHtml(id);
    else if (tipo === 'archivo') html = await archivoHtml(id);
    else html = '<div class="drawer-body">Tipo de elemento desconocido.</div>';
    d.innerHTML = html;
    d.scrollTop = 0;
  } catch (e) {
    d.innerHTML = `<div class="drawer-head"><h3>No se pudo cargar</h3><button class="x" data-close>×</button></div><div class="drawer-body"><p class="note bad">${esc(e.message)}</p></div>`;
  }
  if (!silent) {
    const h = new URL(location.href);
    const p = new URLSearchParams(h.hash.split('?')[1] ?? '');
    p.set('d', `${tipo}:${id}`);
    history.replaceState(null, '', `${h.hash.split('?')[0] || '#/resumen'}?${p.toString()}`);
  }
}

export function drawerBack() {
  const prev = stack.pop();
  if (prev) openDrawer(prev.tipo, prev.id, { push: false });
  else closeDrawer();
}

const head = (titulo, sub, extra = '') => `<div class="drawer-head"><div style="flex:1"><h3>${titulo}</h3>${sub ? `<div class="small muted2">${sub}</div>` : ''}${extra}</div>${stack.length ? '<button class="x" data-back title="Volver">←</button>' : ''}<button class="x" data-close aria-label="Cerrar">×</button></div>`;

const kv = (rows) => `<dl class="kv">${rows.filter(Boolean).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>`;

function edgeGroups(list, dirKey) {
  // agrupa por archivo
  const g = new Map();
  for (const e of list) {
    const k = e.archivo ?? '(sin archivo)';
    if (!g.has(k)) g.set(k, []);
    g.get(k).push(e);
  }
  return [...g.entries()].map(([f, es]) => `<div style="margin-bottom:8px"><div class="small">${loc(f, es[0].linea, short(f, 3))}</div><ul class="plain">${es.slice(0, 14).map((e) => `<li>${symLink(e.id, e.ruta ?? e.nombre)} <span class="small muted2">${esc(e.arista)}${e.via ? ' · ' + esc(e.via) : ''}</span> ${confTag(e.conf)}${e.lineaLlamada ? ` <span class="small muted2">línea ${e.lineaLlamada}</span>` : ''}</li>`).join('')}${es.length > 14 ? `<li class="small muted2">… y ${es.length - 14} más</li>` : ''}</ul></div>`).join('');
}

async function nodoHtml(id) {
  const n = await A(`/api/nodo?id=${encodeURIComponent(id)}`);
  if (n.clase === 'archivo') return archivoHtml(id, n);
  const s = n.simbolo;
  const sale = n.sale.filter((e) => e.arista !== 'usa-enum' || true);
  const flags = s.banderas ? Object.entries(s.banderas).filter(([k]) => !/Linea/.test(k)).map(([k, v]) => `<span class="tag warn">${esc(k)}${typeof v === 'string' ? ': ' + esc(v) : ''}</span>`).join(' ') : '';
  const callers = n.entra.filter((e) => ['llama', 'referencia', 'instancia', 'renderiza', 'extiende', 'implementa'].includes(e.arista));
  const prod = callers.filter((e) => !/__tests__|\.test\./.test(e.archivo ?? ''));
  return `${head(esc(s.ruta), `<span class="tag gold">${esc(s.tipo)}</span> ${loc(s.archivo, s.linea)}`, '')}
  <div class="drawer-body">
    ${s.doc ? `<p class="muted2">${esc(s.doc)}</p>` : ''}
    ${kv([
      s.firma ? ['Firma', `<code>${esc(s.firma)}</code>`] : null,
      ['Líneas', `${s.linea}–${s.lineaFin}`],
      ['Exportado', s.exportado ? 'sí' : 'no'],
      ['Llamado por', `${fmt(prod.length)} ${prod.length === 1 ? 'referencia' : 'referencias'}${callers.length > prod.length ? ` (+${callers.length - prod.length} de pruebas)` : ''}`],
      ['Depende de', `${fmt(sale.filter((e) => e.arista !== 'usa-enum').length)} símbolos`],
      flags ? ['Señales', flags] : null,
    ])}
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <button class="btn" data-go="mapa" data-focus="${esc(s.id)}">Ver conexiones</button>
      <button class="btn quiet" data-impact="${esc(s.id)}">¿Qué se rompe si lo cambio?</button>
      <button class="btn quiet" data-code="${esc(s.archivo)}" data-l1="${s.linea}" data-l2="${s.lineaFin}">Ver código</button>
    </div>
    <div id="dz-extra"></div>
    ${n.endpoints.length ? `<section><h2>Endpoints que lo ejecutan</h2><ul class="plain">${n.endpoints.map((e) => `<li><span class="sym" data-open="endpoint" data-id="${esc(e)}">${esc(e)}</span></li>`).join('')}</ul></section>` : ''}
    ${n.acciones.length ? `<section><h2>Controles de interfaz que lo disparan</h2><ul class="plain">${n.acciones.map((a) => `<li><span class="sym" data-open="accion" data-id="${esc(a.id)}">${esc(a.etiqueta || '(sin texto)')}</span> ${estadoTag(a.estado)} ${loc(a.archivo, a.linea, short(a.archivo, 2) + ':' + a.linea)}</li>`).join('')}</ul></section>` : ''}
    <section><h2>Llamado por</h2>${prod.length ? edgeGroups(prod) : '<p class="empty">Sin referencias resueltas en código de producción.</p>'}</section>
    <section><h2>Depende de</h2>${sale.length ? edgeGroups(sale.filter((e) => e.arista !== 'usa-enum')) : '<p class="empty">No llama a otros símbolos del repo.</p>'}</section>
    ${n.tests.length ? `<section><h2>Pruebas que lo ejercitan</h2><ul class="plain">${n.tests.map((t) => `<li>${loc(t, 1, t)}</li>`).join('')}</ul></section>` : '<section><h2>Pruebas</h2><p class="empty">Ninguna prueba lo referencia directamente.</p></section>'}
    ${n.hallazgos.length ? `<section><h2>Hallazgos</h2><ul class="plain">${n.hallazgos.map((h) => `<li>${sevTag(h.severidad)} <span class="sym" data-open="hallazgo" data-id="${esc(h.id)}">${esc(h.titulo)}</span></li>`).join('')}</ul></section>` : ''}
  </div>`;
}

async function archivoHtml(path, pre = null) {
  const n = pre ?? (await A(`/api/nodo?id=${encodeURIComponent(path)}`));
  if (n.error) return `${head(esc(path), '')}<div class="drawer-body"><p class="note warn">Este archivo no tiene símbolos analizados (${esc(n.error)}). Puede ser un recurso, configuración o archivo excluido.</p></div>`;
  const inv = n.inventario ?? {};
  const cov = n.cobertura;
  return `${head(esc(short(path, 3)), `<span class="tag">${esc(inv.clase ?? '')}</span> ${loc(path, 1, path)}`)}
  <div class="drawer-body">
    ${kv([
      ['Paquete', esc(inv.paquete)], ['Líneas', fmt(inv.lineas)],
      cov?.indexado ? ['Indexado', `${fmt(cov.indexado.lineas)} de ${fmt(cov.lineas)} líneas (${esc(cov.indexado.metodo)})`] : null,
      ['Auditado (lectura)', cov?.auditado?.lineas ? `${fmt(cov.auditado.lineas)} líneas · ${esc((cov.auditado.por ?? []).join(', '))}` : 'sin lectura registrada'],
      cov?.auditado?.pendienteDeRevision?.length ? ['Revisión pendiente', 'el archivo cambió desde que se leyó'] : null,
    ])}
    <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn quiet" data-impact="${esc(path)}">¿Qué se rompe si lo cambio?</button><button class="btn quiet" data-code="${esc(path)}" data-l1="1" data-l2="80">Ver código</button></div>
    <div id="dz-extra"></div>
    <section><h2>Símbolos (${n.simbolos.length})</h2><ul class="plain">${n.simbolos.slice(0, 120).map((s) => `<li>${symLink(s.id, s.ruta)} <span class="tag">${esc(s.tipo)}</span> <span class="small muted2">${s.linea}–${s.lineaFin} · ${fmt(s.entran)} entran · ${fmt(s.salen)} salen</span></li>`).join('')}</ul></section>
    <section><h2>Importa (${n.importa.length})</h2><ul class="plain">${n.importa.map((i) => `<li><span class="sym" data-open="archivo" data-id="${esc(i.archivo)}">${esc(short(i.archivo, 3))}</span> <span class="small muted2">${esc(i.tipo)} ${esc(i.nombres ?? '')}</span></li>`).join('')}</ul></section>
    <section><h2>Importado por (${n.importadoPor.length})</h2><ul class="plain">${n.importadoPor.slice(0, 80).map((i) => `<li><span class="sym" data-open="archivo" data-id="${esc(i.archivo)}">${esc(short(i.archivo, 3))}</span></li>`).join('')}</ul></section>
    ${n.hallazgos.length ? `<section><h2>Hallazgos</h2><ul class="plain">${n.hallazgos.map((h) => `<li>${sevTag(h.severidad)} <span class="sym" data-open="hallazgo" data-id="${esc(h.id)}">${esc(h.titulo)}</span></li>`).join('')}</ul></section>` : ''}
    ${n.pruebas.length ? `<section><h2>Pruebas que lo importan</h2><ul class="plain">${n.pruebas.map((t) => `<li>${loc(t, 1, t)}</li>`).join('')}</ul></section>` : ''}
  </div>`;
}

// ───────────── Recorrido de una acción ─────────────

function step(k, titulo, desc, { cls = '', conf = '', refs = '' } = {}) {
  return `<div class="step ${cls}"><div class="step-h"><span class="step-k">${esc(k)}</span><span class="step-t">${titulo}</span> ${conf} ${refs}</div>${desc ? `<div class="step-d">${desc}</div>` : ''}</div>`;
}

async function accionHtml(id) {
  const [acc, eps, panta] = await Promise.all([D('acciones'), D('endpoints'), D('pantallas')]);
  const a = acc.acciones.find((x) => x.id === id);
  if (!a) return `${head('Acción no encontrada', '')}<div class="drawer-body"><p class="note warn">La acción ya no existe en la instantánea actual (¿cambió el código?).</p></div>`;
  const epById = new Map(eps.endpoints.map((e) => [e.id, e]));
  const screens = a.pantallas.map((sid) => panta.pantallas.find((p) => p.id === sid)).filter(Boolean);
  const steps = [];
  steps.push(step('Pantalla', screens.length ? screens.map((s) => `<span class="tag">${esc(s.paquete)}</span> ${esc(s.ruta)}`).join(' · ') : '<span class="muted2">componente compartido o global (no cuelga de una pantalla concreta)</span>', screens.length ? loc(screens[0].archivo, screens[0].linea, '') : '', { conf: confTag('estatica') }));
  steps.push(step('Control', `${esc(a.tag)} ${a.etiqueta ? '«' + esc(a.etiqueta) + '»' : ''}`, `${esc(a.tipo)}${a.deshabilitado ? ` · <code>disabled=${esc(a.deshabilitado)}</code>` : ''}${a.destino ? ` · destino <code>${esc(a.destino)}</code>` : ''}`, { refs: loc(a.archivo, a.linea), conf: confTag('estatica') }));
  if (a.manejadores.length) {
    steps.push(step('Manejador', a.manejadores.map((m) => symLink(m)).join(' · '), a.notas?.length ? a.notas.map(esc).join(' · ') : '', { conf: a.manejadores.length ? confTag('estatica') : '' }));
  } else {
    steps.push(step('Manejador', '<span class="sev-ALTO">sin manejador</span>', a.razon.map(esc).join(' '), { cls: 'bad' }));
  }
  for (const ll of a.llamadasApi) {
    const mid = (ll.recorrido ?? []).slice(1, -1);
    if (mid.length) steps.push(step('Recorrido', mid.map((m) => symLink(m)).join(' → '), 'Funciones intermedias entre el manejador y la petición.', { cls: 'inf', conf: confTag('estatica') }));
    steps.push(step('Petición', `<code>${esc(ll.metodo)} ${esc(ll.plantilla)}</code>`, `${ll.cuerpo?.length ? 'Cuerpo: ' + ll.cuerpo.slice(0, 14).map((c) => `<code>${esc(c)}</code>`).join(' ') : ''}${ll.parametros?.length ? ' · Query: ' + ll.parametros.slice(0, 8).map((c) => `<code>${esc(c)}</code>`).join(' ') : ''}`, { refs: loc(ll.archivo, ll.linea), conf: confTag('estatica'), cls: ll.externa ? 'gap' : '' }));
    if (ll.externa) { steps.push(step('Servicio externo', 'No es la API de ZIPP', 'La llamada va a un tercero; no se puede verificar desde el repositorio.', { cls: 'gap', conf: confTag('sin') })); continue; }
    if (!ll.endpoints.length) { steps.push(step('Endpoint', '<span class="sev-ALTO">no existe</span>', ll.metodoOtro?.length ? `La ruta existe con ${esc(ll.metodoOtro.join('/'))}.` : 'Ningún endpoint registrado coincide.', { cls: 'bad' })); continue; }
    for (const eid of ll.endpoints) {
      const ep = epById.get(eid);
      if (!ep) continue;
      const g = ep.guardas;
      steps.push(step('Endpoint', `<span class="sym" data-open="endpoint" data-id="${esc(eid)}">${esc(eid)}</span>`, `${g.publica ? 'pública' : 'requiere sesión'}${g.roles.length ? ' · roles ' + esc(g.roles.join(', ')) : ''}${g.permisos.length ? ' · permisos ' + esc(g.permisos.join(', ')) : ''}${g.soloAdminPermisos.length ? ' · (solo admin) ' + esc(g.soloAdminPermisos.join(', ')) : ''}${g.validadores.length ? ' · validación ' + esc(g.validadores.join(', ')) : ' · sin validate()'}${g.limites.length ? ' · límite ' + esc(g.limites.join(', ')) : ''}`, { refs: loc(ep.archivo, ep.linea), conf: confTag('estatica') }));
      if (ep.manejador) steps.push(step('Controlador', symLink(ep.manejador), '', { conf: confTag('estatica') }));
      const c = ep.cierre;
      if (c) {
        steps.push(step('Servicios', c.servicios.length ? c.servicios.map((s) => `<span class="sym" data-open="archivo" data-id="${esc(s)}">${esc(short(s, 1).replace('.service.ts', ''))}</span>`).join(' · ') : '<span class="muted2">ninguno</span>', `Alcance estático de ${fmt(c.nodos)} funciones hasta profundidad ${c.profundidad}.`, { conf: confTag('estatica') }));
        const mods = Object.entries(c.modelos);
        steps.push(step('Datos', mods.length ? mods.map(([m, v]) => `<span class="tag ${v.escribe ? 'warn' : ''}">${esc(m)} ${v.escribe ? '✎ escribe' : 'lee'}</span>`).join(' ') : '<span class="muted2">no toca la base de datos</span>', [c.libroMayor ? 'Asienta en el libro mayor.' : '', c.auditoria ? 'Deja registro de auditoría.' : '', c.externos.length ? 'Externos: ' + c.externos.map(esc).join(', ') + '.' : '', c.eventos.length ? 'Emite: ' + c.eventos.map(esc).join(', ') + '.' : ''].filter(Boolean).join(' '), { conf: confTag('estatica') }));
      }
      steps.push(step('Pruebas', ep.pruebas?.length ? `${ep.pruebas.length} archivo(s) de prueba ejercitan este endpoint` : '<span class="muted2">ninguna prueba HTTP lo ejercita</span>', ep.pruebas?.length ? ep.pruebas.slice(0, 4).map((p) => loc(p.archivo, p.linea, short(p.archivo, 1))).join(' · ') : '', { cls: ep.pruebas?.length ? 'ok' : 'gap', conf: ep.pruebas?.length ? confTag('probada') : confTag('sin') }));
    }
  }
  if (a.efectos.length) {
    steps.push(step('Efectos en pantalla', a.efectos.map((e) => `<span class="tag">${esc(e.tipo)}</span> ${e.llamada ? '<code>' + esc(e.llamada) + '</code>' : ''}${e.destino ? ' → <code>' + esc(e.destino) + '</code>' : ''}${e.n ? ' ×' + e.n : ''}`).join('<br>'), '', { conf: confTag('estatica') }));
  }
  if (!a.llamadasApi.length && !a.efectos.length && a.manejadores.length) {
    steps.push(step('Resultado', '<span class="muted2">El manejador no alcanza API, navegación ni estado local rastreable</span>', 'Puede delegar en librerías externas o en código dinámico.', { cls: 'gap', conf: confTag('sin') }));
  }
  return `${head(`${esc(a.tag)} ${a.etiqueta ? '«' + esc(a.etiqueta.slice(0, 70)) + '»' : ''}`, `${estadoTag(a.estado)} <span class="tag">${esc(a.paquete)}</span> ${a.actor ? `<span class="tag">actúa como ${esc(a.actor)}</span>` : ''} ${loc(a.archivo, a.linea)}`)}
  <div class="drawer-body">
    ${a.razon.length ? `<div class="note ${['con_errores', 'desconectada', 'sin_implementar'].includes(a.estado) ? 'bad' : ''}">${a.razon.map(esc).join('<br>')}</div>` : ''}
    ${a.evidencias?.length ? `<section><h2>Evidencia</h2><ul class="plain">${a.evidencias.map((e) => `<li>${loc(e.archivo, e.linea)} <span class="small muted2">${esc(e.texto ?? '')}</span></li>`).join('')}</ul></section>` : ''}
    <section><h2>Recorrido completo</h2><div class="trace">${steps.join('')}</div></section>
    <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn quiet" data-code="${esc(a.archivo)}" data-l1="${a.linea}" data-l2="${a.lineaFin ?? a.linea + 12}">Ver código del control</button></div>
    <div id="dz-extra"></div>
  </div>`;
}

async function endpointHtml(id) {
  const [eps, calls, acc] = await Promise.all([D('endpoints'), D('llamadas-api'), D('acciones')]);
  const ep = eps.endpoints.find((e) => e.id === id);
  if (!ep) return `${head('Endpoint no encontrado', '')}<div class="drawer-body"><p class="note warn">Ya no existe en la instantánea actual.</p></div>`;
  const g = ep.guardas;
  const cons = calls.filter((c) => c.endpoints.includes(id));
  const actions = acc.acciones.filter((a) => a.llamadasApi.some((l) => l.endpoints.includes(id)));
  const c = ep.cierre;
  return `${head(`<code>${esc(ep.id)}</code>`, `${g.publica ? '<span class="tag warn">pública</span>' : '<span class="tag ok">requiere sesión</span>'} ${loc(ep.archivo, ep.linea)}`)}
  <div class="drawer-body">
    ${ep.comentario ? `<p class="muted2">${esc(ep.comentario)}</p>` : ''}
    <section><h2>Guardas (cadena de middlewares)</h2>
      <ul class="plain">${ep.middlewares.map((m) => `<li><span class="tag ${m.tipo === 'autenticacion' || m.tipo === 'roles' || m.tipo === 'permiso' ? 'gold' : ''}">${esc(m.tipo)}</span> <code>${esc(m.nombre)}${m.args.length ? '(' + esc(m.args.join(', ')) + ')' : ''}</code></li>`).join('') || '<li class="muted2">ninguno</li>'}</ul>
      ${kv([
        ['Roles de cuenta', g.roles.length ? esc(g.roles.join(', ')) : (g.publica ? 'sin sesión' : 'cualquier cuenta con sesión')],
        g.permisos.length ? ['Permisos (todos)', esc(g.permisos.join(', '))] : null,
        g.permisosCualquiera.length ? ['Permisos (alguno)', esc(g.permisosCualquiera.join(', '))] : null,
        g.soloAdminPermisos.length ? ['Permiso (solo si es admin)', esc(g.soloAdminPermisos.join(', '))] : null,
        c?.permisosInternos?.length ? ['Permisos comprobados dentro', esc(c.permisosInternos.join(', ')) + ' <span class="small muted2">(inferido)</span>'] : null,
        ['Rechaza sesión de mostrador', g.rechazaMostrador ? 'sí' : 'no'],
        ['Validación del cuerpo', g.validadores.length ? esc(g.validadores.join(', ')) : '<span class="sev-MEDIO">ninguna en la ruta</span>'],
        ['Límite de tasa', g.limites.length ? esc(g.limites.join(', ')) : 'solo el global'],
      ])}
    </section>
    <section><h2>Qué ejecuta</h2>
      ${ep.manejador ? `<p>${symLink(ep.manejador)}</p>` : '<p class="note warn">El manejador no se resolvió a un controlador o servicio.</p>'}
      ${c ? kv([
        ['Servicios', c.servicios.length ? c.servicios.map((s) => `<span class="sym" data-open="archivo" data-id="${esc(s)}">${esc(short(s, 1).replace('.service.ts', ''))}</span>`).join(' · ') : 'ninguno'],
        ['Modelos', Object.keys(c.modelos).length ? Object.entries(c.modelos).map(([m, v]) => `<span class="tag ${v.escribe ? 'warn' : ''}">${esc(m)} ${v.escribe ? 'escribe' : 'lee'}</span>`).join(' ') : 'ninguno'],
        ['Libro mayor', c.libroMayor ? 'sí' : 'no'], ['Auditoría', c.auditoria ? 'sí' : 'no'],
        ['Externos', c.externos.length ? c.externos.map(esc).join(', ') : 'ninguno'],
        ['Eventos que emite', c.eventos.length ? c.eventos.map(esc).join(', ') : 'ninguno'],
        ['Alcance', `${fmt(c.nodos)} funciones, profundidad ${c.profundidad}`],
      ]) : ''}
      <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">${ep.manejador ? `<button class="btn" data-go="mapa" data-focus="${esc(ep.manejador)}" data-dir="out" data-prof="3">Ver cadena hacia el backend</button>` : ''}<button class="btn quiet" data-code="${esc(ep.archivo)}" data-l1="${ep.linea}" data-l2="${ep.lineaFin}">Ver código de la ruta</button></div>
      <div id="dz-extra"></div>
    </section>
    <section><h2>Quién lo usa (${cons.length})</h2>${cons.length ? `<ul class="plain">${cons.map((x) => `<li><span class="tag">${esc(x.paquete)}</span> ${symLink(x.desde)} ${loc(x.archivo, x.linea, ':' + x.linea)} ${x.ambigua ? '<span class="tag warn">ambigua</span>' : ''}</li>`).join('')}</ul>` : '<p class="empty">Ningún frontend del repositorio lo llama.</p>'}</section>
    ${actions.length ? `<section><h2>Controles de interfaz que llegan hasta aquí (${actions.length})</h2><ul class="plain">${actions.slice(0, 40).map((a) => `<li><span class="sym" data-open="accion" data-id="${esc(a.id)}">${esc(a.etiqueta || a.tag)}</span> ${estadoTag(a.estado)} <span class="small muted2">${esc(a.paquete)}</span></li>`).join('')}</ul></section>` : ''}
    <section><h2>Pruebas</h2>${ep.pruebas?.length ? `<ul class="plain">${ep.pruebas.map((p) => `<li>${loc(p.archivo, p.linea)}</li>`).join('')}</ul>` : '<p class="empty">Ninguna prueba HTTP ejercita este endpoint.</p>'}</section>
  </div>`;
}

async function hallazgoHtml(id) {
  const hs = await D('hallazgos');
  const h = hs.find((x) => x.id === id);
  if (!h) return `${head('Hallazgo no encontrado', '')}<div class="drawer-body"><p class="note warn">Ya no se detecta en la instantánea actual: puede haberse corregido.</p></div>`;
  return `${head(esc(h.titulo), `${sevTag(h.severidad)} ${confianzaTag(h.confianza)} <span class="tag">${esc(h.area ?? '')}</span> <span class="tag">${esc(h.origen)}</span>${h.estado && h.estado !== 'abierto' ? ` <span class="tag warn">${esc(h.estado)}</span>` : ''}`)}
  <div class="drawer-body">
    ${h.notaVigencia ? `<div class="note warn">${esc(h.notaVigencia)}</div>` : ''}
    ${h.nota ? `<div class="note">${esc(h.nota)}</div>` : ''}
    ${h.descripcion ? `<section><h2>Qué ocurre</h2><p>${esc(h.descripcion)}</p></section>` : ''}
    ${h.causa ? `<section><h2>Causa</h2><p>${esc(h.causa)}</p></section>` : ''}
    ${h.consecuencia ? `<section><h2>Consecuencia posible</h2><p>${esc(h.consecuencia)}</p></section>` : ''}
    ${kv([['Alcance', esc(h.alcance ?? '—')], ['Probabilidad', esc(h.probabilidad ?? '—')], ['Impacto', esc(h.impacto ?? '—')], ['Regla', `<code>${esc(h.regla ?? h.id)}</code>`]])}
    <section><h2>Evidencia</h2><ul class="plain">${(h.evidencia ?? []).map((e, i) => `<li>${loc(e.archivo, e.linea)} ${e.estadoRef && e.estadoRef !== 'ok' && e.estadoRef !== 'sin-ancla' ? `<span class="tag warn">${esc(e.estadoRef)}</span>` : ''} <span class="small muted2">${esc(e.texto ?? '')}</span> <button class="btn quiet" style="padding:1px 8px" data-code="${esc(e.archivo)}" data-l1="${Math.max(1, (e.linea ?? 1) - 4)}" data-l2="${(e.linea ?? 1) + 14}" data-hl="${e.linea ?? ''}">ver</button></li>`).join('') || '<li class="muted2">sin evidencia localizada</li>'}</ul></section>
    <div id="dz-extra"></div>
    ${h.pruebaSugerida ? `<section><h2>Cómo confirmarlo</h2><p>${esc(h.pruebaSugerida)}</p></section>` : ''}
    ${h.afectados?.length ? `<section><h2>Podría verse afectado al corregirlo</h2><ul class="plain">${h.afectados.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></section>` : ''}
    ${(h.elementos ?? []).length ? `<section><h2>Elementos del mapa</h2><ul class="plain">${h.elementos.slice(0, 12).map((x) => `<li>${/#/.test(x) ? symLink(x) : `<span class="sym" data-open="endpoint" data-id="${esc(x)}">${esc(x)}</span>`}</li>`).join('')}</ul></section>` : ''}
  </div>`;
}

async function modeloHtml(id) {
  const ms = await D('modelos');
  const m = ms.find((x) => x.simbolo === id || x.nombre === id);
  if (!m) return `${head('Modelo no encontrado', '')}<div class="drawer-body"><p class="note warn">Ya no existe.</p></div>`;
  return `${head(esc(m.nombre), `${loc(m.archivo, m.linea)} ${m.coleccion ? '· colección ' + esc(m.coleccion) : ''}`)}
  <div class="drawer-body">
    ${kv([['Campos', fmt(m.campos.length)], ['Índices', fmt(m.indices.length)], ['Hooks', m.hooks.map((h) => esc(`${h.tipo}(${h.evento})`)).join(', ') || '—'], ['Referencia a', m.refs.map(esc).join(', ') || '—'], ['Referenciado por', m.refPor.map(esc).join(', ') || '—'], ['Opciones', m.opciones ? `<code>${esc(m.opciones)}</code>` : '—']])}
    <section><h2>Campos</h2><div class="twrap"><table><thead><tr><th>Campo</th><th>Tipo</th><th>Restricciones</th><th>Se menciona en</th></tr></thead><tbody>${m.campos.map((c) => `<tr><td><code>${esc(c.nombre)}</code></td><td class="small">${esc(c.tipo ?? '')}${c.array ? '[]' : ''}${c.ref ? ' → ' + esc(c.ref) : ''}</td><td class="small">${[c.requerido ? 'requerido' : '', c.unico ? 'único' : '', c.indice ? 'índice' : '', c.enum ? 'enum' : '', c.min != null ? 'min ' + esc(c.min) : '', c.max != null ? 'max ' + esc(c.max) : '', c.validador ? 'validador' : ''].filter(Boolean).join(' · ')}</td><td class="small">${Object.entries(c.menciones).map(([k, v]) => `${esc(k)} ${v}`).join(' · ') || '<span class="muted2">solo el modelo</span>'}</td></tr>`).join('')}</tbody></table></div></section>
    <section><h2>Índices</h2><ul class="plain">${m.indices.map((i) => `<li><code>${esc(i.campos)}</code> ${i.opciones ? '<code>' + esc(i.opciones) + '</code>' : ''}</li>`).join('') || '<li class="muted2">ninguno declarado</li>'}</ul></section>
    <section><h2>Quién escribe</h2><ul class="plain">${m.escritores.slice(0, 25).map((x) => `<li>${symLink(x.id)} <span class="small muted2">×${x.n}</span></li>`).join('') || '<li class="muted2">nadie en producción (según análisis estático)</li>'}</ul></section>
    <section><h2>Quién lee</h2><ul class="plain">${m.lectores.slice(0, 25).map((x) => `<li>${symLink(x.id)} <span class="small muted2">×${x.n}</span></li>`).join('') || '<li class="muted2">nadie</li>'}</ul></section>
    <section><h2>Endpoints que escriben (${m.endpointsEscriben.length})</h2><ul class="plain">${m.endpointsEscriben.slice(0, 40).map((e) => `<li><span class="sym" data-open="endpoint" data-id="${esc(e)}">${esc(e)}</span></li>`).join('')}</ul></section>
  </div>`;
}

export async function loadCode(el, archivo, l1, l2, hl) {
  try {
    const s = await A(`/api/codigo?archivo=${encodeURIComponent(archivo)}&desde=${l1}&hasta=${l2}`);
    el.innerHTML = `<div class="small muted2" style="margin-bottom:4px">${loc(archivo, s.desde, `${archivo}:${s.desde}-${s.hasta}`)}</div>${codeBlock(s, hl ? [Number(hl)] : [l1 + 1])}`;
  } catch (e) { el.innerHTML = `<p class="note warn">${esc(e.message)}</p>`; }
}

export async function loadImpact(el, id) {
  el.innerHTML = '<p class="muted2">Calculando…</p>';
  try {
    const r = await A(`/api/impacto?id=${encodeURIComponent(id)}`);
    el.innerHTML = `<section><h2>Si cambia esto, revisa</h2>
      ${kv([['Símbolos que dependen', fmt(r.simbolos)], ['Archivos', fmt(r.archivos.length)], ['Endpoints', fmt(r.endpoints.length)], ['Controles de interfaz', fmt(r.acciones.length)], ['Pruebas que importan estos archivos', fmt(r.pruebas.length)]])}
      ${r.endpoints.length ? `<h3 style="margin-top:10px">Endpoints</h3><ul class="plain">${r.endpoints.slice(0, 25).map((e) => `<li><span class="sym" data-open="endpoint" data-id="${esc(e)}">${esc(e)}</span></li>`).join('')}${r.endpoints.length > 25 ? `<li class="muted2">… ${r.endpoints.length - 25} más</li>` : ''}</ul>` : ''}
      ${r.acciones.length ? `<h3 style="margin-top:10px">Controles</h3><ul class="plain">${r.acciones.slice(0, 20).map((a) => `<li><span class="sym" data-open="accion" data-id="${esc(a.id)}">${esc(a.etiqueta || '(sin texto)')}</span> ${loc(a.archivo, a.linea, short(a.archivo, 2) + ':' + a.linea)}</li>`).join('')}</ul>` : ''}
      ${r.archivos.length ? `<h3 style="margin-top:10px">Archivos</h3><ul class="plain">${r.archivos.slice(0, 30).map((f) => `<li><span class="sym" data-open="archivo" data-id="${esc(f)}">${esc(f)}</span></li>`).join('')}${r.archivos.length > 30 ? `<li class="muted2">… ${r.archivos.length - 30} más</li>` : ''}</ul>` : ''}
      ${r.pruebas.length ? `<h3 style="margin-top:10px">Pruebas a ejecutar</h3><ul class="plain">${r.pruebas.slice(0, 20).map((f) => `<li>${loc(f, 1, f)}</li>`).join('')}</ul>` : ''}
      <p class="small muted2">Alcance estático por llamadas y referencias resueltas; no incluye acoplamientos por cadenas o registro dinámico.</p></section>`;
  } catch (e) { el.innerHTML = `<p class="note warn">${esc(e.message)}</p>`; }
}
