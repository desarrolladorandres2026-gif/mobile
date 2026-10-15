// Comprobación de coherencia de lo generado: ficheros, referencias al código y datos que lee la interfaz.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, SNAP_DIR, ROOT, abs, readJson, countLines } from './util.mjs';

export async function check() {
  const out = [];
  const ok = (m) => out.push(['OK ', m]);
  const bad = (m) => out.push(['MAL', m]);
  const warn = (m) => out.push(['AVISO', m]);
  const cur = readJson(path.join(DATA_DIR, 'actual.json'), null);
  if (!cur) { bad('No hay instantánea vigente (data/actual.json). Ejecuta «construir».'); return print(out); }
  const dir = path.join(SNAP_DIR, cur.id);
  const need = ['meta', 'inventario', 'cobertura', 'simbolos', 'aristas', 'archivos-grafo', 'endpoints', 'llamadas-api', 'pantallas', 'acciones', 'modelos', 'eventos', 'procesos', 'integraciones', 'entorno', 'estados', 'roles', 'dinero', 'hallazgos', 'pruebas', 'codigo-sin-uso', 'ciclos', 'duplicados'];
  const D = {};
  for (const n of need) {
    const f = path.join(dir, `${n}.json`);
    if (!fs.existsSync(f)) { bad(`falta ${n}.json`); continue; }
    try { D[n] = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { bad(`${n}.json no es JSON válido: ${e.message}`); }
  }
  ok(`${Object.keys(D).length}/${need.length} conjuntos de datos presentes y legibles (instantánea ${cur.id})`);

  // 1) referencias a código: archivo existe y la línea cae dentro del archivo
  const lineCache = new Map();
  const lines = (f) => { if (!lineCache.has(f)) { try { lineCache.set(f, countLines(fs.readFileSync(abs(f), 'utf8'))); } catch { lineCache.set(f, null); } } return lineCache.get(f); };
  let sBad = 0;
  for (const s of D.simbolos ?? []) {
    const n = lines(s.archivo);
    if (n == null) { sBad++; if (sBad < 6) bad(`símbolo con archivo inexistente: ${s.id}`); }
    else if (s.linea < 1 || s.linea > n + 1 || s.lineaFin > n + 1) { sBad++; if (sBad < 6) bad(`línea fuera de rango: ${s.id} (${s.linea}-${s.lineaFin}, archivo de ${n})`); }
  }
  sBad ? bad(`${sBad} símbolos con referencia inválida`) : ok(`${D.simbolos?.length} símbolos: archivo y líneas válidos`);

  const symIds = new Set((D.simbolos ?? []).map((s) => s.id));
  let eBad = 0;
  for (const [de, a] of D.aristas?.filas ?? []) if (!symIds.has(de) || !symIds.has(a)) eBad++;
  eBad ? bad(`${eBad} aristas apuntan a símbolos inexistentes`) : ok(`${D.aristas?.filas.length} aristas: todos los extremos existen`);

  let epBad = 0;
  for (const e of D.endpoints?.endpoints ?? []) { if (e.manejador && !symIds.has(e.manejador)) epBad++; if (lines(e.archivo) == null) epBad++; }
  epBad ? bad(`${epBad} endpoints con referencias rotas`) : ok(`${D.endpoints?.endpoints.length} endpoints: manejador y archivo existen`);

  let aBad = 0;
  for (const a of D.acciones?.acciones ?? []) { if (lines(a.archivo) == null) aBad++; for (const m of a.manejadores) if (!symIds.has(m)) aBad++; }
  aBad ? bad(`${aBad} referencias rotas en acciones`) : ok(`${D.acciones?.acciones.length} acciones: archivo y manejadores existen`);

  // 2) hallazgos: evidencia localizable
  let hBad = 0; let hStale = 0;
  for (const h of D.hallazgos ?? []) for (const ev of h.evidencia ?? []) { const n = lines(ev.archivo); if (n == null) hBad++; else if (ev.linea && ev.linea > n + 1) hBad++; if (ev.estadoRef && !['ok', 'sin-ancla'].includes(ev.estadoRef)) hStale++; }
  hBad ? bad(`${hBad} evidencias de hallazgos no localizables`) : ok(`${D.hallazgos?.length} hallazgos: toda la evidencia es localizable`);
  hStale ? warn(`${hStale} anclas manuales movidas o perdidas (marcadas «revisar»)`) : ok('anclas manuales: todas vigentes');

  // 3) flujos manuales
  let fBad = 0;
  for (const fl of [...(D.dinero?.flujos ?? []), ...(D.estados?.flujosNegocio ?? [])]) fBad += fl.referenciasRotas ?? 0;
  fBad ? warn(`${fBad} referencias de flujos documentados ya no coinciden con el código (pendientes de revisión)`) : ok('flujos documentados: referencias vigentes');

  // 4) cobertura: invariantes
  const t = D.cobertura?.resumen.total;
  if (t) {
    t.indexadasLineas > t.lineasAnalizables ? bad('cobertura: más líneas indexadas que analizables') : ok(`cobertura: ${t.indexadosArchivos}/${t.analizables} archivos analizables con hechos; ${t.auditadosArchivos} con lectura registrada`);
    if (t.sinHechos) warn(`${t.sinHechos} archivos analizables sin hechos (ver Cobertura)`);
  }
  // 5) inventario vs disco
  let inv = 0;
  for (const f of D.inventario?.archivos ?? []) if (!fs.existsSync(abs(f.ruta))) inv++;
  inv ? warn(`${inv} archivos del inventario ya no existen en disco (cambios posteriores a la instantánea)`) : ok('inventario: todos los archivos existen en disco');
  // 6) bucles: el vigilante ignora CEREBRO/
  const w = fs.readFileSync(path.join(ROOT, 'CEREBRO', 'scripts', 'lib', 'watch.mjs'), 'utf8');
  /parts\[0\] === 'CEREBRO'/.test(w) ? ok('vigilante: ignora CEREBRO/ (solo reacciona a CEREBRO/manual/*.json)') : bad('vigilante: no se encontró la exclusión de CEREBRO/');
  // 7) secretos en datos generados
  const sample = fs.readFileSync(path.join(dir, 'hallazgos.json'), 'utf8');
  /mongodb(\+srv)?:\/\/[^\s"']+:[^\s"']+@/.test(sample) || /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(sample) ? bad('los hallazgos contienen un posible secreto sin enmascarar') : ok('hallazgos: sin secretos en claro');
  print(out);
}

function print(out) {
  for (const [k, m] of out) console.log(`${k.padEnd(5)} ${m}`);
  const malos = out.filter(([k]) => k === 'MAL').length;
  console.log(malos ? `\n${malos} comprobación(es) fallida(s).` : '\nTodas las comprobaciones críticas pasan.');
  if (malos) process.exitCode = 1;
}
