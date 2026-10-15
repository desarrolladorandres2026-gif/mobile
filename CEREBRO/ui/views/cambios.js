// Historial de cambios detectados, con impacto y el nivel de certeza de cada uno.
import { esc, A, fmt, ago, fmtDate, loc, symLink } from '../lib.js';

const NIVEL = [['detectado', 'Detectado en el código'], ['analizado', 'Analizado (mapa actualizado)'], ['probado', 'Probado (pruebas ejecutadas tras el cambio)'], ['verificadoEnEjecucion', 'Verificado en ejecución real']];

export default async function render(el) {
  const hist = await A('/api/historial?n=150');
  el.innerHTML = `<div class="page-head"><h1>Cambios</h1><p class="lede">Cada actualización de CEREBRO registra qué archivos cambiaron y qué parte de la arquitectura documentada cambia con ellos. Los cuatro niveles no se confunden: que el código cambie no lo marca como probado.</p></div>
  ${hist.length ? hist.map((h) => `<div class="section" style="margin-top:22px;border-top:1px solid var(--line-soft);padding-top:14px">
    <div style="display:flex;gap:14px;align-items:baseline;flex-wrap:wrap"><h3>${esc(fmtDate(h.ts))}</h3><span class="small muted2">${esc(ago(h.ts))} · ${esc(h.tipo)} · ${esc(h.origen ?? '')} · instantánea ${esc(h.instantanea ?? '')}</span>
    ${h.finanzas?.reglaFinancieraCambio ? '<span class="tag warn">toca el dominio financiero</span>' : ''} ${h.endpoints?.contratoCambiado ? '<span class="tag warn">contrato de API distinto</span>' : ''}</div>
    <div class="split" style="margin-top:8px">
      <div><h2>Archivos (${h.archivos.length})</h2><ul class="plain">${h.archivos.slice(0, 18).map((a) => `<li><span class="tag ${a.accion === 'eliminado' ? 'bad' : a.accion === 'nuevo' ? 'ok' : a.accion === 'renombrado' ? 'info' : ''}">${esc(a.accion)}</span> ${loc(a.ruta, 1, a.ruta)}${a.anterior ? ` <span class="small muted2">antes ${esc(a.anterior)}</span>` : ''}${a.lineas ? ` <span class="small muted2">${a.lineas[0] ?? '—'} → ${a.lineas[1] ?? '—'} líneas</span>` : ''}</li>`).join('')}${h.archivos.length > 18 ? `<li class="muted2">… ${h.archivos.length - 18} más</li>` : ''}</ul></div>
      <div><h2>Efecto en el mapa</h2><ul class="plain">
        <li>Símbolos: <b>+${h.simbolos.agregados.length}</b> / <b>−${h.simbolos.eliminados.length}</b>${h.simbolos.renombradosProbables.length ? ` · ${h.simbolos.renombradosProbables.length} renombres probables` : ''} · ${h.simbolos.cuerpoCambiado} con cuerpo distinto</li>
        <li>Endpoints: <b>+${h.endpoints.agregados.length}</b> / <b>−${h.endpoints.eliminados.length}</b>${h.endpoints.guardasCambiadas.length ? ` · ${h.endpoints.guardasCambiadas.length} con guardas distintas` : ''}</li>
        <li>Controles de interfaz: +${h.acciones.agregadas} / −${h.acciones.eliminadas}${h.acciones.cambiosDeEstado.length ? ` · ${h.acciones.cambiosDeEstado.length} cambiaron de estado` : ''}</li>
        ${h.impacto.importadoresDirectos.length ? `<li>Importadores directos a revisar: ${h.impacto.importadoresDirectos.length}</li>` : ''}
        ${h.impacto.endpointsAfectados.length ? `<li>Endpoints cuyo alcance toca estos archivos: ${h.impacto.endpointsAfectados.length}</li>` : ''}
      </ul>
      ${h.simbolos.eliminados.length ? `<p class="small muted2" style="margin-top:6px">Eliminados: ${h.simbolos.eliminados.slice(0, 6).map((s) => `<code>${esc(s.id.split('#')[1])}</code>`).join(' ')}</p>` : ''}
      ${h.finanzas?.constantesCambiadas?.length ? `<div class="note warn" style="margin-top:6px">Constantes financieras: ${h.finanzas.constantesCambiadas.map((c) => `<code>${esc(c.id.split('#')[1])}</code> ${esc(c.antes)} → ${esc(c.despues)}`).join('; ')}</div>` : ''}
      ${h.errores?.length ? `<div class="note bad" style="margin-top:6px">${h.errores.length} error(es) en el proceso.</div>` : ''}
      <div class="legend" style="margin-top:8px">${NIVEL.map(([k, t]) => `<span><i style="background:${h.niveles?.[k] ? 'var(--ok)' : 'var(--line)'}"></i>${esc(t)}</span>`).join('')}</div></div>
    </div></div>`).join('') : '<p class="empty">Aún no hay cambios registrados: el historial empieza a llenarse a partir de la segunda actualización.</p>'}`;
}
