// Iniciar / detener / consultar el vigilante como proceso en segundo plano.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { CEREBRO_DIR, ROOT, RUNTIME_DIR, ensureDir, readJson, loadConfig } from './util.mjs';

const LOCK = path.join(RUNTIME_DIR, 'vigilante.lock');
const STATE = path.join(RUNTIME_DIR, 'estado.json');
const LOG = path.join(RUNTIME_DIR, 'vigilante.log');

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

export function start() {
  ensureDir(RUNTIME_DIR);
  const lock = readJson(LOCK, null);
  const cfg = loadConfig();
  const url = `http://${cfg.servidor?.host ?? '127.0.0.1'}:${cfg.servidor?.puerto ?? 3900}`;
  if (lock && alive(lock.pid)) {
    console.log(`El vigilante ya está en ejecución (pid ${lock.pid}). Interfaz: ${url}`);
    return;
  }
  const out = fs.openSync(LOG, 'a');
  const child = spawn(process.execPath, ['--max-old-space-size=6144', path.join(CEREBRO_DIR, 'scripts', 'cerebro.mjs'), 'vigilar'], {
    cwd: ROOT, detached: true, stdio: ['ignore', out, out], windowsHide: true,
  });
  child.unref();
  console.log(`Vigilante iniciado en segundo plano (pid ${child.pid}).`);
  console.log(`Interfaz: ${url}`);
  console.log(`Registro: ${path.relative(ROOT, LOG)}`);
  console.log('Debe seguir ejecutándose para que el mapa se actualice solo. Para detenerlo: node CEREBRO/scripts/cerebro.mjs detener');
}

export function stop() {
  const lock = readJson(LOCK, null);
  if (!lock || !alive(lock.pid)) {
    console.log('No hay vigilante en ejecución.');
    try { fs.rmSync(LOCK, { force: true }); } catch { /* ignorar */ }
    return;
  }
  try { process.kill(lock.pid, 'SIGTERM'); } catch (e) { console.error('No se pudo detener:', e.message); return; }
  // En Windows SIGTERM termina de inmediato sin ejecutar el manejador: limpiamos nosotros.
  setTimeout(() => {
    if (!alive(lock.pid)) {
      try { fs.rmSync(LOCK, { force: true }); } catch { /* ignorar */ }
      const st = readJson(STATE, null);
      if (st) { st.fase = 'detenido'; fs.writeFileSync(STATE, JSON.stringify(st)); }
      console.log(`Vigilante detenido (pid ${lock.pid}).`);
    } else console.log('El proceso sigue vivo; reintenta.');
  }, 600);
}

export function status() {
  const lock = readJson(LOCK, null);
  const st = readJson(STATE, null);
  const act = readJson(path.join(CEREBRO_DIR, 'data', 'actual.json'), null);
  const running = !!lock && alive(lock.pid);
  const hb = st?.latido ? Math.round((Date.now() - new Date(st.latido).getTime()) / 1000) : null;
  console.log(`Vigilante: ${running ? 'ACTIVO' : 'DETENIDO'}${running ? ` (pid ${lock.pid})` : ''}`);
  if (st) {
    console.log(`  fase: ${st.fase} · pendientes: ${st.pendientes} · ciclos: ${st.ciclos}`);
    console.log(`  última actualización: ${st.ultimaActualizacion ?? '—'}`);
    if (st.ultimoCiclo) console.log(`  último ciclo: ${st.ultimoCiclo.tipo} ${(st.ultimoCiclo.duracionMs / 1000).toFixed(1)} s · ${st.ultimoCiclo.cambios} cambio(s)`);
    console.log(`  próxima reconstrucción completa: ${st.proximaCompleta ?? '—'}`);
    if (st.error) console.log(`  último error: ${st.error}`);
    if (hb != null) console.log(`  latido hace ${hb} s${running && hb > 20 ? ' — ¡demasiado antiguo!' : ''}`);
  }
  console.log(`Instantánea vigente: ${act ? `${act.id} (${act.modo}, ${act.generadoEn})` : 'ninguna: ejecuta «construir»'}`);
  const cfg = loadConfig();
  if (running) console.log(`Interfaz: http://${cfg.servidor?.host ?? '127.0.0.1'}:${cfg.servidor?.puerto ?? 3900}`);
}
