// Modelos de datos: qué los lee y escribe, relaciones y campos con menciones por capa.
import { esc, D, fmt, pager, loc } from '../lib.js';

export default async function render(el) {
  const ms = await D('modelos');
  const sorted = [...ms].sort((a, b) => a.nombre.localeCompare(b.nombre));
  el.innerHTML = `
  <div class="page-head"><h1>Modelos de datos</h1><p class="lede">Colecciones de MongoDB definidas con Mongoose. «Escritores» y «lectores» son las funciones de producción con una llamada resuelta al modelo (incluye <code>.save()</code> sobre documentos); no incluyen consultas armadas dinámicamente.</p></div>
  <div class="kpis" style="margin-bottom:14px">
    <div class="kpi"><b>${fmt(ms.length)}</b><span>modelos</span></div>
    <div class="kpi"><b>${fmt(ms.reduce((a, m) => a + m.campos.length, 0))}</b><span>campos</span></div>
    <div class="kpi"><b>${fmt(ms.reduce((a, m) => a + m.indices.length, 0))}</b><span>índices explícitos</span></div>
    <div class="kpi ${ms.filter((m) => !m.escritores.length).length ? 'warn' : ''}"><b>${fmt(ms.filter((m) => !m.escritores.length).length)}</b><span>sin escritores en producción</span></div>
  </div>
  <div id="tbl"></div>`;
  pager(el.querySelector('#tbl'), sorted, (m) => `<tr class="row" data-open="modelo" data-id="${esc(m.simbolo)}"><td><b>${esc(m.nombre)}</b></td><td class="num">${m.campos.length}</td><td class="num">${m.indices.length}</td><td class="num">${m.escritores.length}</td><td class="num">${m.lectores.length}</td><td class="num">${m.endpointsEscriben.length}</td><td class="small clip">${esc(m.refs.join(', '))}</td><td class="small clip">${esc(m.refPor.join(', '))}</td><td class="small">${loc(m.archivo, m.linea, m.archivo.split('/').pop() + ':' + m.linea)}</td></tr>`, {
    step: 200, header: '<thead><tr><th>Modelo</th><th class="num">Campos</th><th class="num">Índices</th><th class="num">Escritores</th><th class="num">Lectores</th><th class="num">Endpoints que escriben</th><th>Referencia a</th><th>Referenciado por</th><th>Definición</th></tr></thead>',
  });
}
