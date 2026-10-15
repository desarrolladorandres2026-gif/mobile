// Estado del vigilante, de la instantánea, de la verificación por ejecución y de las dependencias del propio CEREBRO.
import { esc, A, D, fmt, ago, fmtDate, state, loc } from '../lib.js';

export default async function render(el) {
  const [est, fr, ver, pruebas] = await Promise.all([A('/api/estado'), A('/api/frescura').catch(() => null), A('/api/verificacion').catch(() => ({})), D('pruebas')]);
  const m = est.meta;
  const st = est.estadoVigilante;
  const activo = est.vigilante === 'activo';
  const r = ver.resumen;
  el.innerHTML = `
  <div class="page-head"><h1>Sistema y vigilante</h1><p class="lede">Para que el mapa se mantenga solo, el proceso del vigilante debe seguir ejecutándose (<code>node CEREBRO/scripts/cerebro.mjs iniciar</code>). Si se detiene, el mapa deja de actualizarse y esta pantalla lo dirá.</p></div>
  <div class="grid2">
    <div><h2>Vigilante</h2>
      <dl class="kv">
        <dt>Estado</dt><dd>${activo ? '<span class="tag ok">activo</span>' : '<span class="tag bad">detenido</span>'}</dd>
        <dt>Fase</dt><dd>${esc(st?.fase ?? '—')}</dd>
        <dt>Tareas pendientes</dt><dd>${fmt(st?.pendientes ?? 0)} ${st?.pendientesLista?.length ? '<span class="small muted2">' + st.pendientesLista.slice(0, 4).map(esc).join(', ') + '</span>' : ''}</dd>
        <dt>Última actualización</dt><dd>${esc(fmtDate(st?.ultimaActualizacion ?? m?.generadoEn))}</dd>
        <dt>Último ciclo</dt><dd>${st?.ultimoCiclo ? `${esc(st.ultimoCiclo.tipo)} · ${(st.ultimoCiclo.duracionMs / 1000).toFixed(1)} s · ${st.ultimoCiclo.cambios} cambio(s)` : '—'}</dd>
        <dt>Próxima reconstrucción completa</dt><dd>${esc(fmtDate(st?.proximaCompleta))}</dd>
        <dt>Proceso</dt><dd>pid ${esc(st?.pid ?? '—')} · latido ${esc(ago(st?.latido))}</dd>
        <dt>Último error</dt><dd>${st?.error ? `<span class="sev-ALTO">${esc(st.error)}</span>` : '<span class="muted2">ninguno</span>'}</dd>
      </dl>
      <p class="small muted2" style="margin-top:10px">Cambios en <code>CEREBRO/</code> se ignoran a propósito para evitar bucles; los cambios en <code>CEREBRO/manual/</code> sí disparan un reenlace.</p>
    </div>
    <div><h2>Instantánea vigente</h2>
      <dl class="kv"><dt>Id</dt><dd><code>${esc(m?.id)}</code></dd><dt>Generada</dt><dd>${esc(fmtDate(m?.generadoEn))} · ${esc(m?.modo)}</dd><dt>Duración</dt><dd>${((m?.duracionMs ?? 0) / 1000).toFixed(1)} s</dd><dt>Git</dt><dd><code>${esc((m?.git?.head ?? '').slice(0, 9))}</code> ${esc(m?.git?.branch ?? '')} · ${m?.git?.archivosConCambiosSinCommit ?? '?'} sin commit</dd>
      <dt>Desfase con el disco</dt><dd>${fr?.total ? `<span class="tag warn">${fr.total} archivo(s) más nuevos que la instantánea</span>` : '<span class="tag ok">sin desfase</span>'}</dd>
      <dt>TypeScript</dt><dd class="small">${Object.entries(m?.typescript ?? {}).map(([k, v]) => `${esc(k)} ${esc(v)}`).join(' · ')}</dd></dl>
      ${fr?.archivos?.length ? `<ul class="plain" style="margin-top:8px">${fr.archivos.slice(0, 10).map((f) => `<li>${loc(f, 1, f)}</li>`).join('')}</ul>` : ''}
    </div>
  </div>
  <div class="section"><h2>Verificación por ejecución</h2>
    ${r ? `<dl class="kv"><dt>Ejecutada</dt><dd>${esc(fmtDate(ver.generadaEn))}</dd>${Object.entries(r).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${typeof v === 'object' ? esc(JSON.stringify(v)) : esc(v)}</dd>`).join('')}</dl>
      ${ver.suites?.map((s) => `<p class="small"><b>${esc(s.paquete)}</b> · <code>${esc(s.comando)}</code> · ${s.codigoSalida === 0 ? '<span class="tag ok">verde</span>' : '<span class="tag bad">falló</span>'} ${s.resumen ? esc(JSON.stringify(s.resumen)) : ''} ${s.nota ? '· ' + esc(s.nota) : ''}</p>`).join('') ?? ''}`
      : `<p class="note warn">Todavía no se ha ejecutado ninguna suite desde CEREBRO. Hasta entonces ninguna acción puede llegar a «Funcional y verificada». Ejecuta <code>node CEREBRO/scripts/cerebro.mjs verificar</code>.</p>`}
    <p class="small muted2">Las pruebas usan MongoDB en memoria (<code>mongodb-memory-server</code>) y no tocan Atlas ni producción. No se hacen cobros, reembolsos ni escrituras reales.</p>
  </div>
  <div class="section"><h2>Errores del proceso</h2>${m?.erroresProceso?.length ? `<ul class="plain">${m.erroresProceso.map((e) => `<li class="note bad small">${esc(e.fase)} · ${esc(e.archivo ?? '')} · ${esc(e.error)}</li>`).join('')}</ul>` : '<p class="empty">Ninguno en la última construcción.</p>'}</div>
  <div class="section"><h2>Fases de la última construcción</h2><dl class="kv">${Object.entries(m?.fases ?? {}).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${(v / 1000).toFixed(2)} s</dd>`).join('')}</dl></div>
  <div class="section"><h2>Pruebas del proyecto</h2><p class="muted2">${fmt(pruebas.length)} archivos de prueba · ${fmt(pruebas.reduce((a, p) => a + p.casos, 0))} casos · ${fmt(pruebas.filter((p) => p.http).length)} con peticiones HTTP · ${fmt(pruebas.reduce((a, p) => a + p.omitidas + p.pendientes, 0))} omitidos o pendientes.</p></div>`;
}
