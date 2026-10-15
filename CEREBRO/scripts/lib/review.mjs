// Registro de lecturas: qué rangos de qué archivos ha leído una persona o agente, atados al hash del contenido.
// Si el archivo cambia, la lectura queda «obsoleta» y el rango vuelve a figurar como pendiente.
import fs from 'node:fs';
import path from 'node:path';
import { MANUAL_DIR, abs, sha1, readJson, writeJsonAtomic, nowIso, countLines } from './util.mjs';

const FILE = path.join(MANUAL_DIR, 'revisiones.json');

/** reviews: [{archivo, rangos:[[a,b]] | 'todo', nota?, revisor?}] */
export function addReviews(reviews, defaults = {}) {
  const data = readJson(FILE, { version: 1, revisiones: [] });
  let n = 0;
  for (const r of reviews) {
    const full = abs(r.archivo);
    if (!fs.existsSync(full)) { console.error(`  (omitido, no existe) ${r.archivo}`); continue; }
    const buf = fs.readFileSync(full);
    const total = countLines(buf.toString('utf8'));
    const rangos = r.rangos === 'todo' || !r.rangos ? [[1, total]] : r.rangos.map(([a, b]) => [Math.max(1, a), Math.min(total, b)]);
    const hash = sha1(buf);
    // Sustituye lecturas anteriores del mismo archivo con hash distinto (obsoletas) y fusiona las vigentes.
    data.revisiones = data.revisiones.filter((x) => !(x.archivo === r.archivo && x.hash !== hash));
    data.revisiones.push({ archivo: r.archivo, rangos, hash, revisor: r.revisor ?? defaults.revisor ?? 'claude', fecha: nowIso(), nota: r.nota ?? defaults.nota ?? null, nivel: r.nivel ?? 'lectura' });
    n++;
  }
  writeJsonAtomic(FILE, data, true);
  return n;
}

export function addReview(args) {
  const [archivo, rango, ...nota] = args;
  if (!archivo) { console.log('Uso: revisar <archivo> [desde-hasta|todo] [nota…]'); return; }
  let rangos = 'todo';
  if (rango && rango !== 'todo') { const m = /^(\d+)-(\d+)$/.exec(rango); if (!m) { console.error('Rango inválido, usa 120-240 o «todo».'); return; } rangos = [[Number(m[1]), Number(m[2])]]; }
  const n = addReviews([{ archivo, rangos, nota: nota.join(' ') || null }], { revisor: process.env.CEREBRO_REVISOR ?? 'manual' });
  console.log(`Registrada ${n} lectura de ${archivo}.`);
}
