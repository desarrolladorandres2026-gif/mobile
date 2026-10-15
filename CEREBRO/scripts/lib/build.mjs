// Pipeline de construcción: inventario → hechos por archivo (completo o incremental) → enlace → instantánea atómica.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, SNAP_DIR, RUNTIME_DIR, CACHE_DIR, ensureDir, loadConfig, writeJsonAtomic, readJson, log, fmtMs, nowIso, gitInfo, shortHash, writeFileAtomic } from './util.mjs';
import { buildInventory, findExcludedDirs, readPackageManifests } from './inventory.mjs';
import { analyzePackage, dependentsOf, loadFactsCache, saveFactsCache, EXTRACTOR_VERSION } from './analyzer.mjs';
import { buildGraph } from './graph.mjs';
import { buildEndpoints } from './endpoints.mjs';
import { buildScreens, buildActions, ESTADOS } from './actions.mjs';
import * as dom from './domain.mjs';
import { buildAutoFindings, scanSecrets } from './findings.mjs';
import { buildCoverage, loadReviews } from './coverage.mjs';
import { buildManualLayer } from './manual.mjs';
import { diffSnapshots } from './history.mjs';
import { buildRoles } from './roles.mjs';

const HISTORY = path.join(DATA_DIR, 'historial.jsonl');
const KEEP_SNAPSHOTS = 3;

function readVerification() {
  return readJson(path.join(DATA_DIR, 'verificacion.json'), null);
}

/** Compacta aristas a filas para ahorrar espacio. */
function packEdges(graph) {
  const rows = [];
  for (const list of graph.edgesOut.values()) {
    for (const e of list) rows.push([e.de, e.a, e.tipo, e.conf === 'inferida' ? 'i' : 'e', e.linea ?? 0, e.via ?? '', e.uso ?? '']);
  }
  return rows;
}

function importGraph(factsMap) {
  const rows = [];
  for (const [f, fx] of factsMap) {
    for (const imp of fx.imports ?? []) {
      if (imp.interno && factsMap.has(imp.interno)) rows.push([f, imp.interno, imp.tipo, (imp.nombres ?? []).slice(0, 8).join(',')]);
    }
  }
  return rows;
}

export async function build({ modo = 'completo', origen = 'manual', archivosSospechosos = null, verbose = true } = {}) {
  const t0 = Date.now();
  const config = loadConfig();
  const errores = [];
  const fases = {};
  const fase = (n, t) => { fases[n] = Date.now() - t; if (verbose) log(`  · ${n}: ${fmtMs(Date.now() - t)}`); };

  let t = Date.now();
  const inventory = buildInventory(config);
  const invByPath = new Map(inventory.map((e) => [e.ruta, e]));
  const manifests = readPackageManifests(config);
  const excluidos = findExcludedDirs(config);
  fase('inventario', t);

  // ── hechos ──
  t = Date.now();
  const prevCache = modo === 'completo' ? new Map() : loadFactsCache();
  const factsMap = new Map();
  const infoPaquetes = {};
  const archivosCambiados = { nuevos: [], modificados: [], eliminados: [] };
  const astEntries = inventory.filter((e) => e.modo === 'ast');
  const hashAnterior = new Map([...prevCache].map(([f, fx]) => [f, fx.hash]));

  if (modo === 'completo' || !prevCache.size) {
    for (const pkg of config.paquetes) {
      const r = analyzePackage(pkg, inventory);
      for (const [k, v] of r.facts) factsMap.set(k, v);
      infoPaquetes[pkg.id] = r.info;
      for (const er of r.info.errores ?? []) errores.push({ fase: 'extraccion', ...er });
      if (verbose) log(`  · paquete ${pkg.id}: ${r.info.archivos} archivos (${fmtMs(r.info.programaMs + r.info.extraccionMs)})`);
    }
    if (modo !== 'completo') for (const e of astEntries) if (!hashAnterior.has(e.ruta)) archivosCambiados.nuevos.push(e.ruta);
  } else {
    // incremental
    for (const [f, fx] of prevCache) if (invByPath.has(f) && invByPath.get(f).modo === 'ast') factsMap.set(f, fx);
    for (const e of astEntries) {
      if (!hashAnterior.has(e.ruta)) archivosCambiados.nuevos.push(e.ruta);
      else if (hashAnterior.get(e.ruta) !== e.hash) archivosCambiados.modificados.push(e.ruta);
    }
    for (const f of hashAnterior.keys()) if (!invByPath.has(f) || invByPath.get(f).modo !== 'ast') archivosCambiados.eliminados.push(f);
    const base = new Set([...archivosCambiados.nuevos, ...archivosCambiados.modificados]);
    // Los eliminados invalidan a sus importadores.
    const tocados = new Set([...base, ...archivosCambiados.eliminados]);
    if (tocados.size) {
      const afectados = dependentsOf(tocados, prevCache);
      for (const f of archivosCambiados.eliminados) afectados.delete(f);
      const porPaquete = new Map();
      for (const f of afectados) {
        const e = invByPath.get(f);
        if (!e || e.modo !== 'ast') continue;
        if (!porPaquete.has(e.paquete)) porPaquete.set(e.paquete, new Set());
        porPaquete.get(e.paquete).add(f);
      }
      for (const [pid, files] of porPaquete) {
        const pkg = config.paquetes.find((p) => p.id === pid);
        if (!pkg) continue;
        const r = analyzePackage(pkg, inventory, files);
        for (const [k, v] of r.facts) factsMap.set(k, v);
        infoPaquetes[pid] = r.info;
        for (const er of r.info.errores ?? []) errores.push({ fase: 'extraccion', ...er });
        if (verbose) log(`  · paquete ${pid}: re-analizados ${r.info.archivos} archivos de ${files.size} afectados (${fmtMs(r.info.programaMs + r.info.extraccionMs)})`);
      }
      archivosCambiados.afectados = [...afectados].filter((f) => !base.has(f)).slice(0, 200);
    }
    for (const f of archivosCambiados.eliminados) factsMap.delete(f);
  }
  fase('hechos', t);

  // ── enlace ──
  t = Date.now();
  const graph = buildGraph(factsMap);
  const endpointData = buildEndpoints(factsMap, graph, config);
  const verificacion = readVerification();
  const rutasProbadas = verificacion?.rutasProbadas ? new Set(verificacion.rutasProbadas) : null;
  const screensData = buildScreens(factsMap, graph);
  const actions = buildActions(factsMap, graph, endpointData, screensData, rutasProbadas ? { rutasProbadas } : null);
  fase('grafo+endpoints+acciones', t);

  t = Date.now();
  const tokenIdx = dom.buildTokenIndex(factsMap);
  const models = dom.buildModels(factsMap, graph, endpointData, tokenIdx);
  const events = dom.buildEvents(factsMap);
  const jobs = dom.buildJobs(factsMap, graph);
  const env = dom.buildEnv(factsMap, inventory);
  const integrations = dom.buildIntegrations(factsMap, manifests);
  const tablas = dom.buildStateTables(factsMap, graph);
  const enumWrites = dom.buildEnumWrites(graph, ['OrderStatus', 'PaymentStatus', 'PayoutStatus', 'CommissionStatus', 'DriverStatus', 'RefundStatus', 'CashReconciliationStatus', 'CashIncidentStatus']);
  const dead = dom.buildDeadCode(factsMap, graph, tokenIdx);
  const cycles = dom.buildCycles(factsMap);
  const dups = dom.buildDuplicates(graph);
  const tests = dom.buildTests(factsMap);
  const secrets = scanSecrets(inventory);
  fase('dominio', t);

  t = Date.now();
  const manual = buildManualLayer(graph, inventory);
  const roles = buildRoles(factsMap, graph, endpointData, tablas, manual);
  const auto = buildAutoFindings({ inventory, factsMap, graph, endpointData, actions, screens: screensData.screens, models, events, jobs, env, integrations, dead, cycles, dups, tests, secrets, tokenIdx });
  const hallazgos = [...manual.hallazgos, ...auto];
  const reviews = loadReviews();
  const cobertura = buildCoverage(inventory, factsMap, reviews);
  fase('hallazgos+cobertura', t);

  // ── pruebas: resultados de ejecución si existen ──
  const testsConResultado = tests.map((tt) => {
    const r = verificacion?.archivos?.[tt.archivo];
    return r ? { ...tt, resultado: r } : tt;
  });

  // ── instantánea ──
  t = Date.now();
  const id = `${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}-${shortHash(Math.random().toString(), 5)}`;
  const dir = path.join(SNAP_DIR, id);
  ensureDir(dir);
  const simbolos = [...graph.symbols.values()].map((s) => {
    const { paquete, claseArchivo, ...rest } = s;
    return { ...rest, paq: paquete, clsArch: claseArchivo, entran: (graph.edgesIn.get(s.id) ?? []).length, salen: (graph.edgesOut.get(s.id) ?? []).length };
  });
  const porEstado = {};
  for (const a of actions) porEstado[a.estado] = (porEstado[a.estado] ?? 0) + 1;
  const sevCount = {};
  for (const h of hallazgos) sevCount[h.severidad] = (sevCount[h.severidad] ?? 0) + 1;

  const meta = {
    version: 1,
    id,
    generadoEn: nowIso(),
    modo,
    origen,
    extractor: EXTRACTOR_VERSION,
    git: gitInfo(),
    duracionMs: Date.now() - t0,
    fases,
    conteos: {
      archivos: inventory.length, archivosAnalizados: factsMap.size, simbolos: simbolos.length,
      aristas: [...graph.edgesOut.values()].reduce((a, b) => a + b.length, 0),
      endpoints: endpointData.endpoints.length, llamadasApi: endpointData.calls.length, pantallas: screensData.screens.length, acciones: actions.length,
      modelos: models.length, eventos: events.length, procesos: jobs.length, hallazgos: hallazgos.length, pruebas: tests.length,
    },
    acciones: porEstado,
    hallazgosPorSeveridad: sevCount,
    typescript: Object.fromEntries(Object.entries(infoPaquetes).map(([k, v]) => [k, v.typescript])),
    erroresProceso: errores,
    verificacion: verificacion ? { generadaEn: verificacion.generadaEn, resumen: verificacion.resumen } : null,
    limitaciones: [
      'El análisis es estático (AST + verificador de tipos de TypeScript): una arista «estática» prueba que el código la contiene, no que se ejecute.',
      'Las aristas marcadas «inferida» provienen de convenciones (props, react-query, stores, interfaces) y no están demostradas por tipos.',
      'El acceso dinámico (propiedades por string, registro en tiempo de ejecución, importaciones computadas) no se sigue.',
      'web/ y desktop/ no tienen node_modules instalados: se resuelven los símbolos propios, no los tipos de terceros.',
      'Los repositorios o servicios externos (Wompi, Cloudinary, Mapbox, proveedores) se registran como dependencias externas pendientes de analizar.',
    ],
    cobertura: cobertura.resumen.total,
  };

  const write = (name, data) => writeJsonAtomic(path.join(dir, name), data);
  write('meta.json', meta);
  write('inventario.json', { archivos: inventory.map(({ hash, ...r }) => ({ ...r, hash: hash.slice(0, 12) })), excluidos, exclusiones: config.excluirDelAnalisis, manifiestos: manifests, paquetes: config.paquetes });
  write('cobertura.json', cobertura);
  write('simbolos.json', simbolos);
  write('aristas.json', { columnas: ['de', 'a', 'tipo', 'conf', 'linea', 'via', 'uso'], filas: packEdges(graph) });
  write('archivos-grafo.json', { columnas: ['de', 'a', 'tipo', 'nombres'], filas: importGraph(factsMap) });
  write('endpoints.json', { endpoints: endpointData.endpoints, pruebasHttp: endpointData.testsHttp });
  write('llamadas-api.json', endpointData.calls);
  write('pantallas.json', { pantallas: screensData.screens });
  write('acciones.json', { estados: ESTADOS, acciones: actions });
  write('modelos.json', models);
  write('eventos.json', events);
  write('procesos.json', jobs);
  write('integraciones.json', { auto: integrations, manual: manual.integraciones });
  write('entorno.json', env);
  write('estados.json', { tablas: tablas.dominio, constantes: tablas.constantes, escriturasDeEstado: enumWrites, flujosNegocio: manual.flujosNegocio });
  write('roles.json', roles);
  write('dinero.json', { flujos: manual.flujosDinero, constantes: tablas.constantes.filter((c) => /FEE|RATE|BPS|COMMISSION|THRESHOLD|MIN_|MAX_|DEFAULT_/.test(c.nombre)) });
  write('hallazgos.json', hallazgos);
  write('pruebas.json', testsConResultado);
  write('codigo-sin-uso.json', dead);
  write('ciclos.json', cycles);
  write('duplicados.json', dups);
  write('resumen-manual.json', manual.resumen);

  // Historial: diferencia con la instantánea anterior.
  const prevPtr = readJson(path.join(DATA_DIR, 'actual.json'), null);
  let cambios = null;
  if (prevPtr) {
    try { cambios = diffSnapshots(path.join(SNAP_DIR, prevPtr.id), dir, archivosCambiados, invByPath, hashAnterior, modo); } catch (e) { errores.push({ fase: 'historial', error: String(e.message ?? e) }); }
  }
  if (cambios) cambios.deriva = modo === 'completo' && cambios.archivos.length === 0 && (cambios.simbolos.agregados.length > 0 || cambios.simbolos.eliminados.length > 0 || cambios.endpoints.agregados.length > 0 || cambios.endpoints.eliminados.length > 0);
  writeJsonAtomic(path.join(DATA_DIR, 'actual.json'), { id, generadoEn: meta.generadoEn, modo, origen });
  if (cambios && (cambios.deriva || cambios.archivos.length || cambios.simbolos.agregados.length || cambios.simbolos.eliminados.length || cambios.endpoints.agregados.length || cambios.endpoints.eliminados.length)) {
    cambios.origen = origen;
    cambios.instantanea = id;
    cambios.duracionMs = Date.now() - t0;
    cambios.errores = errores.slice(0, 20);
    ensureDir(DATA_DIR);
    fs.appendFileSync(HISTORY, JSON.stringify(cambios) + '\n');
  }
  saveFactsCache(factsMap);
  // Limpieza de instantáneas antiguas.
  try {
    const snaps = fs.readdirSync(SNAP_DIR).filter((d) => d !== id).map((d) => ({ d, t: fs.statSync(path.join(SNAP_DIR, d)).mtimeMs })).sort((a, b) => b.t - a.t);
    for (const s of snaps.slice(KEEP_SNAPSHOTS - 1)) fs.rmSync(path.join(SNAP_DIR, s.d), { recursive: true, force: true });
  } catch { /* ignorar */ }
  fase('escritura', t);
  meta.duracionMs = Date.now() - t0;
  return { meta, errores, archivosCambiados, cambios };
}
