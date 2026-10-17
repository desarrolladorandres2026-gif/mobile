// Utilidades compartidas. Sin dependencias externas.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

export const CEREBRO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const ROOT = path.resolve(CEREBRO_DIR, '..');
export const DATA_DIR = path.join(CEREBRO_DIR, 'data');
export const MANUAL_DIR = path.join(CEREBRO_DIR, 'manual');
export const CACHE_DIR = path.join(DATA_DIR, 'cache');
export const RUNTIME_DIR = path.join(DATA_DIR, 'runtime');
export const SNAP_DIR = path.join(DATA_DIR, 'snapshots');

export const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex');
export const shortHash = (s, n = 10) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, n);

/** Ruta relativa al repo con separadores POSIX. */
export const rel = (abs) => path.relative(ROOT, abs).split(path.sep).join('/');
export const abs = (relPath) => path.join(ROOT, ...relPath.split('/'));

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/**
 * Escritura atómica: escribe a un temporal en el mismo directorio y renombra.
 * Un lector nunca ve un archivo a medias.
 */
export function writeFileAtomic(file, content) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, content);
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    // Windows: el destino puede estar abierto un instante por un lector.
    for (let i = 0; i < 5; i++) {
      try {
        fs.copyFileSync(tmp, file);
        break;
      } catch (err) {
        if (i === 4) throw err;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40);
      }
    }
    fs.rmSync(tmp, { force: true });
  }
}

export const writeJsonAtomic = (file, data, pretty = false) =>
  writeFileAtomic(file, pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data));

export function loadConfig() {
  return readJson(path.join(CEREBRO_DIR, 'cerebro.config.json'), {});
}

/** Número de líneas como las cuenta un editor (última línea sin \n incluida). */
export function countLines(text) {
  if (text.length === 0) return 0;
  let n = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  if (text.charCodeAt(text.length - 1) === 10) n--;
  return n;
}

export function git(args, opts = {}) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, windowsHide: true, ...opts });
}

export function gitInfo() {
  try {
    const head = git(['rev-parse', 'HEAD']).trim();
    const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    const dirty = git(['status', '--porcelain']).split('\n').filter(Boolean).length;
    return { head, branch, archivosConCambiosSinCommit: dirty };
  } catch {
    return { head: null, branch: null, archivosConCambiosSinCommit: null };
  }
}

/** Archivos del repo: rastreados + no rastreados no ignorados. */
export function listRepoFiles() {
  const out = git(['ls-files', '--cached', '--others', '--exclude-standard', '-z']);
  const files = out.split('\0').filter(Boolean);
  const seen = new Set();
  const result = [];
  for (const f of files) {
    if (seen.has(f)) continue;
    seen.add(f);
    // Un archivo rastreado pero borrado del disco aparece en ls-files.
    if (fs.existsSync(path.join(ROOT, f))) result.push(f);
  }
  return result.sort();
}

const tsCache = new Map();
/**
 * Carga el `typescript` de un paquete (su propio node_modules). Sin instalar nada.
 * Devuelve { ts, version, desde }.
 */
export function loadTs(packageDir) {
  if (tsCache.has(packageDir)) return tsCache.get(packageDir);
  const candidates = [packageDir, 'backend', 'mobile', 'admin', 'business'];
  for (const c of candidates) {
    const pkgJson = path.join(ROOT, c, 'node_modules', 'typescript', 'package.json');
    if (fs.existsSync(pkgJson)) {
      const req = createRequire(path.join(ROOT, c, 'package.json'));
      const ts = req('typescript');
      const res = { ts, version: ts.version, desde: c };
      tsCache.set(packageDir, res);
      return res;
    }
  }
  throw new Error('No se encontró ningún `typescript` instalado en backend/mobile/admin/business.');
}

export const nowIso = () => new Date().toISOString();

export function log(...args) {
  const t = new Date().toISOString().slice(11, 19);
  console.log(`[${t}]`, ...args);
}

export function fmtMs(ms) {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** Une rangos de líneas [a,b] solapados o contiguos. */
export function mergeRanges(ranges) {
  const r = ranges.filter((x) => x && x[1] >= x[0]).map((x) => [x[0], x[1]]).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const x of r) {
    const last = out[out.length - 1];
    if (last && x[0] <= last[1] + 1) last[1] = Math.max(last[1], x[1]);
    else out.push(x);
  }
  return out;
}

export const rangesLineCount = (ranges) => ranges.reduce((s, [a, b]) => s + (b - a + 1), 0);
