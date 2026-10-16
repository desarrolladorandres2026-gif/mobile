// Orquestador de extracción: crea los programas TypeScript por paquete y extrae los hechos por archivo.
// Cache de hechos en disco para no re-analizar archivos que no cambiaron.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { abs, rel, CACHE_DIR, ensureDir, log, fmtMs, writeFileAtomic, ROOT } from './util.mjs';
import { createPackageContext, makeNamer, extractFile } from './extract/core.mjs';
import { extractRoutes } from './extract/routes.mjs';
import { extractModels } from './extract/models.mjs';
import { extractFrontendCalls } from './extract/frontend-api.mjs';
import { extractUi } from './extract/ui-actions.mjs';
import { extractMisc } from './extract/misc.mjs';
import { extractTables } from './extract/tables.mjs';

export const EXTRACTOR_VERSION = 17; // súbelo si cambia la forma de los hechos: invalida la caché

const FRONT_PKGS = new Set(['mobile', 'admin', 'business', 'web', 'desktop']);
const CACHE_FILE = path.join(CACHE_DIR, 'facts.json.gz');

export function loadFactsCache() {
  try {
    const raw = zlib.gunzipSync(fs.readFileSync(CACHE_FILE));
    const obj = JSON.parse(raw.toString('utf8'));
    if (obj.version !== EXTRACTOR_VERSION) return new Map();
    return new Map(Object.entries(obj.files));
  } catch {
    return new Map();
  }
}

export function saveFactsCache(factsMap) {
  ensureDir(CACHE_DIR);
  const files = Object.fromEntries(factsMap);
  const buf = zlib.gzipSync(Buffer.from(JSON.stringify({ version: EXTRACTOR_VERSION, files }), 'utf8'), { level: 3 });
  writeFileAtomic(CACHE_FILE, buf);
}

/** Extrae los hechos de un archivo con todos los extractores aplicables. */
function extractAllForFile(ctx, sf, entry, pkg) {
  const namer = ctx.namer;
  const facts = extractFile(ctx, sf, namer);
  facts.hash = entry.hash;
  facts.paquete = pkg.id;
  facts.clase = entry.clase;
  facts.lineas = entry.lineas;
  const f = entry.ruta;
  if (pkg.id === 'backend' && (/^backend\/src\/routes\//.test(f) || f === 'backend/src/app.ts')) {
    const r = extractRoutes(ctx, sf, namer, facts);
    if (r.rutas.length || r.montajes.length || r.middlewaresDeRouter.length || r.appRutas.length) facts.rutasHttp = r;
  }
  if (pkg.id === 'backend' && /^backend\/src\/models\//.test(f)) {
    const m = extractModels(ctx, sf, namer);
    if (m.length) facts.modelos = m;
  }
  if (FRONT_PKGS.has(pkg.id) && entry.clase !== 'prueba') {
    const calls = extractFrontendCalls(ctx, sf, namer);
    if (calls.length) facts.llamadasApi = calls;
    if (/\.(tsx|jsx)$/.test(f)) {
      const ui = extractUi(ctx, sf, namer);
      if (ui.elementos.length || ui.efectos.length || ui.rutasPantalla.length) facts.ui = ui;
    } else {
      const ui = extractUi(ctx, sf, namer);
      if (ui.efectos.length || ui.rutasPantalla.length) facts.ui = { elementos: [], efectos: ui.efectos, rutasPantalla: ui.rutasPantalla };
    }
  }
  const misc = extractMisc(ctx, sf, namer, entry.clase);
  const hasMisc = misc.eventos.length || misc.periodicos.length || misc.entorno.length || misc.hosts.length || misc.pruebas.nombres.length || misc.pruebas.http.length || misc.salas.length;
  if (hasMisc) facts.misc = misc;
  if (entry.clase !== 'prueba') {
    const t = extractTables(ctx, sf, namer, facts);
    if (t.length) facts.tablas = t;
  }
  return facts;
}

/**
 * Analiza los archivos AST de un paquete.
 * `onlyFiles`: si se da, solo se extraen esos (el programa igualmente incluye todos para resolver tipos).
 */
export function analyzePackage(pkg, entries, onlyFiles = null) {
  const astFiles = entries.filter((e) => e.paquete === pkg.id && e.modo === 'ast');
  if (!astFiles.length) return { facts: new Map(), info: { archivos: 0 } };
  const t0 = Date.now();
  const ctx = createPackageContext(pkg, astFiles.map((e) => e.ruta));
  ctx.namer = makeNamer(ctx.ts);
  const tProg = Date.now() - t0;
  const facts = new Map();
  const errores = [];
  const t1 = Date.now();
  for (const e of astFiles) {
    if (onlyFiles && !onlyFiles.has(e.ruta)) continue;
    const sf = ctx.program.getSourceFile(abs(e.ruta));
    if (!sf) {
      errores.push({ archivo: e.ruta, error: 'TypeScript no incluyó el archivo en el programa' });
      continue;
    }
    try {
      facts.set(e.ruta, extractAllForFile(ctx, sf, e, pkg));
    } catch (err) {
      errores.push({ archivo: e.ruta, error: String(err && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : err) });
    }
  }
  const info = {
    archivos: facts.size,
    programaMs: tProg,
    extraccionMs: Date.now() - t1,
    typescript: `${ctx.tsVersion} (de ${ctx.tsFrom})`,
    erroresConfig: ctx.configErrors,
    errores,
  };
  return { facts, info };
}

/** Dependientes directos (importadores) de un conjunto de archivos, atravesando barriles. */
export function dependentsOf(changedFiles, factsMap) {
  const importers = new Map(); // archivo -> Set(archivos que lo importan)
  for (const [f, fx] of factsMap) {
    for (const imp of fx.imports ?? []) {
      if (!imp.interno) continue;
      if (!importers.has(imp.interno)) importers.set(imp.interno, new Set());
      importers.get(imp.interno).add(f);
    }
  }
  const result = new Set(changedFiles);
  const queue = [...changedFiles];
  let first = true;
  while (queue.length) {
    const f = queue.shift();
    for (const imp of importers.get(f) ?? []) {
      if (result.has(imp)) continue;
      result.add(imp);
      // Solo se atraviesa transitivamente cuando el importador es un barril (solo reexporta).
      if (factsMap.get(imp)?.reexportSolo) queue.push(imp);
    }
    first = false;
  }
  return result;
}
