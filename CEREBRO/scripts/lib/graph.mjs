// Grafo de símbolos: resuelve las aristas "difusas" (props, variables locales, stores, interfaces) y construye índices.
import { classifyModelMethod } from './extract/core.mjs';

const RQ_NAMES = /^(useMutation|useQuery|useInfiniteQuery|useSuspenseQuery|useQueries)$/;

export function buildGraph(factsMap) {
  const symbols = new Map(); // id -> registro
  const byFile = new Map();
  const varInits = new Map(); // clave -> info
  const bindings = new Map(); // hijo -> prop -> [{handler, padre}]
  const implementors = new Map(); // interfaz/clase -> [clases que la extienden/implementan]
  const fileFacts = factsMap;
  const modelByName = new Map();

  for (const [file, fx] of factsMap) {
    byFile.set(file, []);
    for (const s of fx.simbolos) {
      const rec = { ...s, paquete: fx.paquete, claseArchivo: fx.clase };
      symbols.set(s.id, rec);
      byFile.get(file).push(s.id);
      if (s.tipo === 'modelo') { modelByName.set(s.ruta, s.id); }
    }
    for (const v of fx.varInits ?? []) varInits.set(v.clave, { ...v, archivo: file });
    for (const b of fx.bindingsProps ?? []) {
      if (!bindings.has(b.hijo)) bindings.set(b.hijo, new Map());
      const m = bindings.get(b.hijo);
      if (!m.has(b.prop)) m.set(b.prop, []);
      m.get(b.prop).push({ handler: b.handler, padre: b.padre, archivo: file, linea: b.linea });
    }
    for (const h of fx.herencia ?? []) {
      if (!h.destino) continue;
      if (!implementors.has(h.destino)) implementors.set(h.destino, []);
      implementors.get(h.destino).push({ clase: h.clase, tipo: h.tipo });
    }
  }

  const componentOfId = (id) => {
    const [f, p] = id.split('#');
    const parts = p.split(/(?=[./])/); // conserva separadores al inicio de cada segmento
    let acc = '';
    let best = null;
    for (const part of parts) {
      acc += part;
      const cand = `${f}#${acc}`;
      const s = symbols.get(cand);
      if (s && (s.tipo === 'componente' || s.tipo === 'hook')) best = cand;
    }
    if (best) return best;
    return `${f}#${p.split(/[./]/)[0]}`;
  };

  /** Resuelve un destino difuso a ids concretos. Devuelve [{a, conf, via}] */
  function resolveFuzzy(e, fileOfEdge, depth = 0) {
    const out = [];
    const a = e.a;
    if (a.startsWith('prop:')) {
      if (depth > 4) return out;
      const comp = e.componente;
      const m = comp && bindings.get(comp);
      const list = m?.get(a.slice(5)) ?? [];
      for (const b of list) {
        if (b.handler.startsWith('prop:')) {
          const upComp = componentOfId(b.padre);
          out.push(...resolveFuzzy({ a: b.handler, componente: upComp }, fileOfEdge, depth + 1).map((x) => ({ ...x, via: `prop ${a.slice(5)} → ${b.handler.slice(5)}` })));
        } else if (b.handler.startsWith('var:')) {
          out.push(...resolveFuzzy({ a: b.handler, miembro: null, via: null }, fileOfEdge, depth + 1));
        } else out.push({ a: b.handler, conf: 'inferida', via: `prop ${a.slice(5)}` });
      }
      return out;
    }
    if (a.startsWith('var:')) {
      const key = a.slice(4);
      const init = varInits.get(key);
      if (!init) return out;
      const member = e.miembro || e.via || null;
      if (RQ_NAMES.test(init.hookNombre)) {
        for (const inner of init.internas) {
          if (/\.(mutationFn)$/.test(inner) && /^(mutate|mutateAsync)$/.test(member ?? '')) out.push({ a: inner, conf: 'inferida', via: 'react-query mutate' });
          else if (/\.(queryFn)$/.test(inner) && /^(refetch|fetchNextPage|fetchPreviousPage)$/.test(member ?? '')) out.push({ a: inner, conf: 'inferida', via: 'react-query refetch' });
        }
        return out;
      }
      if (init.hook && symbols.has(init.hook)) {
        const H = init.hook;
        const hs = symbols.get(H);
        // Store (zustand): selector → miembro del store.
        const memberName = init.selector || member;
        if (memberName) {
          const storeMember = `${H}.${memberName}`;
          if (symbols.has(storeMember)) { out.push({ a: storeMember, conf: 'inferida', via: 'store' }); return out; }
          const nested = `${H}/${memberName}`;
          if (symbols.has(nested)) { out.push({ a: nested, conf: 'inferida', via: 'hook-retorno' }); return out; }
        }
        // Hook propio que envuelve react-query.
        const prefixes = [`${H}/`, `${H}.`];
        for (const [sid, srec] of symbols) {
          if (srec.archivo !== hs.archivo) continue;
          if (!prefixes.some((p) => sid.startsWith(p))) continue;
          if (/\.(mutationFn)$/.test(sid) && /^(mutate|mutateAsync)$/.test(member ?? '')) out.push({ a: sid, conf: 'inferida', via: 'hook propio + react-query mutate' });
          else if (/\.(queryFn)$/.test(sid) && /^(refetch|fetchNextPage|fetchPreviousPage)$/.test(member ?? '')) out.push({ a: sid, conf: 'inferida', via: 'hook propio + react-query refetch' });
        }
        // Un hook propio sin react-query dentro: el miembro se llama sobre lo que devuelve; sin destino fiable.
      }
      return out;
    }
    if (e.via === 'firma-interfaz') {
      const owner = e.ownerId;
      const member = e.miembro;
      const found = [];
      if (owner && implementors.has(owner)) {
        for (const impl of implementors.get(owner)) {
          const cand = `${impl.clase}.${member}`;
          if (symbols.has(cand)) found.push({ a: cand, conf: 'inferida', via: `${impl.tipo} ${owner.split('#')[1]}` });
        }
      }
      if (!found.length && e.archivoDecl) {
        // Store u objeto en el mismo archivo con ese miembro.
        for (const sid of byFile.get(e.archivoDecl) ?? []) {
          const s = symbols.get(sid);
          if (s.tipo === 'metodo' && new RegExp(`^[A-Za-z0-9_$]+\\.${member}$`).test(s.ruta)) found.push({ a: sid, conf: 'inferida', via: 'miembro del mismo archivo' });
        }
      }
      return found;
    }
    return out;
  }

  const edgesOut = new Map();
  const edgesIn = new Map();
  const pushEdge = (de, a, tipo, conf, linea, via, extra) => {
    if (de === a) return;
    const e = { de, a, tipo, conf, linea, via: via ?? null, ...extra };
    if (!edgesOut.has(de)) edgesOut.set(de, []);
    edgesOut.get(de).push(e);
    if (!edgesIn.has(a)) edgesIn.set(a, []);
    edgesIn.get(a).push(e);
  };
  const rotas = [];
  for (const [file, fx] of factsMap) {
    for (const e of fx.aristas) {
      const conf = e.conf ?? 'estatica';
      let tipo = e.tipo;
      if (e.a.startsWith('modelo-doc:')) {
        const mid = modelByName.get(e.a.slice(11));
        if (mid) pushEdge(e.de, mid, 'llama', 'inferida', e.linea, e.via, { lineas: e.lineas });
        continue;
      }
      if (e.a.startsWith('prop:') || e.a.startsWith('var:') || e.via === 'firma-interfaz') {
        const res = resolveFuzzy(e, file);
        for (const r of res) if (symbols.has(r.a)) pushEdge(e.de, r.a, 'llama', r.conf, e.linea, r.via);
        continue;
      }
      const target = symbols.get(e.a);
      if (!target) continue;
      if (tipo === 'referencia' && (target.tipo === 'enum' || target.tipo === 'interfaz' || target.tipo === 'tipo')) tipo = 'usa-tipo';
      if (tipo === 'referencia' && e.via && target.tipo === 'enum') continue; // duplicado de usa-enum
      pushEdge(e.de, e.a, tipo, conf, e.linea, e.via, { uso: e.uso ?? null, lineas: e.lineas });
    }
    for (const h of fx.herencia ?? []) {
      if (h.destino && symbols.has(h.destino)) pushEdge(h.clase, h.destino, h.tipo === 'extends' ? 'extiende' : 'implementa', 'estatica', h.linea, null);
    }
  }
  return { symbols, byFile, edgesOut, edgesIn, varInits, bindings, implementors, componentOfId, resolveFuzzy };
}

/** Clasifica una arista hacia un modelo: lectura/escritura. */
export function modelAccessKind(edge) {
  if (edge.tipo === 'instancia') return 'write';
  if (edge.tipo === 'llama') return classifyModelMethod(edge.via ?? '');
  return 'other';
}

/** BFS por llamadas. `follow(edge)` decide si se sigue. Devuelve Map(id -> {padre, profundidad}). */
export function bfs(graph, starts, { maxDepth = 8, maxNodes = 4000, follow = () => true } = {}) {
  const seen = new Map();
  const queue = [];
  for (const s of starts) if (!seen.has(s)) { seen.set(s, { padre: null, prof: 0, via: null }); queue.push(s); }
  while (queue.length && seen.size < maxNodes) {
    const cur = queue.shift();
    const info = seen.get(cur);
    if (info.prof >= maxDepth) continue;
    for (const e of graph.edgesOut.get(cur) ?? []) {
      if (e.tipo !== 'llama' && e.tipo !== 'referencia' && e.tipo !== 'instancia') continue;
      if (!follow(e)) continue;
      if (seen.has(e.a)) continue;
      seen.set(e.a, { padre: cur, prof: info.prof + 1, via: e });
      queue.push(e.a);
    }
  }
  return seen;
}

export function pathTo(seen, id) {
  const path = [];
  for (let cur = id; cur; cur = seen.get(cur)?.padre) path.push(cur);
  return path.reverse();
}
