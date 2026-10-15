// Resumen: alcance real del análisis, cobertura, estado de las acciones, hallazgos y últimos cambios.
import { esc, D, A, fmt, pct, bar, ago, fmtDate, state, ESTADO_LABEL } from '../lib.js';

const COLOR = { verificada: '#34D399', pendiente: '#7DB4FF', parcial: '#F59E0B', desconectada: '#F87171', sin_implementar: '#FB923C', con_errores: '#EF4444', no_aplica: '#475068' };

export default async function render(el) {
  const m = state.meta;
  const [cob, hall, hist, est] = await Promise.all([D('cobertura'), D('hallazgos'), A('/api/historial?n=6'), A('/api/estado')]);
  const t = cob.resumen.total;
  const sev = {};
  for (const h of hall) sev[h.severidad] = (sev[h.severidad] ?? 0) + 1;
  const confirmados = hall.filter((h) => h.confianza === 'confirmado').length;
  const acc = m.acciones ?? {};
  const paquetes = Object.entries(cob.resumen.porPaquete).filter(([, v]) => v.analizables > 0).sort((a, b) => b[1].lineasAnalizables - a[1].lineasAnalizables);
  el.innerHTML = `
  <div class="page-head"><h1>ZIPP, de punta a punta</h1><p class="lede">Mapa derivado del código real. Cada cifra sale de la instantánea <code>${esc(m.id)}</code>; lo que no está demostrado se marca como inferido o pendiente.</p></div>

  <div class="kpis">
    <div class="kpi gold"><b>${fmt(m.conteos.archivos)}</b><span>archivos inventariados</span></div>
    <div class="kpi"><b>${fmt(m.conteos.simbolos)}</b><span>símbolos</span></div>
    <div class="kpi"><b>${fmt(m.conteos.aristas)}</b><span>conexiones</span></div>
    <div class="kpi"><b>${fmt(m.conteos.endpoints)}</b><span>endpoints</span></div>
    <div class="kpi"><b>${fmt(m.conteos.acciones)}</b><span>controles de interfaz</span></div>
    <div class="kpi"><b>${fmt(m.conteos.modelos)}</b><span>modelos</span></div>
    <div class="kpi ${(sev.CRITICO ?? 0) + (sev.ALTO ?? 0) ? 'bad' : ''}"><b>${fmt(hall.length)}</b><span>hallazgos (${fmt(confirmados)} confirmados)</span></div>
  </div>

  <div class="section"><h2>Qué tan lejos llega el análisis</h2>
    <p class="lede">Tres niveles que no se mezclan: <b>inventariado</b> (el archivo existe y se conoce su tamaño), <b>indexado</b> (un analizador automático lo procesó) y <b>auditado</b> (alguien leyó esas líneas y el contenido sigue igual). Que algo esté indexado no significa que se haya comprendido.</p>
    <div class="kpis" style="margin:12px 0 18px">
      <div class="kpi"><b>${pct(t.archivos - t.excluidos, t.archivos)}</b><span>de los archivos son analizables (${fmt(t.excluidos)} excluidos y justificados)</span></div>
      <div class="kpi ok"><b>${pct(t.indexadasLineas, t.lineasAnalizables)}</b><span>de las líneas analizables, indexadas por AST/texto</span></div>
      <div class="kpi ${t.auditadasLineas ? 'gold' : 'warn'}"><b>${pct(t.auditadasLineas, t.lineasAnalizables)}</b><span>auditadas por lectura (${fmt(t.auditadasLineas)} líneas)</span></div>
    </div>
    <div class="twrap"><table><thead><tr><th>Paquete</th><th class="num">Archivos</th><th class="num">Líneas</th><th>Indexado</th><th>Auditado</th></tr></thead><tbody>
    ${paquetes.map(([p, v]) => `<tr><td><b>${esc(p)}</b></td><td class="num">${fmt(v.analizables)}</td><td class="num">${fmt(v.lineasAnalizables)}</td><td style="min-width:180px">${bar([{ t: 'indexadas', n: v.indexadasLineas, c: '#D69E26' }, { t: 'sin indexar', n: Math.max(0, v.lineasAnalizables - v.indexadasLineas), c: '#232E46' }]).split('<div class="legend">')[0]}<span class="small muted2">${pct(v.indexadasLineas, v.lineasAnalizables)}</span></td><td style="min-width:180px">${bar([{ t: 'auditadas', n: v.auditadasLineas, c: '#34D399' }, { t: 'pendientes', n: Math.max(0, v.lineasAnalizables - v.auditadasLineas), c: '#232E46' }]).split('<div class="legend">')[0]}<span class="small muted2">${pct(v.auditadasLineas, v.lineasAnalizables)}</span></td></tr>`).join('')}
    </tbody></table></div>
    <p class="small muted2" style="margin-top:8px">El análisis <b>no se declara completo</b> mientras queden líneas sin auditar. <a href="#/cobertura">Ver el registro por archivo y los rangos pendientes</a>.</p>
  </div>

  <div class="grid2 section">
    <div><h2>Estado de los controles de interfaz</h2>
      ${bar(Object.entries(acc).map(([k, n]) => ({ t: ESTADO_LABEL[k] ?? k, n, c: COLOR[k] ?? '#888' })))}
      <p class="small muted2" style="margin-top:8px">«Pendiente de verificación» significa que la cadena existe de punta a punta en el código pero ninguna ejecución la ha demostrado. <a href="#/acciones">Ver todos</a>.</p>
    </div>
    <div><h2>Hallazgos por gravedad</h2>
      ${bar([{ t: 'Crítico', n: sev.CRITICO ?? 0, c: '#FF6B6B' }, { t: 'Alto', n: sev.ALTO ?? 0, c: '#F87171' }, { t: 'Medio', n: sev.MEDIO ?? 0, c: '#F59E0B' }, { t: 'Bajo', n: sev.BAJO ?? 0, c: '#6B7896' }])}
      <p class="small muted2" style="margin-top:8px">Se distingue error confirmado, riesgo probable e hipótesis a verificar. <a href="#/hallazgos">Ver hallazgos</a>.</p>
    </div>
  </div>

  <div class="grid2 section">
    <div><h2>Últimos cambios detectados</h2>
      ${hist.length ? `<ul class="plain">${hist.map((h) => `<li><span class="small muted2">${esc(ago(h.ts))}</span> ${esc(h.archivos.length)} archivo(s) · ${esc(h.paquetes.join(', ') || '—')} ${h.finanzas?.reglaFinancieraCambio ? '<span class="tag warn">toca finanzas</span>' : ''} ${h.endpoints?.contratoCambiado ? '<span class="tag warn">contrato de API</span>' : ''}</li>`).join('')}</ul><p class="small"><a href="#/cambios">Historial completo</a></p>` : '<p class="empty">Aún no se ha detectado ningún cambio desde la primera construcción.</p>'}
    </div>
    <div><h2>Proceso</h2>
      <dl class="kv">
        <dt>Última actualización</dt><dd>${esc(fmtDate(m.generadoEn))} · ${esc(m.modo)} · ${(m.duracionMs / 1000).toFixed(1)} s</dd>
        <dt>Vigilante</dt><dd>${est.vigilante === 'activo' ? '<span class="tag ok">activo</span>' : '<span class="tag bad">detenido</span> arráncalo con <code>iniciar</code>'}</dd>
        <dt>Errores del proceso</dt><dd>${m.erroresProceso?.length ? `<span class="tag bad">${m.erroresProceso.length}</span>` : '<span class="tag ok">ninguno</span>'}</dd>
        <dt>Pruebas ejecutadas</dt><dd>${m.verificacion ? `${esc(fmtDate(m.verificacion.generadaEn))}` : '<span class="tag warn">sin ejecución registrada</span> <code>verificar</code>'}</dd>
        <dt>Commit</dt><dd><code>${esc((m.git?.head ?? '').slice(0, 9))}</code> ${esc(m.git?.branch ?? '')} · ${m.git?.archivosConCambiosSinCommit ?? '?'} archivos con cambios sin commit</dd>
      </dl>
    </div>
  </div>

  <div class="section"><h2>Limitaciones declaradas</h2><ul class="plain">${(m.limitaciones ?? []).map((l) => `<li class="note">${esc(l)}</li>`).join('')}</ul></div>`;
}
