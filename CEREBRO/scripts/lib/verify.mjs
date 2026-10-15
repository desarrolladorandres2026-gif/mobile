// Verificación por ejecución: corre las comprobaciones seguras del repo y guarda la evidencia por archivo de prueba.
//
// Garantías de seguridad:
//   · las suites de ZIPP usan MongoDB en memoria; aquí además se aíslan las variables de entorno sensibles con valores
//     inertes para que ningún módulo pueda llegar a Atlas, Wompi, Cloudinary, Mapbox, correo o WhatsApp reales;
//   · no se ejecuta `seed`, migraciones ni scripts de datos; no se hacen cobros ni reembolsos;
//   · nunca se guardan valores de entorno en la evidencia (solo las últimas líneas de salida, filtradas).
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT, DATA_DIR, CACHE_DIR, ensureDir, writeJsonAtomic, readJson, nowIso, log, fmtMs } from './util.mjs';

const SUITES = {
  'backend-tipos': { paquete: 'backend', cmd: ['npx', 'tsc', '--noEmit'], tipo: 'tipos' },
  'backend-pruebas': { paquete: 'backend', cmd: ['npx', 'vitest', 'run', '--reporter=json', '--outputFile={OUT}'], tipo: 'pruebas', json: 'vitest', timeoutMin: 60 },
  'business-pruebas': { paquete: 'business', cmd: ['npx', 'vitest', 'run', '--reporter=json', '--outputFile={OUT}'], tipo: 'pruebas', json: 'vitest', timeoutMin: 10 },
  'desktop-pruebas': { paquete: 'desktop', cmd: ['npx', 'vitest', 'run', '--reporter=json', '--outputFile={OUT}'], tipo: 'pruebas', json: 'vitest', timeoutMin: 10 },
  'mobile-tipos': { paquete: 'mobile', cmd: ['npx', 'tsc', '--noEmit'], tipo: 'tipos' },
  'mobile-pruebas': { paquete: 'mobile', cmd: ['npx', 'jest', '--json', '--outputFile={OUT}'], tipo: 'pruebas', json: 'jest', timeoutMin: 20 },
  'admin-tipos': { paquete: 'admin', cmd: ['npx', 'tsc', '-p', 'tsconfig.app.json', '--noEmit'], tipo: 'tipos' },
  'business-tipos': { paquete: 'business', cmd: ['npx', 'tsc', '-p', 'tsconfig.app.json', '--noEmit'], tipo: 'tipos' },
};
const GRUPOS = {
  rapido: ['backend-tipos', 'mobile-tipos', 'admin-tipos', 'business-tipos'],
  pruebas: ['business-pruebas', 'desktop-pruebas', 'mobile-pruebas', 'backend-pruebas'],
  todo: ['backend-tipos', 'mobile-tipos', 'admin-tipos', 'business-tipos', 'business-pruebas', 'desktop-pruebas', 'mobile-pruebas', 'backend-pruebas'],
};

function isolatedEnv() {
  const env = { ...process.env, NODE_ENV: 'test', CI: '1', CEREBRO_VERIFICACION: '1' };
  const names = new Set();
  for (const f of ['backend/.env.example', 'deploy/backend.env.production.example']) {
    try {
      for (const line of fs.readFileSync(path.join(ROOT, f), 'utf8').split(/\r?\n/)) {
        const m = /^\s*#?\s*([A-Z][A-Z0-9_]+)\s*=/.exec(line);
        if (m) names.add(m[1]);
      }
    } catch { /* sin ejemplo */ }
  }
  for (const n of ['MONGODB_URI', 'MONGO_URI', 'DATABASE_URL', 'REDIS_URL']) names.add(n);
  for (const n of names) {
    if (/^(NODE_ENV|PORT|LOG_LEVEL|TZ|HOST)$/.test(n)) continue;
    if (/URI|URL|HOST|ORIGIN|DOMAIN/.test(n)) env[n] = /MONGO|DATABASE/.test(n) ? 'mongodb://127.0.0.1:1/cerebro-aislado' : /REDIS/.test(n) ? '' : 'http://127.0.0.1:9/cerebro-aislado';
    else if (/KEY|SECRET|TOKEN|PASSWORD|PASS$|USER|ACCOUNT|SID|SALT|PRIVATE|INTEGRITY|EVENTS/.test(n)) env[n] = 'cerebro-aislado-cerebro-aislado-cerebro-aislado';
  }
  return env;
}

const SENSITIVE_LINE = /(mongodb(\+srv)?:\/\/\S+@|eyJ[A-Za-z0-9_-]{12,}\.|(secret|password|token|api[_-]?key)\s*[:=]\s*\S{12,})/i;
const clean = (text) => text.split(/\r?\n/).filter((l) => !SENSITIVE_LINE.test(l)).join('\n');

function run(cmd, cwd, env, timeoutMs, onData) {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    const child = spawn(isWin ? `${cmd[0]}.cmd` : cmd[0], cmd.slice(1), { cwd, env, shell: isWin, windowsHide: true });
    let out = '';
    const take = (d) => { out += d.toString(); if (out.length > 400_000) out = out.slice(-200_000); onData?.(d.toString()); };
    child.stdout.on('data', take); child.stderr.on('data', take);
    const to = setTimeout(() => { try { child.kill(); } catch { /* ya terminó */ } resolve({ code: null, out, timeout: true }); }, timeoutMs);
    child.on('close', (code) => { clearTimeout(to); resolve({ code, out, timeout: false }); });
    child.on('error', (e) => { clearTimeout(to); resolve({ code: -1, out: String(e), timeout: false }); });
  });
}

function parseJsonReport(kind, file, pkgDir) {
  let j;
  try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  const archivos = {};
  const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');
  const results = kind === 'vitest' ? j.testResults : j.testResults;
  for (const r of results ?? []) {
    const name = rel(kind === 'vitest' ? r.name : r.name);
    const tests = r.assertionResults ?? [];
    const passed = tests.filter((t) => t.status === 'passed').length;
    const failed = tests.filter((t) => t.status === 'failed').length;
    const skipped = tests.filter((t) => t.status === 'skipped' || t.status === 'pending' || t.status === 'todo').length;
    archivos[name] = {
      estado: r.status === 'passed' && failed === 0 ? 'passed' : 'failed',
      pruebas: tests.length, pasaron: passed, fallaron: failed, omitidas: skipped,
      duracionMs: Math.round((r.endTime ?? 0) - (r.startTime ?? 0)) || null,
      fallos: tests.filter((t) => t.status === 'failed').slice(0, 8).map((t) => ({ nombre: t.fullName ?? t.title, mensaje: clean(String((t.failureMessages ?? [])[0] ?? '')).slice(0, 400) })),
    };
  }
  return { archivos, totales: { pruebas: j.numTotalTests, pasaron: j.numPassedTests, fallaron: j.numFailedTests, omitidas: j.numPendingTests ?? 0, archivos: j.numTotalTestSuites ?? Object.keys(archivos).length } };
}

export async function verify(args = []) {
  const wanted = args.filter((a) => !a.startsWith('--'));
  const names = wanted.length ? wanted.flatMap((w) => GRUPOS[w] ?? [w]) : GRUPOS.rapido;
  for (const n of names) if (!SUITES[n]) { console.error(`Suite desconocida: ${n}. Disponibles: ${Object.keys(SUITES).join(', ')} · grupos: ${Object.keys(GRUPOS).join(', ')}`); process.exit(1); }
  ensureDir(CACHE_DIR);
  const previo = readJson(path.join(DATA_DIR, 'verificacion.json'), { archivos: {}, suites: [] });
  const env = isolatedEnv();
  const resultado = { generadaEn: nowIso(), suites: previo.suites.filter((s) => !names.includes(s.id)), archivos: { ...previo.archivos } };
  for (const n of names) {
    const s = SUITES[n];
    const out = path.join(CACHE_DIR, `${n}.json`);
    try { fs.rmSync(out, { force: true }); } catch { /* ignorar */ }
    const cmd = s.cmd.map((c) => c.replace('{OUT}', out));
    log(`▶ ${n}: ${cmd.join(' ')}`);
    const t0 = Date.now();
    const r = await run(cmd, path.join(ROOT, s.paquete), env, (s.timeoutMin ?? 15) * 60000, () => process.stdout.write('.'));
    process.stdout.write('\n');
    const rep = s.json ? parseJsonReport(s.json, out, s.paquete) : null;
    const cola = clean(r.out).split(/\r?\n/).filter(Boolean).slice(-14).join('\n').slice(-1800);
    const entry = {
      id: n, paquete: s.paquete, tipo: s.tipo, comando: cmd.join(' ').replace(out, '<salida>'), codigoSalida: r.code, tiempoAgotado: r.timeout,
      duracionMs: Date.now() - t0, resumen: rep?.totales ?? null, salidaCola: r.code === 0 && rep ? undefined : cola,
      nota: r.timeout ? 'Se agotó el tiempo; los resultados parciales no se registran como aprobados.' : undefined,
    };
    resultado.suites.push(entry);
    if (rep) {
      for (const [f, v] of Object.entries(rep.archivos)) resultado.archivos[f] = { ...v, suite: n, ejecutadaEn: nowIso() };
    }
    log(`${r.code === 0 ? '✔' : '✘'} ${n}: código ${r.code}${r.timeout ? ' (tiempo agotado)' : ''} · ${fmtMs(entry.duracionMs)}${rep ? ` · ${rep.totales.pasaron}/${rep.totales.pruebas} pruebas` : ''}`);
    // Guardado incremental: si se corta, lo ejecutado hasta aquí queda.
    writeJsonAtomic(path.join(DATA_DIR, 'verificacion.json'), finalize(resultado));
  }
  const fin = finalize(resultado);
  writeJsonAtomic(path.join(DATA_DIR, 'verificacion.json'), fin);
  log(`Evidencia guardada: ${Object.keys(fin.archivos).length} archivos de prueba · ${fin.rutasProbadas?.length ?? 0} endpoints con prueba aprobada. Ejecuta «actualizar» para reflejarlo en el mapa.`);
}

/** Calcula qué endpoints quedan respaldados por pruebas que pasaron (todas las que los ejercitan). */
function finalize(res) {
  const out = { ...res };
  out.resumen = {
    suites: res.suites.length, verdes: res.suites.filter((s) => s.codigoSalida === 0).length, rojas: res.suites.filter((s) => s.codigoSalida !== 0).length,
    archivosDePrueba: Object.keys(res.archivos).length, archivosVerdes: Object.values(res.archivos).filter((a) => a.estado === 'passed').length,
  };
  try {
    const actual = readJson(path.join(DATA_DIR, 'actual.json'), null);
    const eps = actual ? readJson(path.join(DATA_DIR, 'snapshots', actual.id, 'endpoints.json'), null) : null;
    if (eps) {
      out.rutasProbadas = eps.endpoints.filter((e) => e.pruebas?.length && e.pruebas.every((p) => res.archivos[p.archivo]?.estado === 'passed')).map((e) => e.id);
    }
  } catch { /* sin instantánea */ }
  return out;
}
