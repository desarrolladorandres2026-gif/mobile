// Vistas de dominio derivadas del grafo: modelos, eventos, procesos, integraciones, entorno, máquinas de estado,
// roles, dinero, código sin uso, ciclos y duplicaciones.
import fs from 'node:fs';
import { abs } from './util.mjs';
import { modelAccessKind } from './graph.mjs';

export const layerOf = (file) => {
  if (/(^|\/)(__tests__|__mocks__)\/|\.(test|spec)\.(ts|tsx|js)$|^desktop\/test\//.test(file)) return 'prueba';
  if (/^backend\/src\/models\//.test(file)) return 'modelo';
  if (/^backend\/src\/validators\//.test(file)) return 'validador';
  if (/^backend\/src\/controllers\//.test(file)) return 'controlador';
  if (/^backend\/src\/routes\//.test(file)) return 'ruta';
  if (/^backend\/src\/services\//.test(file)) return 'servicio';
  if (/^backend\/src\/(migrations|scripts)\/|^backend\/src\/seed/.test(file)) return 'operacion';
  if (/^backend\/src\//.test(file)) return 'utilidad';
  if (/^mobile\//.test(file)) return 'mobile';
  if (/^(admin|business|web)\//.test(file)) return 'panel';
  if (/^desktop\//.test(file)) return 'escritorio';
  return 'otro';
};

const KNOWN_INTEGRATIONS = {
  mongoose: ['MongoDB (Mongoose)', 'base de datos'],
  'socket.io': ['Socket.IO (servidor)', 'tiempo real'],
  'socket.io-client': ['Socket.IO (cliente)', 'tiempo real'],
  express: ['Express', 'servidor HTTP'],
  axios: ['axios', 'cliente HTTP'],
  jsonwebtoken: ['JWT', 'autenticación'],
  bcryptjs: ['bcrypt', 'contraseñas'],
  bcrypt: ['bcrypt', 'contraseñas'],
  cloudinary: ['Cloudinary', 'imágenes'],
  nodemailer: ['Nodemailer', 'correo'],
  twilio: ['Twilio', 'SMS/WhatsApp'],
  'expo-server-sdk': ['Expo Push', 'notificaciones push'],
  'expo-notifications': ['Expo Notifications', 'notificaciones push'],
  ioredis: ['Redis', 'caché'],
  redis: ['Redis', 'caché'],
  multer: ['multer', 'subida de archivos'],
  sharp: ['sharp', 'procesado de imágenes'],
  otplib: ['otplib', '2FA TOTP'],
  speakeasy: ['speakeasy', '2FA TOTP'],
  zod: ['zod', 'validación'],
  helmet: ['helmet', 'seguridad HTTP'],
  'express-rate-limit': ['express-rate-limit', 'límites de tasa'],
  'mapbox-gl': ['Mapbox GL', 'mapas'],
  '@tanstack/react-query': ['React Query', 'estado remoto'],
  zustand: ['Zustand', 'estado global'],
  'react-router-dom': ['React Router', 'navegación web'],
  'expo-router': ['Expo Router', 'navegación móvil'],
  electron: ['Electron', 'escritorio'],
  pdfkit: ['pdfkit', 'PDF'],
  puppeteer: ['Puppeteer', 'PDF/render'],
};

/** Indice token → archivos (sin pruebas por defecto). */
export function buildTokenIndex(factsMap) {
  const idx = new Map();
  for (const [f, fx] of factsMap) {
    for (const t of fx.tokens ?? []) {
      let s = idx.get(t);
      if (!s) { s = new Set(); idx.set(t, s); }
      s.add(f);
    }
  }
  return idx;
}

export function buildModels(factsMap, graph, endpointData, tokenIdx) {
  const models = [];
  const byName = new Map();
  for (const [file, fx] of factsMap) for (const m of fx.modelos ?? []) { models.push({ ...m, archivo: file }); byName.set(m.nombre, m); }
  const epByModel = new Map();
  for (const ep of endpointData.endpoints) {
    for (const [nombre, acc] of Object.entries(ep.cierre?.modelos ?? {})) {
      if (!epByModel.has(nombre)) epByModel.set(nombre, { lee: [], escribe: [] });
      const e = epByModel.get(nombre);
      if (acc.escribe) e.escribe.push(ep.id);
      if (acc.lee) e.lee.push(ep.id);
    }
  }
  const out = [];
  for (const m of models) {
    const sym = graph.symbols.get(m.id);
    const lectores = new Map();
    const escritores = new Map();
    for (const e of graph.edgesIn.get(m.id) ?? []) {
      const kind = modelAccessKind(e);
      const from = graph.symbols.get(e.de);
      if (!from || layerOf(from.archivo) === 'prueba') continue;
      const target = kind === 'write' ? escritores : kind === 'read' ? lectores : null;
      if (!target) continue;
      target.set(e.de, (target.get(e.de) ?? 0) + (e.n ?? 1));
    }
    const refs = [...new Set(m.campos.map((c) => c.ref).filter(Boolean))];
    const campos = m.campos.map((c) => {
      const leaf = c.nombre.split('.').pop().replace('[]', '');
      const files = tokenIdx.get(leaf);
      const capas = {};
      if (files) for (const f of files) {
        if (f === m.archivo) continue;
        const l = layerOf(f);
        capas[l] = (capas[l] ?? 0) + 1;
      }
      return { ...c, menciones: capas };
    });
    out.push({
      ...m, campos, simbolo: sym ? sym.id : m.id, refs,
      lectores: [...lectores.entries()].sort((a, b) => b[1] - a[1]).slice(0, 60).map(([id, n]) => ({ id, n })),
      escritores: [...escritores.entries()].sort((a, b) => b[1] - a[1]).slice(0, 60).map(([id, n]) => ({ id, n })),
      endpointsLeen: epByModel.get(m.nombre)?.lee ?? [], endpointsEscriben: epByModel.get(m.nombre)?.escribe ?? [],
    });
  }
  const names = new Set(out.map((m) => m.nombre));
  for (const m of out) m.refPor = out.filter((o) => o.refs.includes(m.nombre)).map((o) => o.nombre);
  for (const m of out) m.refsRotas = m.refs.filter((r) => !names.has(r));
  return out;
}

const SOCKET_BUILTIN = new Set(['connect', 'disconnect', 'connect_error', 'error', 'reconnect', 'reconnect_attempt', 'reconnect_error', 'reconnect_failed', 'connection', 'ping', 'pong', 'disconnecting']);

export function buildEvents(factsMap) {
  const ev = new Map();
  for (const [file, fx] of factsMap) {
    for (const e of fx.misc?.eventos ?? []) {
      let rec = ev.get(e.evento);
      if (!rec) { rec = { evento: e.evento, emisores: [], oyentes: [], integrado: SOCKET_BUILTIN.has(e.evento) }; ev.set(e.evento, rec); }
      const item = { de: e.de, archivo: file, linea: e.linea, paquete: fx.paquete, receptor: e.receptor };
      if (e.direccion === 'emite') rec.emisores.push(item);
      else if (e.direccion === 'escucha') rec.oyentes.push(item);
    }
  }
  return [...ev.values()].sort((a, b) => a.evento.localeCompare(b.evento));
}

export function buildJobs(factsMap, graph) {
  const jobs = [];
  for (const [file, fx] of factsMap) {
    for (const p of fx.misc?.periodicos ?? []) {
      const seg0 = p.de.split('#')[1]?.split(/[./]/)[0];
      const starterCandidates = [p.de, `${file}#${seg0}`].filter((id) => graph.symbols.has(id));
      let starter = null;
      for (const id of starterCandidates) {
        if (/start|init|schedule|run/i.test(id.split('#')[1] ?? '')) { starter = id; break; }
      }
      starter ??= starterCandidates[starterCandidates.length - 1] ?? null;
      const callers = starter ? (graph.edgesIn.get(starter) ?? []).filter((e) => e.tipo === 'llama' || e.tipo === 'referencia') : [];
      const prodCallers = callers.filter((e) => layerOf(graph.symbols.get(e.de)?.archivo ?? '') !== 'prueba');
      jobs.push({
        ...p, archivo: file, arrancador: starter,
        arrancadoPor: prodCallers.map((e) => ({ de: e.de, linea: e.linea })).slice(0, 6),
        arrancado: prodCallers.length > 0,
        soloPruebas: callers.length > 0 && prodCallers.length === 0,
        paquete: fx.paquete,
        ambito: /\.tsx$/.test(file) || /(^|\/)(hooks|components)\//.test(file) || fx.paquete === 'mobile' || ['admin', 'business', 'web'].includes(fx.paquete) ? 'ui' : fx.paquete === 'desktop' ? 'escritorio' : 'backend',
      });
    }
  }
  return jobs;
}

export function buildEnv(factsMap, inventory) {
  const usage = new Map();
  for (const [file, fx] of factsMap) {
    if (layerOf(file) === 'prueba') continue;
    for (const e of fx.misc?.entorno ?? []) {
      let r = usage.get(e.nombre);
      if (!r) { r = { nombre: e.nombre, usos: [], paquetes: new Set() }; usage.set(e.nombre, r); }
      r.usos.push({ archivo: file, linea: e.linea, de: e.de });
      r.paquetes.add(fx.paquete);
    }
  }
  // Variables documentadas en los .env*.example (solo nombres, nunca valores).
  const documentadas = new Map();
  for (const e of inventory) {
    if (!/\.env(\.|$)/.test(e.ruta) && !/env\.production\.example$/.test(e.ruta) && !/\.env\.example$/.test(e.ruta)) continue;
    let txt = '';
    try { txt = fs.readFileSync(abs(e.ruta), 'utf8'); } catch { continue; }
    for (const line of txt.split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]+)\s*=/.exec(line);
      if (m) {
        if (!documentadas.has(m[1])) documentadas.set(m[1], []);
        documentadas.get(m[1]).push(e.ruta);
      }
    }
  }
  const out = [];
  for (const [nombre, r] of usage) {
    out.push({ nombre, paquetes: [...r.paquetes], usos: r.usos.slice(0, 12), nUsos: r.usos.length, documentada: documentadas.has(nombre), documentadaEn: documentadas.get(nombre) ?? [] });
  }
  const usados = new Set(usage.keys());
  const sinUso = [...documentadas.entries()].filter(([n]) => !usados.has(n)).map(([nombre, en]) => ({ nombre, documentadaEn: en }));
  return { variables: out.sort((a, b) => a.nombre.localeCompare(b.nombre)), documentadasSinUso: sinUso };
}

export function buildIntegrations(factsMap, manifests) {
  const mods = new Map();
  for (const [file, fx] of factsMap) {
    if (layerOf(file) === 'prueba') continue;
    for (const u of fx.usosExternos ?? []) {
      const base = u.modulo.startsWith('@') ? u.modulo.split('/').slice(0, 2).join('/') : u.modulo.split('/')[0];
      if (/^(react|react-native|node:|fs|path|crypto|http|https|os|url|util|stream|events|child_process|zlib|net|tls|buffer)$/.test(base) || base.startsWith('node:')) continue;
      let r = mods.get(base);
      if (!r) { r = { modulo: base, archivos: new Set(), paquetes: new Set(), llamadas: 0, ejemplos: [] }; mods.set(base, r); }
      r.archivos.add(file); r.paquetes.add(fx.paquete); r.llamadas++;
      if (r.ejemplos.length < 4) r.ejemplos.push({ archivo: file, linea: u.linea, llamada: u.llamada });
    }
  }
  const hosts = new Map();
  for (const [file, fx] of factsMap) {
    if (layerOf(file) === 'prueba') continue;
    for (const h of fx.misc?.hosts ?? []) {
      let r = hosts.get(h.host);
      if (!r) { r = { host: h.host, usos: [] }; hosts.set(h.host, r); }
      r.usos.push({ archivo: file, linea: h.linea, de: h.de });
    }
  }
  const deps = new Map();
  for (const m of manifests) {
    for (const [n, v] of Object.entries(m.dependencias)) { if (!deps.has(n)) deps.set(n, []); deps.get(n).push({ paquete: m.ruta.split('/')[0], version: v, tipo: 'dep' }); }
    for (const [n, v] of Object.entries(m.dependenciasDev)) { if (!deps.has(n)) deps.set(n, []); deps.get(n).push({ paquete: m.ruta.split('/')[0], version: v, tipo: 'dev' }); }
  }
  const modulos = [...mods.values()].map((r) => {
    const known = KNOWN_INTEGRATIONS[r.modulo] ?? null;
    return { modulo: r.modulo, nombre: known?.[0] ?? r.modulo, rol: known?.[1] ?? null, archivos: r.archivos.size, paquetes: [...r.paquetes], llamadas: r.llamadas, ejemplos: r.ejemplos, declaradaEn: deps.get(r.modulo) ?? [] };
  }).sort((a, b) => b.llamadas - a.llamadas);
  const dependenciasSinUso = [...deps.entries()]
    .filter(([n, ds]) => ds.some((d) => d.tipo === 'dep') && !mods.has(n) && !/^@types\//.test(n))
    .map(([n, ds]) => ({ nombre: n, declaradaEn: ds }));
  return { modulos, hosts: [...hosts.values()].map((h) => ({ host: h.host, nUsos: h.usos.length, usos: h.usos.slice(0, 5) })).sort((a, b) => b.nUsos - a.nUsos), dependenciasSinUso };
}

/** Tablas de dominio: máquinas de estado y matrices. */
export function buildStateTables(factsMap, graph) {
  const tablas = [];
  for (const [file, fx] of factsMap) for (const t of fx.tablas ?? []) tablas.push({ ...t, archivo: file });
  const dominio = tablas.filter((t) => t.categoria === 'dominio');
  const consumidores = (id) => (graph.edgesIn.get(id) ?? []).filter((e) => e.tipo === 'referencia' || e.tipo === 'llama').map((e) => ({ de: e.de, linea: e.linea })).slice(0, 20);
  return { dominio: dominio.map((t) => ({ ...t, consumidores: consumidores(t.id) })), constantes: tablas.filter((t) => t.categoria === 'constante').map((t) => ({ id: t.id, nombre: t.nombre, archivo: t.archivo, linea: t.linea, texto: t.texto, consumidores: consumidores(t.id).length })) };
}

/** Escrituras de estado (por enum) desde código de producción. */
export function buildEnumWrites(graph, enumNames) {
  const res = {};
  for (const [sid, s] of graph.symbols) {
    if (s.tipo !== 'enum' || !enumNames.includes(s.nombre)) continue;
    const members = {};
    for (const e of graph.edgesIn.get(sid) ?? []) {
      if (e.tipo !== 'usa-enum' || !e.via) continue;
      const from = graph.symbols.get(e.de);
      if (!from || layerOf(from.archivo) === 'prueba') continue;
      const m = (members[e.via] ??= { escribe: [], compara: [], otros: 0 });
      if (e.uso === 'escribe') m.escribe.push({ de: e.de, linea: e.linea });
      else if (e.uso === 'compara') m.compara.push({ de: e.de, linea: e.linea });
      else m.otros++;
    }
    res[s.nombre] = { id: sid, archivo: s.archivo, linea: s.linea, miembros: s.miembros ?? [], usos: members };
  }
  return res;
}

export function buildDeadCode(factsMap, graph, tokenIdx) {
  const candidatos = [];
  for (const [id, s] of graph.symbols) {
    if (s.tipo === 'modulo' || s.tipo === 'inline') continue;
    if (!['funcion', 'metodo', 'componente', 'hook', 'clase', 'constante', 'objeto'].includes(s.tipo)) continue;
    const layer = layerOf(s.archivo);
    if (layer === 'prueba' || layer === 'operacion') continue;
    if (/\/(__mocks__)\//.test(s.archivo) || /\.config\./.test(s.archivo)) continue;
    // Símbolos locales anidados de componentes (handlers): no son candidatos aparte.
    if (s.ruta.includes('/')) continue;
    // Constantes/objetos privados no exportados con poco valor informativo: solo exportados.
    if ((s.tipo === 'constante' || s.tipo === 'objeto') && !s.exportado) continue;
    // Entradas implícitas: pantallas de expo-router, páginas, layouts.
    if (/^mobile\/app\//.test(s.archivo) || /^(admin|business|web)\/src\/(main|App)\.tsx$/.test(s.archivo)) continue;
    const ins = (graph.edgesIn.get(id) ?? []).filter((e) => {
      if (e.tipo === 'usa-tipo') return false;
      const from = graph.symbols.get(e.de);
      if (!from) return false;
      // Autorreferencia (misma clase/ámbito) no cuenta.
      if (e.de === id || e.de.startsWith(id + '.') || e.de.startsWith(id + '/')) return false;
      return true;
    });
    const prod = ins.filter((e) => layerOf(graph.symbols.get(e.de).archivo) !== 'prueba');
    if (prod.length) continue;
    const nombre = s.nombre;
    const files = tokenIdx.get(nombre);
    const otrosArchivos = files ? [...files].filter((f) => f !== s.archivo && layerOf(f) !== 'prueba') : [];
    // Clases: métodos se evalúan aparte; si la clase está viva, sus métodos "sin llamada" son candidatos de método.
    candidatos.push({
      id, tipo: s.tipo, archivo: s.archivo, linea: s.linea, exportado: !!s.exportado,
      nivel: ins.length ? 'solo-pruebas' : otrosArchivos.length ? 'solo-texto' : 'sin-referencias',
      mencionadoEn: otrosArchivos.slice(0, 5), probadoPor: ins.map((e) => graph.symbols.get(e.de).archivo).filter((f) => layerOf(f) === 'prueba').slice(0, 3),
    });
  }
  return candidatos;
}

/** Ciclos de importación entre archivos (Tarjan sobre imports de valor). */
export function buildCycles(factsMap) {
  const adj = new Map();
  for (const [f, fx] of factsMap) {
    if (layerOf(f) === 'prueba') continue;
    const out = [];
    for (const imp of fx.imports ?? []) {
      if (!imp.interno || imp.tipo === 'tipo' || !factsMap.has(imp.interno) || layerOf(imp.interno) === 'prueba') continue;
      out.push(imp.interno);
    }
    adj.set(f, [...new Set(out)]);
  }
  let index = 0;
  const idx = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const sccs = [];
  const strong = (v) => {
    // iterativo para evitar desbordar la pila
    const work = [[v, 0]];
    idx.set(v, index); low.set(v, index); index++; stack.push(v); onStack.add(v);
    while (work.length) {
      const top = work[work.length - 1];
      const [node, i] = top;
      const nbrs = adj.get(node) ?? [];
      if (i < nbrs.length) {
        top[1]++;
        const w = nbrs[i];
        if (!idx.has(w)) {
          idx.set(w, index); low.set(w, index); index++; stack.push(w); onStack.add(w);
          work.push([w, 0]);
        } else if (onStack.has(w)) low.set(node, Math.min(low.get(node), idx.get(w)));
      } else {
        if (low.get(node) === idx.get(node)) {
          const comp = [];
          let w;
          do { w = stack.pop(); onStack.delete(w); comp.push(w); } while (w !== node);
          if (comp.length > 1) sccs.push(comp.sort());
        }
        work.pop();
        if (work.length) {
          const parent = work[work.length - 1][0];
          low.set(parent, Math.min(low.get(parent), low.get(node)));
        }
      }
    }
  };
  for (const v of adj.keys()) if (!idx.has(v)) strong(v);
  return sccs.sort((a, b) => b.length - a.length);
}

export function buildDuplicates(graph) {
  const groups = new Map();
  for (const [id, s] of graph.symbols) {
    if (!s.hashCuerpo || layerOf(s.archivo) === 'prueba') continue;
    const k = s.hashCuerpo;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push({ id, archivo: s.archivo, linea: s.linea, largo: s.largoCuerpo });
  }
  return [...groups.entries()]
    .filter(([, g]) => g.length > 1 && new Set(g.map((x) => x.id)).size > 1)
    .map(([hash, g]) => ({ hash, largo: g[0].largo, copias: g }))
    .sort((a, b) => b.largo * b.copias.length - a.largo * a.copias.length);
}

export function buildTests(factsMap) {
  const out = [];
  for (const [file, fx] of factsMap) {
    if (fx.clase !== 'prueba') continue;
    const names = fx.misc?.pruebas.nombres ?? [];
    const imports = [...new Set((fx.imports ?? []).filter((i) => i.interno && layerOf(i.interno) !== 'prueba').map((i) => i.interno))];
    out.push({
      archivo: file, paquete: fx.paquete, lineas: fx.lineas,
      casos: names.filter((n) => n.tipo === 'it').length,
      omitidas: names.filter((n) => n.tipo === 'omitida').length,
      pendientes: names.filter((n) => n.tipo === 'todo').length,
      suites: names.filter((n) => n.tipo === 'describe').length,
      importa: imports.slice(0, 40),
      http: (fx.misc?.pruebas.http ?? []).length,
      nombres: names.slice(0, 80),
    });
  }
  return out.sort((a, b) => a.archivo.localeCompare(b.archivo));
}
