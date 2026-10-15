// Endpoints: guardas, cierre de ejecución del manejador y correspondencia con las llamadas de los frontends.
import { resolveRoutes } from './extract/routes.mjs';
import { bfs, modelAccessKind } from './graph.mjs';

export const API_PREFIX = '/api/v1';

const PERM_FUNCS = /#(can|hasPermission|hasEffectivePermission|hasAnyEffectivePermission|assertCan\w*|requirePermission|requireAnyPermission)$/;

function summarizeGuards(route) {
  const mws = route.middlewares ?? [];
  const g = {
    autenticada: false, roles: [], permisos: [], permisosCualquiera: [], soloAdminPermisos: [], rolRbac: [], finanzas: false,
    rechazaMostrador: false, validadores: [], limites: [], subidas: [], publica: true, otros: [],
  };
  for (const m of mws) {
    switch (m.tipo) {
      case 'autenticacion': g.autenticada = true; break;
      case 'roles': g.roles.push(...m.args); break;
      case 'permiso':
        if (m.nombre === 'requirePermission') g.permisos.push(...m.args);
        else if (m.nombre === 'requireAnyPermission') g.permisosCualquiera.push(...m.args);
        else if (m.nombre === 'adminRequires') g.soloAdminPermisos.push(...m.args);
        else if (m.nombre === 'requireFinanceAdmin') { g.finanzas = true; g.permisos.push('FINANCE_MANAGE'); }
        break;
      case 'rol-rbac': g.rolRbac.push(...m.args); break;
      case 'alcance-sesion': g.rechazaMostrador = true; break;
      case 'validacion': g.validadores.push(...m.args); break;
      case 'limite': g.limites.push(m.nombre); break;
      case 'subida': g.subidas.push(m.nombre); break;
      default: g.otros.push(m.nombre);
    }
  }
  g.publica = !g.autenticada;
  g.roles = [...new Set(g.roles)];
  return g;
}

export function buildEndpoints(factsMap, graph, config) {
  const rf = [...factsMap.values()].filter((f) => f.rutasHttp).map((f) => f.rutasHttp);
  const routes = resolveRoutes(rf);
  const endpoints = [];
  const testsHttp = [];
  for (const [file, fx] of factsMap) for (const t of fx.misc?.pruebas.http ?? []) testsHttp.push({ ...t, archivo: file });

  for (const r of routes) {
    const guards = summarizeGuards(r);
    const ep = {
      id: r.id,
      metodo: r.metodo,
      ruta: r.ruta,
      archivo: r.archivo,
      linea: r.linea,
      lineaFin: r.lineaFin,
      montadaEn: r.montadaEn,
      montada: r.montada,
      middlewares: r.middlewares.map((m) => ({ nombre: m.nombre, tipo: m.tipo, args: m.args })),
      guardas: guards,
      manejador: r.manejador,
      comentario: r.comentario ?? null,
      seccion: r.seccion ?? null,
    };
    ep.publicaDeclarada = guards.publica && /p[uú]blic|sin sesi[oó]n|sin autenticaci[oó]n|no auth|no requiere (sesi[oó]n|auth)|anonim|opcional/i.test(`${r.comentario ?? ''} ${r.seccion ?? ''}`);
    // Cierre de ejecución del manejador.
    if (r.manejador && graph.symbols.has(r.manejador)) {
      const seen = bfs(graph, [r.manejador], { maxDepth: 7, maxNodes: 2500, follow: (e) => !/\/(__tests__)\//.test(e.a) });
      const servicios = new Set();
      const modelos = new Map();
      const externos = new Set();
      const permisosInternos = new Set();
      const eventos = new Set();
      const archivosCierre = new Set();
      let libro = false;
      let auditoria = false;
      let usaDinero = false;
      const nodos = [...seen.keys()];
      for (const id of nodos) {
        const s = graph.symbols.get(id);
        if (!s) continue;
        archivosCierre.add(s.archivo);
        if (/\/services\//.test(s.archivo) && s.tipo !== 'modulo') servicios.add(s.archivo);
        for (const e of graph.edgesOut.get(id) ?? []) {
          const tg = graph.symbols.get(e.a);
          if (tg && tg.tipo === 'modelo') {
            const kind = modelAccessKind(e);
            const cur = modelos.get(tg.nombre) ?? { lee: false, escribe: false };
            if (kind === 'write') cur.escribe = true; else if (kind === 'read') cur.lee = true;
            modelos.set(tg.nombre, cur);
          }
        }
        if (/ledger\.service\.ts#LedgerService\.post/.test(id)) libro = true;
        if (/security\/audit\.ts#(logAudit|logSystemAudit)$/.test(id)) auditoria = true;
        if (/utils\/money\.ts#/.test(id)) usaDinero = true;
        const fx = factsMap.get(s.archivo);
        if (fx) {
          for (const u of fx.usosExternos ?? []) if (u.de === id) externos.add(u.modulo);
          for (const ev of fx.misc?.eventos ?? []) if (ev.de === id && ev.direccion === 'emite') eventos.add(ev.evento);
        }
        // Permisos comprobados dentro: funciones que consultan `can(...)`.
        for (const e of graph.edgesOut.get(id) ?? []) {
          if (PERM_FUNCS.test(e.a)) {
            for (const e2 of graph.edgesOut.get(id) ?? []) if (e2.tipo === 'usa-enum' && /rbac\.ts#Permission$/.test(e2.a) && e2.via) permisosInternos.add(e2.via);
          }
        }
      }
      // Los hallazgos de modelos: sólo los de nivel modelo `Order` (nombre de símbolo), no schema
      ep.cierre = {
        nodos: nodos.length,
        profundidad: Math.max(0, ...[...seen.values()].map((v) => v.prof)),
        servicios: [...servicios].sort(),
        modelos: Object.fromEntries([...modelos.entries()].sort()),
        externos: [...externos].sort(),
        eventos: [...eventos].sort(),
        libroMayor: libro,
        auditoria,
        usaDinero,
        permisosInternos: [...permisosInternos].sort(),
        archivos: [...archivosCierre].sort(),
      };
      ep.escribe = [...modelos.values()].some((m) => m.escribe);
    } else {
      ep.cierre = null;
      ep.escribe = false;
    }
    endpoints.push(ep);
  }

  // Pruebas que ejercitan el endpoint (supertest).
  const matchTemplate = buildMatcher(endpoints);
  for (const t of testsHttp) {
    const m = matchTemplate(t.metodo, stripPrefix(t.plantilla));
    t.endpoints = m.map((x) => x.id);
  }

  // Llamadas desde frontends.
  const calls = [];
  for (const [file, fx] of factsMap) {
    for (const c of fx.llamadasApi ?? []) {
      const pl = stripPrefix(c.plantilla);
      const externa = /^:p(\/|$)/.test(pl) || /^https?:/.test(pl);
      const m = externa ? [] : matchTemplate(c.metodo, pl);
      calls.push({ ...c, archivo: file, paquete: fx.paquete, plantillaApi: pl, externa, endpoints: m.map((x) => x.id), ambigua: m.length > 1 && m.every((x) => x.score === m[0].score), metodoOtro: externa || m.length ? [] : matchAnyMethod(endpoints, pl, c.metodo) });
    }
  }
  const byId = new Map(endpoints.map((e) => [e.id, e]));
  for (const c of calls) for (const id of c.endpoints) {
    const ep = byId.get(id);
    (ep.consumidores ??= []).push({ desde: c.desde, archivo: c.archivo, linea: c.linea, paquete: c.paquete });
  }
  for (const t of testsHttp) for (const id of t.endpoints) {
    const ep = byId.get(id);
    (ep.pruebas ??= []).push({ archivo: t.archivo, linea: t.linea });
  }
  return { endpoints, calls, testsHttp };
}

export const stripPrefix = (p) => (p.startsWith(API_PREFIX) ? p.slice(API_PREFIX.length) || '/' : p);

function segs(p) {
  const s = p.split('/').filter(Boolean);
  return s;
}

function buildMatcher(endpoints) {
  const index = new Map(); // `${metodo} ${n}` -> [{ep, segs}]
  for (const ep of endpoints) {
    const rel = stripPrefix(ep.ruta);
    const sg = segs(rel);
    const key = `${ep.metodo} ${sg.length}`;
    if (!index.has(key)) index.set(key, []);
    index.get(key).push({ ep, sg, rel });
  }
  return (metodo, plantilla) => {
    const sg = segs(plantilla.split('?')[0]);
    const res = [];
    for (const key of [`${metodo} ${sg.length}`, `ALL ${sg.length}`]) {
      for (const cand of index.get(key) ?? []) {
        let score = 0;
        let ok = true;
        for (let i = 0; i < sg.length; i++) {
          const a = sg[i];
          const b = cand.sg[i];
          const aParam = a.startsWith(':') || a === ':p';
          const bParam = b.startsWith(':');
          if (a === b) score += 3;
          else if (bParam) score += 1; // ruta con parámetro: acepta literal o parámetro
          else if (aParam) score += 0; // llamada con parámetro vs ruta literal: posible
          else { ok = false; break; }
        }
        if (ok) res.push({ id: cand.ep.id, score });
      }
    }
    if (!res.length) return [];
    const max = Math.max(...res.map((r) => r.score));
    // Una llamada con segmentos dinámicos sólo se acepta con la mejor puntuación.
    return res.filter((r) => r.score === max).map((r) => ({ id: r.id, score: r.score }));
  };
}

function matchAnyMethod(endpoints, plantilla, metodo) {
  const sg = segs(plantilla);
  const out = [];
  for (const ep of endpoints) {
    if (ep.metodo === metodo) continue;
    const e = segs(stripPrefix(ep.ruta));
    if (e.length !== sg.length) continue;
    if (e.every((x, i) => x === sg[i] || x.startsWith(':') || sg[i].startsWith(':'))) out.push(ep.metodo);
  }
  return [...new Set(out)];
}
