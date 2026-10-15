// Vigilante: detecta cambios, nuevos archivos, borrados y renombrados y actualiza el mapa de forma incremental.
//
// Seguridad de la actualización:
//   · cada ciclo construye una instantánea COMPLETA en un directorio nuevo y solo entonces mueve el puntero `actual.json`
//     (escritura atómica), de modo que ningún lector ve un mapa a medias;
//   · si un ciclo falla, la instantánea anterior sigue vigente y el error queda en el estado;
//   · CEREBRO/ se ignora salvo CEREBRO/manual/, así que escribir sus propios datos no provoca un bucle.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, RUNTIME_DIR, DATA_DIR, ensureDir, loadConfig, writeJsonAtomic, readJson, log, nowIso, fmtMs } from './util.mjs';
import { build } from './build.mjs';

const LOCK = path.join(RUNTIME_DIR, 'vigilante.lock');
const STATE = path.join(RUNTIME_DIR, 'estado.json');
const RELEVANT = /\.(ts|tsx|js|jsx|mjs|cjs|json|css|html|sh|conf|yml|yaml|md|py|kt|gradle|xml|nsh|example|env)$/i;

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export async function watch({ serve = true } = {}) {
  const config = loadConfig();
  const vig = config.vigilante ?? {};
  const ignoreDirs = new Set(config.ignorarEnVigilancia ?? []);
  ensureDir(RUNTIME_DIR);

  const prev = readJson(LOCK, null);
  if (prev && prev.pid !== process.pid && alive(prev.pid)) {
    console.error(`Ya hay un vigilante en ejecución (pid ${prev.pid}). Usa «detener» antes.`);
    process.exit(2);
  }
  fs.writeFileSync(LOCK, JSON.stringify({ pid: process.pid, inicio: nowIso() }));

  const estado = {
    pid: process.pid, inicio: nowIso(), fase: 'iniciando', pendientes: 0, pendientesLista: [], ultimaActualizacion: null, ultimoCiclo: null,
    proximaCompleta: null, error: null, latido: nowIso(), puerto: null, ciclos: 0,
  };
  const save = () => { estado.latido = nowIso(); try { writeJsonAtomic(STATE, estado); } catch { /* lectores concurrentes */ } };
  save();

  const pending = new Set();
  let timer = null;
  let running = false;
  let again = false;
  let wantFull = false;
  const nextFull = () => { estado.proximaCompleta = new Date(Date.now() + (vig.reconstruccionCompletaCadaMin ?? 30) * 60000).toISOString(); };
  nextFull();

  const relevant = (rel) => {
    if (!rel) return false;
    const parts = rel.split(/[\\/]/);
    if (parts[0] === 'CEREBRO') return parts[1] === 'manual' && /\.json$/.test(parts[parts.length - 1]);
    if (parts.some((p) => ignoreDirs.has(p))) return false;
    if (parts[0] === '.git') return false;
    return RELEVANT.test(parts[parts.length - 1]) || !/\./.test(parts[parts.length - 1]);
  };

  const cycle = async () => {
    if (running) { again = true; return; }
    running = true;
    const files = [...pending];
    pending.clear();
    estado.fase = 'analizando';
    estado.pendientes = files.length;
    estado.pendientesLista = files.slice(0, 6);
    save();
    const t0 = Date.now();
    const full = wantFull;
    wantFull = false;
    try {
      log(`${full ? 'Reconstrucción completa' : 'Actualización incremental'} (${files.length} evento(s))…`);
      const r = await build({ modo: full ? 'completo' : 'incremental', origen: full ? 'vigilante-completa' : 'vigilante', verbose: false });
      const ch = r.archivosCambiados;
      const n = ch.nuevos.length + ch.modificados.length + ch.eliminados.length;
      estado.ultimoCiclo = { tipo: full ? 'completo' : 'incremental', duracionMs: Date.now() - t0, cambios: full ? (r.cambios?.archivos.length ?? 0) : n, errores: r.errores.length, deriva: !!r.cambios?.deriva };
      estado.ultimaActualizacion = r.meta.generadoEn;
      estado.error = r.errores.length ? `${r.errores.length} aviso(s) en el análisis; ver «Sistema»` : null;
      estado.ciclos++;
      if (full) nextFull();
      log(`  listo en ${fmtMs(Date.now() - t0)} · ${n} archivo(s) cambiado(s)${r.cambios?.deriva ? ' · DERIVA detectada entre lo incremental y lo completo' : ''}`);
    } catch (e) {
      estado.error = String(e && e.message ? e.message : e).slice(0, 300);
      log('  error en el ciclo:', estado.error);
    } finally {
      running = false;
      estado.fase = 'esperando';
      estado.pendientes = pending.size;
      estado.pendientesLista = [...pending].slice(0, 6);
      save();
      if (again || pending.size) { again = false; schedule(); }
    }
  };
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(cycle, vig.debounceMs ?? 900);
    estado.pendientes = pending.size;
    estado.pendientesLista = [...pending].slice(0, 6);
    save();
  }

  // Recursivo nativo (Windows/macOS). Los eventos solo marcan «hay algo»; la comparación real la hace el hash de contenido.
  let watcher;
  try {
    watcher = fs.watch(ROOT, { recursive: true, persistent: true }, (evt, name) => {
      if (!name) return;
      if (!relevant(name)) return;
      pending.add(name.split(path.sep).join('/'));
      schedule();
    });
  } catch (e) {
    log('fs.watch recursivo no disponible:', e.message);
    process.exit(3);
  }
  watcher.on('error', (e) => { estado.error = `watcher: ${e.message}`; save(); });

  // Red de seguridad: ciclo por si algún evento se perdió (cambios masivos, git checkout…) y reconstrucción periódica completa.
  const sweep = setInterval(() => {
    if (running) return;
    if (estado.proximaCompleta && Date.now() > new Date(estado.proximaCompleta).getTime()) { wantFull = true; pending.add('(reconstrucción periódica)'); schedule(); }
  }, 30000);
  const beat = setInterval(save, (vig.latidoSeg ?? 5) * 1000);

  let srv = null;
  if (serve) {
    const { serve: startServer } = await import('./server.mjs');
    srv = await startServer({
      onReconstruir: (modo) => { wantFull = modo === 'construir'; pending.add('(solicitud manual)'); schedule(); },
    });
    estado.puerto = srv.port;
  }

  // Primer ciclo: ponerse al día con lo que cambió mientras no había vigilante.
  const cur = readJson(path.join(DATA_DIR, 'actual.json'), null);
  if (!cur) wantFull = true;
  pending.add('(arranque)');
  schedule();

  const shutdown = (code = 0) => {
    clearInterval(sweep); clearInterval(beat);
    try { watcher.close(); } catch { /* ya cerrado */ }
    try { srv?.close(); } catch { /* ya cerrado */ }
    estado.fase = 'detenido';
    save();
    try { fs.rmSync(LOCK, { force: true }); } catch { /* ignorar */ }
    process.exit(code);
  };
  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));
  log('Vigilante activo. Ctrl+C para salir.');
  await new Promise(() => {});
}
