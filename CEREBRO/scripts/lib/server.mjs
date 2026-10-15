// Servidor local de la interfaz (solo 127.0.0.1). Sirve la UI estática, los datos de la instantánea vigente y
// consultas de grafo; avisa a los navegadores de nuevas instantáneas por Server-Sent Events.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { CEREBRO_DIR, ROOT, DATA_DIR, RUNTIME_DIR, loadConfig, readJson, log, nowIso, listRepoFiles } from './util.mjs';
import { Store, readSourceSlice } from './store.mjs';
import { readHistory } from './history.mjs';

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const DATASETS = new Set([
  'meta', 'inventario', 'cobertura', 'endpoints', 'llamadas-api', 'pantallas', 'acciones', 'modelos', 'eventos', 'procesos', 'integraciones',
  'entorno', 'estados', 'roles', 'dinero', 'hallazgos', 'pruebas', 'codigo-sin-uso', 'ciclos', 'duplicados', 'resumen-manual', 'archivos-grafo',
]);

const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': CSP, 'Referrer-Policy': 'no-referrer', ...headers });
  res.end(body);
}

function sendJson(req, res, obj, status = 200) {
  const json = typeof obj === 'string' ? obj : JSON.stringify(obj);
  const accept = req.headers['accept-encoding'] ?? '';
  if (json.length > 2048 && /gzip/.test(accept)) {
    send(res, status, zlib.gzipSync(json, { level: 4 }), { 'Content-Type': MIME['.json'], 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' });
  } else send(res, status, json, { 'Content-Type': MIME['.json'] });
}

export async function serve({ port, host, onReconstruir } = {}) {
  const config = loadConfig();
  port ??= config.servidor?.puerto ?? 3900;
  host ??= config.servidor?.host ?? '127.0.0.1';
  const store = new Store();
  store.refresh();
  const clients = new Set();
  let lastId = store.id;
  let repoFilesCache = { t: 0, files: [] };

  const broadcast = (obj) => {
    const data = `data: ${JSON.stringify(obj)}\n\n`;
    for (const c of clients) { try { c.write(data); } catch { clients.delete(c); } }
  };

  // Vigila el puntero de instantánea y el estado del vigilante (sondeo ligero).
  let lastStatusStamp = '';
  const poll = setInterval(() => {
    if (store.refresh()) { lastId = store.id; broadcast({ tipo: 'instantanea', id: store.id, ts: nowIso() }); }
    const st = readJson(path.join(RUNTIME_DIR, 'estado.json'), null);
    const stamp = st ? `${st.fase}|${st.pendientes}|${st.ultimaActualizacion}|${st.error ?? ''}` : '';
    if (stamp !== lastStatusStamp) { lastStatusStamp = stamp; broadcast({ tipo: 'estado', estado: st }); }
  }, 1200);
  poll.unref?.();
  const ping = setInterval(() => { for (const c of clients) { try { c.write(': ping\n\n'); } catch { clients.delete(c); } } }, 25000);
  ping.unref?.();

  const staticFile = (rel) => {
    const full = path.resolve(CEREBRO_DIR, 'ui', rel);
    if (!full.startsWith(path.join(CEREBRO_DIR, 'ui'))) return null;
    return fs.existsSync(full) && fs.statSync(full).isFile() ? full : null;
  };

  const server = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url ?? '/', `http://${host}:${port}`);
      const p = u.pathname;
      // Defensa mínima contra DNS rebinding: solo hosts locales.
      const hostHeader = (req.headers.host ?? '').split(':')[0];
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(hostHeader)) return send(res, 403, 'host no permitido');

      if (p === '/' || p === '/index.html') {
        return send(res, 200, fs.readFileSync(staticFile('index.html')), { 'Content-Type': MIME['.html'] });
      }
      if (p.startsWith('/ui/')) {
        const f = staticFile(p.slice(4));
        if (!f) return send(res, 404, 'no encontrado');
        return send(res, 200, fs.readFileSync(f), { 'Content-Type': MIME[path.extname(f)] ?? 'application/octet-stream' });
      }

      if (p === '/api/eventos') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        res.write(`data: ${JSON.stringify({ tipo: 'hola', id: store.id })}\n\n`);
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }

      if (p === '/api/estado') {
        store.refresh();
        const meta = store.get('meta.json');
        const st = readJson(path.join(RUNTIME_DIR, 'estado.json'), null);
        const hb = st?.latido ? Date.now() - new Date(st.latido).getTime() : null;
        const vigilante = st && hb !== null && hb < 20000 ? 'activo' : 'detenido';
        return sendJson(req, res, { instantanea: store.id, meta, vigilante, estadoVigilante: st, ahora: nowIso(), puerto: port, raiz: ROOT });
      }

      // Frescura: archivos modificados en disco después de la instantánea (sin analizar).
      if (p === '/api/frescura') {
        const meta = store.get('meta.json');
        if (!meta) return sendJson(req, res, { error: 'sin instantánea' }, 404);
        if (Date.now() - repoFilesCache.t > 4000) { repoFilesCache = { t: Date.now(), files: listRepoFiles().filter((f) => !f.startsWith('CEREBRO/')) }; }
        const since = new Date(meta.generadoEn).getTime();
        const stale = [];
        for (const f of repoFilesCache.files) {
          try { if (fs.statSync(path.join(ROOT, f)).mtimeMs > since + 500 && /\.(ts|tsx|js|mjs|cjs|json|css|html|sh|conf|yml)$/.test(f) && !/package-lock/.test(f)) stale.push(f); } catch { /* borrado */ }
        }
        return sendJson(req, res, { desde: meta.generadoEn, archivos: stale.slice(0, 80), total: stale.length });
      }

      if (p.startsWith('/api/datos/')) {
        const name = p.slice('/api/datos/'.length);
        if (!DATASETS.has(name)) return send(res, 404, 'conjunto desconocido');
        store.refresh();
        const file = store.rawPath(`${name}.json`);
        if (!file || !fs.existsSync(file)) return sendJson(req, res, { error: 'sin datos: ejecuta «construir»' }, 404);
        return sendJson(req, res, fs.readFileSync(file, 'utf8'));
      }

      if (p === '/api/buscar') {
        store.refresh();
        const items = store.search(u.searchParams.get('q') ?? '', { tipo: u.searchParams.get('tipo'), paquete: u.searchParams.get('paq'), limite: Number(u.searchParams.get('n') ?? 40) });
        const q = (u.searchParams.get('q') ?? '').toLowerCase().trim();
        const extra = [];
        if (q) {
          for (const ep of store.get('endpoints.json')?.endpoints ?? []) if (ep.id.toLowerCase().includes(q)) { extra.push({ clase: 'endpoint', id: ep.id, titulo: ep.id, sub: ep.archivo }); if (extra.length >= 12) break; }
          for (const a of store.get('acciones.json')?.acciones ?? []) if ((a.etiqueta ?? '').toLowerCase().includes(q) && a.etiqueta.length > 2) { extra.push({ clase: 'accion', id: a.id, titulo: `${a.tag} «${a.etiqueta.slice(0, 60)}»`, sub: `${a.archivo}:${a.linea}`, estado: a.estado }); if (extra.length >= 24) break; }
          for (const m of store.get('modelos.json') ?? []) if (m.nombre.toLowerCase().includes(q)) extra.push({ clase: 'modelo', id: m.simbolo, titulo: m.nombre, sub: m.archivo });
          for (const f of store.get('inventario.json')?.archivos ?? []) if (f.ruta.toLowerCase().includes(q) && extra.length < 40) extra.push({ clase: 'archivo', id: f.ruta, titulo: f.ruta, sub: `${f.lineas ?? '—'} líneas · ${f.clase}` });
        }
        return sendJson(req, res, { simbolos: items.map((s) => ({ id: s.id, nombre: s.nombre, tipo: s.tipo, archivo: s.archivo, linea: s.linea, paq: s.paq })), otros: extra });
      }

      if (p === '/api/nodo') {
        store.refresh();
        store.indexGraph();
        const id = u.searchParams.get('id') ?? '';
        const s = store.sym.get(id);
        if (!s) {
          // ¿Es un archivo?
          const ids = store.byFile.get(id);
          if (ids) {
            const inv = (store.get('inventario.json')?.archivos ?? []).find((f) => f.ruta === id);
            const cov = (store.get('cobertura.json')?.archivos ?? []).find((f) => f.ruta === id);
            const imports = (store.get('archivos-grafo.json')?.filas ?? []);
            return sendJson(req, res, {
              clase: 'archivo', archivo: id, inventario: inv, cobertura: cov,
              simbolos: ids.map((i) => store.sym.get(i)).filter((x) => x.tipo !== 'modulo').map((x) => ({ id: x.id, nombre: x.nombre, ruta: x.ruta, tipo: x.tipo, linea: x.linea, lineaFin: x.lineaFin, entran: x.entran, salen: x.salen, exportado: x.exportado, doc: x.doc })),
              importa: imports.filter((r) => r[0] === id).map((r) => ({ archivo: r[1], tipo: r[2], nombres: r[3] })),
              importadoPor: imports.filter((r) => r[1] === id).map((r) => ({ archivo: r[0], tipo: r[2], nombres: r[3] })),
              hallazgos: (store.get('hallazgos.json') ?? []).filter((h) => (h.evidencia ?? []).some((e) => e.archivo === id)).slice(0, 60).map((h) => ({ id: h.id, titulo: h.titulo, severidad: h.severidad, confianza: h.confianza })),
              pruebas: (store.get('pruebas.json') ?? []).filter((t) => t.importa.includes(id)).map((t) => t.archivo),
            });
          }
          return sendJson(req, res, { error: 'nodo desconocido' }, 404);
        }
        const mapEdges = (list, key) => (list ?? []).filter((e) => e.tipo !== 'usa-tipo').map((e) => {
          const other = store.sym.get(e[key]);
          return { id: e[key], nombre: other?.nombre, ruta: other?.ruta, tipo: other?.tipo, archivo: other?.archivo, linea: other?.linea, arista: e.tipo, conf: e.conf, via: e.via, lineaLlamada: e.linea, uso: e.uso };
        });
        const out = mapEdges(store.out.get(id), 'a');
        const inn = mapEdges(store.in.get(id), 'de');
        const endpoints = (store.get('endpoints.json')?.endpoints ?? []).filter((e) => e.manejador === id).map((e) => e.id);
        const modelo = (store.get('modelos.json') ?? []).find((m) => m.simbolo === id);
        const acciones = (store.get('acciones.json')?.acciones ?? []).filter((a) => a.manejadores.includes(id)).slice(0, 40).map((a) => ({ id: a.id, etiqueta: a.etiqueta, archivo: a.archivo, linea: a.linea, estado: a.estado }));
        const tests = [...new Set(inn.filter((e) => /__tests__|\.test\.|\/test\//.test(e.archivo ?? '')).map((e) => e.archivo))];
        const hallazgos = (store.get('hallazgos.json') ?? []).filter((h) => (h.elementos ?? []).includes(id)).slice(0, 40).map((h) => ({ id: h.id, titulo: h.titulo, severidad: h.severidad, confianza: h.confianza }));
        return sendJson(req, res, { clase: 'simbolo', simbolo: s, sale: out, entra: inn, endpoints, modelo: modelo ? { nombre: modelo.nombre } : null, acciones, tests, hallazgos });
      }

      if (p === '/api/vecindad') {
        store.refresh();
        const id = u.searchParams.get('id') ?? '';
        const prof = Math.min(3, Number(u.searchParams.get('prof') ?? 1));
        const dir = u.searchParams.get('dir') ?? 'both';
        const tipos = u.searchParams.get('tipos') ? u.searchParams.get('tipos').split(',') : null;
        return sendJson(req, res, store.neighborhood(id, { dir, prof, tipos }));
      }

      if (p === '/api/impacto') {
        store.refresh();
        return sendJson(req, res, store.impact(u.searchParams.get('id') ?? ''));
      }

      if (p === '/api/codigo') {
        const archivo = u.searchParams.get('archivo') ?? '';
        const inv = store.get('inventario.json')?.archivos ?? [];
        if (!inv.some((f) => f.ruta === archivo && f.lineas != null)) return sendJson(req, res, { error: 'archivo no inventariado' }, 404);
        const desde = Number(u.searchParams.get('desde') ?? 1);
        const hasta = Number(u.searchParams.get('hasta') ?? desde + 60);
        return sendJson(req, res, { archivo, ...readSourceSlice(ROOT, archivo, desde, Math.min(hasta, desde + 400)) });
      }

      if (p === '/api/historial') return sendJson(req, res, readHistory(path.join(DATA_DIR, 'historial.jsonl'), Number(u.searchParams.get('n') ?? 100)));
      if (p === '/api/verificacion') return sendJson(req, res, readJson(path.join(DATA_DIR, 'verificacion.json'), null) ?? {});

      if (p === '/api/reconstruir' && req.method === 'POST') {
        if (req.headers['x-cerebro'] !== '1') return send(res, 403, 'falta cabecera');
        const modo = u.searchParams.get('modo') === 'completo' ? 'construir' : 'actualizar';
        if (onReconstruir) onReconstruir(modo);
        else {
          const child = spawn(process.execPath, [path.join(CEREBRO_DIR, 'scripts', 'cerebro.mjs'), modo], { cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true });
          child.unref();
        }
        return sendJson(req, res, { ok: true, modo });
      }

      send(res, 404, 'no encontrado');
    } catch (e) {
      log('error servidor:', e.message);
      try { send(res, 500, JSON.stringify({ error: String(e.message ?? e) }), { 'Content-Type': MIME['.json'] }); } catch { /* respuesta ya iniciada */ }
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  log(`Interfaz de CEREBRO en http://${host}:${port}`);
  return { server, close: () => { clearInterval(poll); clearInterval(ping); server.close(); }, port, host, store };
}
