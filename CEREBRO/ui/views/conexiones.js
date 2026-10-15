// Eventos en tiempo real, procesos periódicos, integraciones externas y variables de entorno.
import { esc, D, fmt, loc, symLink, short, chips } from '../lib.js';

export default async function render(el, params, { setParams }) {
  const [eventos, procesos, integ, entorno] = await Promise.all([D('eventos'), D('procesos'), D('integraciones'), D('entorno')]);
  const tab = params.get('t') ?? 'eventos';
  const TABS = [{ v: 'eventos', t: 'Eventos Socket.IO', n: eventos.length }, { v: 'procesos', t: 'Procesos periódicos', n: procesos.length }, { v: 'integraciones', t: 'Integraciones y dependencias', n: integ.auto.modulos.length }, { v: 'entorno', t: 'Variables de entorno', n: entorno.variables.length }];
  const draw = () => {
    let body = '';
    if (tab === 'eventos') {
      const rows = eventos.filter((e) => !e.integrado);
      body = `<p class="lede">Contrato de tiempo real entre el backend y las apps. «Sin oyente» o «sin emisor» pueden deberse a registro dinámico; se marcan como hipótesis.</p>
      <div class="twrap"><table><thead><tr><th>Evento</th><th>Emite</th><th>Escucha</th><th>Estado</th></tr></thead><tbody>${rows.map((e) => {
        const oy = [...new Set(e.oyentes.map((o) => o.paquete))];
        const em = [...new Set(e.emisores.map((o) => o.paquete))];
        const estado = !e.emisores.length ? '<span class="tag warn">sin emisor</span>' : !e.oyentes.length ? '<span class="tag warn">sin oyente</span>' : '<span class="tag ok">conectado</span>';
        return `<tr><td class="mono">${esc(e.evento)}</td><td class="small">${e.emisores.slice(0, 3).map((x) => `${symLink(x.de, short(x.de.split('#')[1], 1))} ${loc(x.archivo, x.linea, ':' + x.linea)}`).join('<br>') || '—'}${e.emisores.length > 3 ? `<br><span class="muted2">+${e.emisores.length - 3}</span>` : ''}<div class="muted2">${esc(em.join(', '))}</div></td><td class="small">${e.oyentes.slice(0, 3).map((x) => `${symLink(x.de, short(x.de.split('#')[1], 1))} ${loc(x.archivo, x.linea, ':' + x.linea)}`).join('<br>') || '—'}${e.oyentes.length > 3 ? `<br><span class="muted2">+${e.oyentes.length - 3}</span>` : ''}<div class="muted2">${esc(oy.join(', '))}</div></td><td>${estado}</td></tr>`;
      }).join('')}</tbody></table></div>`;
    } else if (tab === 'procesos') {
      body = `<p class="lede">Temporizadores y barridos. Los de interfaz (contadores, sondeos) son locales a la pantalla; los del backend y el escritorio deben arrancarse desde el arranque de la aplicación.</p>
      <div class="twrap"><table><thead><tr><th>Ámbito</th><th>Proceso</th><th>Intervalo</th><th>Arranque</th><th>Ubicación</th></tr></thead><tbody>${[...procesos].sort((a, b) => (a.ambito === 'ui') - (b.ambito === 'ui') || a.archivo.localeCompare(b.archivo)).map((p) => `<tr><td><span class="tag ${p.ambito === 'backend' ? 'gold' : ''}">${esc(p.ambito)}</span></td><td>${symLink(p.arrancador ?? p.de)}</td><td class="mono">${esc(p.intervalo)}</td><td class="small">${p.ambito === 'ui' ? '<span class="muted2">al montar el componente</span>' : p.arrancado ? `<span class="tag ok">arrancado</span> ${p.arrancadoPor.slice(0, 2).map((a) => symLink(a.de, short(a.de.split('#')[1], 1))).join(' ')}` : '<span class="tag bad">sin arranque demostrado</span>'}</td><td class="small">${loc(p.archivo, p.linea, short(p.archivo, 2) + ':' + p.linea)}</td></tr>`).join('')}</tbody></table></div>`;
    } else if (tab === 'integraciones') {
      body = `<p class="lede">Lo que el código <b>usa</b> (llamadas resueltas a cada librería) y los servicios externos que el repositorio no contiene. Una integración «identificada» no es una integración «confirmada en funcionamiento»: ver la columna de estado.</p>
      <h2>Servicios de terceros declarados a mano</h2>
      ${integ.manual.length ? `<div class="twrap"><table><thead><tr><th>Integración</th><th>Estado</th><th>Notas</th></tr></thead><tbody>${integ.manual.map((i) => `<tr><td><b>${esc(i.nombre)}</b><div class="small muted2">${esc(i.proposito ?? '')}</div></td><td><span class="tag ${i.estado === 'confirmada' ? 'ok' : i.estado === 'probada' ? 'ok' : i.estado === 'configurada' ? 'gold' : 'dot3'}">${esc(i.estado)}</span></td><td class="small">${esc(i.notas ?? '')}${(i.evidencia ?? []).map((ev) => ' ' + loc(ev.archivo, ev.linea, short(ev.archivo, 2) + ':' + ev.linea)).join('')}${i.falta ? `<div class="note warn small">Falta para confirmar: ${esc(i.falta)}</div>` : ''}</td></tr>`).join('')}</tbody></table></div>` : '<p class="empty">Aún sin registro manual.</p>'}
      <h2 style="margin-top:22px">Librerías y clientes usados en el código</h2>
      <div class="twrap"><table><thead><tr><th>Módulo</th><th>Rol</th><th class="num">Llamadas</th><th class="num">Archivos</th><th>Paquetes</th></tr></thead><tbody>${integ.auto.modulos.slice(0, 80).map((m) => `<tr><td><b>${esc(m.nombre)}</b> <span class="muted2 small">${esc(m.modulo)}</span></td><td class="small">${esc(m.rol ?? '')}</td><td class="num">${fmt(m.llamadas)}</td><td class="num">${fmt(m.archivos)}</td><td class="small">${esc(m.paquetes.join(', '))}</td></tr>`).join('')}</tbody></table></div>
      <h2 style="margin-top:22px">Hosts externos referenciados</h2>
      <ul class="plain">${integ.auto.hosts.map((h) => `<li><code>${esc(h.host)}</code> <span class="small muted2">${h.nUsos} uso(s)</span> ${h.usos.slice(0, 2).map((u) => loc(u.archivo, u.linea, short(u.archivo, 2) + ':' + u.linea)).join(' ')}</li>`).join('')}</ul>
      ${integ.auto.dependenciasSinUso.length ? `<h2 style="margin-top:22px">Dependencias declaradas sin uso detectado</h2><p class="small muted2">Pueden ser plugins, tipos o cargarse por configuración.</p><ul class="plain">${integ.auto.dependenciasSinUso.slice(0, 80).map((d) => `<li><code>${esc(d.nombre)}</code> <span class="small muted2">${esc(d.declaradaEn.map((x) => x.paquete).join(', '))}</span></li>`).join('')}</ul>` : ''}`;
    } else {
      body = `<p class="lede">Solo nombres, nunca valores. «No documentada» = se lee en el código y no figura en ningún <code>.env*.example</code>.</p>
      <div class="twrap"><table><thead><tr><th>Variable</th><th>Paquetes</th><th>Documentada</th><th class="num">Usos</th><th>Primer uso</th></tr></thead><tbody>${entorno.variables.map((v) => `<tr><td class="mono">${esc(v.nombre)}</td><td class="small">${esc(v.paquetes.join(', '))}</td><td>${v.documentada ? '<span class="tag ok">sí</span>' : '<span class="tag warn">no</span>'}</td><td class="num">${v.nUsos}</td><td class="small">${loc(v.usos[0].archivo, v.usos[0].linea, short(v.usos[0].archivo, 2) + ':' + v.usos[0].linea)}</td></tr>`).join('')}</tbody></table></div>
      ${entorno.documentadasSinUso.length ? `<h2 style="margin-top:22px">Documentadas pero no leídas por el código</h2><ul class="plain">${entorno.documentadasSinUso.map((d) => `<li class="mono">${esc(d.nombre)} <span class="small muted2">${esc(d.documentadaEn.join(', '))}</span></li>`).join('')}</ul>` : ''}`;
    }
    el.querySelector('#body').innerHTML = body;
  };
  el.innerHTML = `<div class="page-head"><h1>Eventos e integraciones</h1></div><div id="tabs">${chips(TABS, tab, 't')}</div><div id="body"></div>`;
  el.querySelector('#tabs').addEventListener('click', (ev) => {
    const c = ev.target.closest('.chip');
    if (!c) return;
    setParams({ t: c.dataset.v });
    render(el, new URLSearchParams(location.hash.split('?')[1] ?? ''), { setParams });
  });
  draw();
}
