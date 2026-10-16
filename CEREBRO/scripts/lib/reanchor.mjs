// Refresca los números de línea de las anclas manuales que solo se MOVIERON (el texto sigue existiendo).
// Nunca toca una ancla perdida: esa sí exige que una persona revise si el hallazgo o el flujo siguen vigentes.
import fs from 'node:fs';
import path from 'node:path';
import { MANUAL_DIR, readJson, writeJsonAtomic } from './util.mjs';
import { resolveRef } from './manual.mjs';

const FILES = ['hallazgos.json', 'flujos-dinero.json', 'flujos-negocio.json', 'integraciones.json', 'roles.json'];

export function reanchor({ aplicar = true } = {}) {
  const graph = { symbols: new Map() };
  const resumen = { movidas: 0, perdidas: [], ok: 0 };
  const visit = (refs, ctx, cambios) => {
    for (const r of refs ?? []) {
      if (!r.archivo || !r.ancla) continue;
      const { simbolo, ...sinSimbolo } = r;
      const res = resolveRef(sinSimbolo, graph, new Map());
      if (res.estadoRef === 'ok') resumen.ok++;
      else if (res.estadoRef === 'movida') { cambios.push([r, res.linea]); resumen.movidas++; }
      else if (res.estadoRef !== 'sin-ancla') resumen.perdidas.push(`${ctx}: ${r.archivo} «${r.ancla.slice(0, 50)}» (${res.estadoRef})`);
    }
  };
  for (const name of FILES) {
    const file = path.join(MANUAL_DIR, name);
    if (!fs.existsSync(file)) continue;
    const data = readJson(file, null);
    if (!data) continue;
    const cambios = [];
    for (const h of data.hallazgos ?? []) visit(h.evidencia, h.id, cambios);
    for (const f of data.flujos ?? []) for (const p of f.pasos ?? []) visit(p.refs, f.id, cambios);
    for (const i of data.integraciones ?? []) visit(i.evidencia, i.nombre, cambios);
    for (const n of data.notas ?? []) visit(n.refs, n.titulo, cambios);
    if (aplicar && cambios.length) {
      for (const [ref, linea] of cambios) ref.linea = linea;
      writeJsonAtomic(file, data, true);
    }
  }
  return resumen;
}
