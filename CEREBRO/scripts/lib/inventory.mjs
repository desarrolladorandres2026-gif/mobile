// Inventario verificable de archivos: qué existe, de qué clase es y cómo se analiza.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, abs, sha1, countLines, listRepoFiles, readJson } from './util.mjs';

const AST_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.ico', '.icns', '.ttf', '.otf', '.woff', '.woff2',
  '.mp3', '.wav', '.mp4', '.docx', '.pdf', '.zip', '.keystore', '.jks', '.bin', '.webm',
]);
const LANG = {
  '.ts': 'typescript', '.tsx': 'typescript-jsx', '.js': 'javascript', '.jsx': 'javascript-jsx',
  '.mjs': 'javascript', '.cjs': 'javascript', '.json': 'json', '.md': 'markdown', '.css': 'css',
  '.html': 'html', '.sh': 'shell', '.py': 'python', '.kt': 'kotlin', '.gradle': 'gradle',
  '.yml': 'yaml', '.yaml': 'yaml', '.conf': 'nginx', '.svg': 'svg', '.xml': 'xml', '.txt': 'texto',
  '.properties': 'properties', '.service': 'systemd', '.nsh': 'nsis', '.pro': 'proguard',
};

/** Paquete de un archivo según la ruta más larga que coincide. */
export function packageOf(file, config) {
  let best = null;
  for (const p of config.paquetes) {
    if (p.soloRaiz) continue;
    const prefix = p.ruta === '.' ? '' : `${p.ruta}/`;
    if (file.startsWith(prefix) && (!best || prefix.length > (best.ruta.length + 1))) best = p;
  }
  return best ? best.id : 'raiz';
}

export function isTestFile(file) {
  return (
    /(^|\/)__tests__\//.test(file) ||
    /\.(test|spec)\.(ts|tsx|js|mjs)$/.test(file) ||
    /^desktop\/test\//.test(file) ||
    /(^|\/)__mocks__\//.test(file) ||
    /(^|\/)jest\.setup\.js$/.test(file)
  );
}

/** Clasifica un archivo y decide si se analiza. */
export function classify(file, config) {
  const ext = path.extname(file).toLowerCase();
  const base = path.basename(file);
  const generatedRule = (config.excluirDelAnalisis?.generado ?? []).find((r) => new RegExp(r.patron).test(file));

  if (/^mobile\/android\//.test(file) && generatedRule) {
    return { clase: 'generado', modo: 'ninguno', motivo: generatedRule.motivo };
  }
  if (BINARY_EXT.has(ext) || ext === '.svg') {
    return { clase: 'recurso', modo: 'ninguno', motivo: 'Recurso estático (imagen/fuente/binario): no contiene lógica' };
  }
  if (base === 'package-lock.json') {
    return { clase: 'lock', modo: 'ninguno', motivo: 'Lockfile generado por npm; las dependencias se leen de package.json' };
  }
  if (ext === '.md') return { clase: 'doc', modo: 'ninguno', motivo: 'Documentación humana: se usa para contrastar, no se analiza como código' };
  if (AST_EXT.has(ext)) {
    if (isTestFile(file)) return { clase: 'prueba', modo: 'ast' };
    if (/\.config\.(ts|js|mjs|cjs)$/.test(base) || /^(eslint|babel|metro|jest|vite|vitest)\.config/.test(base) || base === 'babel.config.js') {
      return { clase: 'config', modo: 'ast' };
    }
    if (/^backend\/src\/migrations\//.test(file)) return { clase: 'migracion', modo: 'ast' };
    if (/^backend\/src\/(scripts|seed)/.test(file) || /(^|\/)scripts\//.test(file) || /^desktop\/scripts\//.test(file)) {
      return { clase: 'script', modo: 'ast' };
    }
    return { clase: 'fuente', modo: 'ast' };
  }
  if (ext === '.css') return { clase: 'estilo', modo: 'texto' };
  if (ext === '.html') return { clase: 'fuente', modo: 'texto' };
  if (ext === '.sh') return { clase: 'infra', modo: 'texto' };
  if (/^deploy\//.test(file)) return { clase: 'infra', modo: 'texto' };
  if (ext === '.py') return { clase: 'script', modo: 'texto' };
  if (ext === '.kt' || ext === '.gradle' || ext === '.xml' || ext === '.pro' || ext === '.properties') {
    return { clase: 'config', modo: 'texto' };
  }
  if (ext === '.json' || ext === '.yml' || ext === '.yaml' || ext === '.conf' || ext === '.nsh' || base.includes('.env') || base === 'Dockerfile' || ext === '.txt' || base.startsWith('.git') || base === '.nvmrc') {
    return { clase: 'config', modo: 'texto' };
  }
  return { clase: 'otro', modo: 'texto' };
}

export function buildInventory(config) {
  const files = listRepoFiles().filter((f) => !f.startsWith('CEREBRO/'));
  const entries = [];
  for (const f of files) {
    const full = abs(f);
    let buf;
    try {
      buf = fs.readFileSync(full);
    } catch {
      continue;
    }
    const cls = classify(f, config);
    const ext = path.extname(f).toLowerCase();
    const binary = BINARY_EXT.has(ext);
    const entry = {
      ruta: f,
      paquete: packageOf(f, config),
      clase: cls.clase,
      lenguaje: LANG[ext] ?? (path.basename(f) === 'Dockerfile' ? 'dockerfile' : ext.replace('.', '') || 'sin-extension'),
      bytes: buf.length,
      lineas: binary ? null : countLines(buf.toString('utf8')),
      hash: sha1(buf),
      modo: cls.modo,
    };
    if (cls.motivo) entry.motivo = cls.motivo;
    entries.push(entry);
  }
  return entries;
}

/** Directorios excluidos presentes en disco (se registran, no se recorren). */
export function findExcludedDirs(config) {
  const found = [];
  const bases = [''];
  for (const p of config.paquetes) if (!p.soloRaiz && p.ruta !== '.') bases.push(`${p.ruta}/`);
  bases.push('scripts/logos/');
  for (const rule of config.excluirDelAnalisis.directorios) {
    const name = rule.patron.replace(/\/$/, '');
    for (const b of bases) {
      const p = path.join(ROOT, b, name);
      if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
        found.push({ ruta: `${b}${name}/`, motivo: rule.motivo });
      }
    }
  }
  return found;
}

/** Dependencias, scripts y puntos de entrada declarados en cada package.json. */
export function readPackageManifests(config) {
  const out = [];
  const roots = new Set(config.paquetes.filter((p) => !p.soloRaiz && p.ruta !== '.').map((p) => p.ruta));
  roots.add('scripts/logos');
  for (const r of roots) {
    const pj = readJson(path.join(ROOT, r, 'package.json'));
    if (!pj) continue;
    out.push({
      ruta: `${r}/package.json`,
      nombre: pj.name ?? null,
      version: pj.version ?? null,
      main: pj.main ?? null,
      scripts: pj.scripts ?? {},
      dependencias: pj.dependencies ?? {},
      dependenciasDev: pj.devDependencies ?? {},
      node_modules: fs.existsSync(path.join(ROOT, r, 'node_modules')),
    });
  }
  return out;
}
