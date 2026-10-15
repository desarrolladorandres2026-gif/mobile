// Rutas HTTP del backend: Express routers, montajes, middlewares de guarda y manejador final.
import { rel, abs } from '../util.mjs';
import { makeResolver, repoRelOrNull } from './core.mjs';

const METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'all', 'head', 'options']);

/** Clasifica un middleware por nombre. */
function classifyMiddleware(name) {
  if (name === 'authenticate') return 'autenticacion';
  if (name === 'authorize') return 'roles';
  if (/^(requirePermission|requireAnyPermission|adminRequires|requireFinanceAdmin)$/.test(name)) return 'permiso';
  if (name === 'requireRole') return 'rol-rbac';
  if (name === 'rejectCounterScope') return 'alcance-sesion';
  if (name === 'validate') return 'validacion';
  if (/RateLimiter$|Limiter$/.test(name)) return 'limite';
  if (/^(upload|uploadSingle|uploadMemory)/.test(name) || /\.single|\.array|\.fields/.test(name)) return 'subida';
  if (/^identify/.test(name)) return 'identificacion-opcional';
  if (/cacheHeaders|cacheControl/.test(name)) return 'cache';
  return 'otro';
}

function textOfEnumArg(ts, arg) {
  // UserRole.CLIENT → "CLIENT"; Permission.ORDERS_VIEW_ALL → "ORDERS_VIEW_ALL"
  if (ts.isPropertyAccessExpression(arg)) return arg.name.text;
  if (ts.isStringLiteralLike(arg)) return arg.text;
  return arg.getText().slice(0, 40);
}

export function extractRoutes(ctx, sf, namer, factsOfFile) {
  const { ts } = ctx;
  const R = ctx.resolver || (ctx.resolver = makeResolver(ctx, namer));
  const file = rel(sf.fileName);
  const lineAt = (n) => sf.getLineAndCharacterOfPosition(n.getStart()).line + 1;
  const importFile = new Map(); // nombre local -> archivo del repo
  for (const imp of factsOfFile.imports) {
    for (const n of imp.nombres) importFile.set(n.replace('* as ', ''), imp.interno);
  }

  const routerVars = new Set();
  const out = { rutas: [], montajes: [], middlewaresDeRouter: [], appRutas: [] };
  const routerLevel = []; // middlewares aplicados con router.use(mw) hasta ese punto

  const describeMw = (arg) => {
    const flat = [];
    const walk = (a, d = 0) => {
      a = namer.strip(a);
      if (ts.isArrayLiteralExpression(a)) a.elements.forEach((x) => walk(x, d + 1));
      else if (ts.isSpreadElement(a)) walk(a.expression, d + 1);
      else if (ts.isIdentifier(a) && d < 4) {
        // const guardas = [authenticate, authorize(ADMIN)] as const;  → ...guardas
        const r = R.resolveDecl(a);
        const dcl = r?.decls?.[0];
        const init = dcl && ts.isVariableDeclaration(dcl) && dcl.initializer ? namer.strip(dcl.initializer) : null;
        if (init && ts.isArrayLiteralExpression(init)) init.elements.forEach((x) => walk(x, d + 1));
        else flat.push(a);
      } else flat.push(a);
    };
    walk(arg);
    return flat.map((a) => {
      if (ts.isIdentifier(a)) {
        const t = R.targetOf(a);
        return { nombre: a.text, tipo: classifyMiddleware(a.text), args: [], simbolo: t?.id ?? null };
      }
      if (ts.isCallExpression(a)) {
        const callee = a.expression;
        const nm = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.getText() : callee.getText().slice(0, 40);
        const t = R.targetOf(callee);
        return { nombre: nm, tipo: classifyMiddleware(nm), args: a.arguments.map((x) => textOfEnumArg(ts, x)), simbolo: t?.id ?? null };
      }
      if (ts.isPropertyAccessExpression(a)) {
        return { nombre: a.getText(), tipo: classifyMiddleware(a.getText()), args: [], simbolo: null };
      }
      return { nombre: a.getText().slice(0, 30), tipo: 'otro', args: [], simbolo: null };
    });
  };

  const isFn = (n) => namer.isFnExpr(namer.strip(n));
  /** Comentario inmediatamente anterior a la sentencia de la ruta (documenta la intención). */
  let sectionComment = '';
  const leadingComment = (callNode) => {
    let stmt = callNode;
    while (stmt && !ts.isExpressionStatement(stmt)) stmt = stmt.parent;
    if (!stmt) return null;
    const ranges = ts.getLeadingCommentRanges(sf.text, stmt.getFullStart());
    if (!ranges || !ranges.length) return null;
    const last = ranges[ranges.length - 1];
    const txt = sf.text.slice(last.pos, last.end).replace(/^\/\*+|\*+\/$/g, '').replace(/^\s*(\/\/|\*)\s?/gm, '').replace(/\s+/g, ' ').trim().slice(0, 240);
    if (txt) sectionComment = txt;
    return txt;
  };

  /** Primer destino interno invocado dentro del manejador. */
  const findHandlerTarget = (arg) => {
    const ex = namer.strip(arg);
    let found = null;
    const visitFn = (n) => {
      if (found) return;
      if (ts.isCallExpression(n)) {
        const t = R.targetOf(n.expression);
        if (t?.id && !/#<module>$/.test(t.id)) {
          // Ignora utilidades de respuesta; prioriza controlador/servicio.
          if (/\/(controllers|services)\//.test(t.id)) { found = t.id; return; }
        }
      }
      ts.forEachChild(n, visitFn);
    };
    if (ts.isIdentifier(ex) || ts.isPropertyAccessExpression(ex)) {
      const t = R.targetOf(ex);
      return t?.id ?? null;
    }
    if (ts.isCallExpression(ex) && !isFn(ex)) {
      // asyncHandler(controller.method) u otro envoltorio
      for (const a of ex.arguments) {
        const r = findHandlerTarget(a);
        if (r) return r;
      }
    }
    visitFn(ex);
    if (found) return found;
    // Último recurso: cualquier llamada a un símbolo del repo dentro del manejador.
    const visitAny = (n) => {
      if (found) return;
      if (ts.isCallExpression(n)) {
        const t = R.targetOf(n.expression);
        if (t?.id && !/#<module>$/.test(t.id) && !/\/utils\/response/.test(t.id)) { found = t.id; return; }
      }
      ts.forEachChild(n, visitAny);
    };
    visitAny(ex);
    return found;
  };

  const strLit = (n) => {
    if (!n) return null;
    if (ts.isStringLiteralLike(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
    if (ts.isTemplateExpression(n)) return n.head.text + n.templateSpans.map((s) => ':param' + s.literal.text).join('');
    if (ts.isArrayLiteralExpression(n)) return n.elements.map((e) => strLit(e)).filter(Boolean);
    return null;
  };

  const topStatements = (node) => {
    // Recorre sentencias de nivel superior y bloques de funciones init* que declaran rutas.
    const list = [];
    const walk = (n) => {
      if (ts.isExpressionStatement(n) || ts.isVariableStatement(n)) list.push(n);
      ts.forEachChild(n, (c) => { if (!ts.isExpressionStatement(c) && !ts.isVariableStatement(c)) walk(c); else list.push(c); });
    };
    ts.forEachChild(node, (c) => { if (ts.isExpressionStatement(c) || ts.isVariableStatement(c)) list.push(c); else walk(c); });
    return list;
  };

  for (const st of sf.statements) {
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.initializer) {
          const init = namer.strip(d.initializer);
          if (ts.isCallExpression(init) && /(^|\.)Router$/.test(init.expression.getText())) routerVars.add(d.name.text);
          if (ts.isCallExpression(init) && init.expression.getText() === 'express') routerVars.add(d.name.text); // app
        }
      }
    }
  }
  if (!routerVars.size) return out;

  const visitAll = (n) => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ts.isIdentifier(n.expression.expression) && routerVars.has(n.expression.expression.text)) {
      const recv = n.expression.expression.text;
      const m = n.expression.name.text;
      const args = [...n.arguments];
      if (m === 'use') {
        let pathArg = null;
        let rest = args;
        const first = args[0] && strLit(args[0]);
        if (first) { pathArg = first; rest = args.slice(1); }
        const mws = rest.flatMap(describeMw);
        // ¿Montaje de otro router?
        const last = rest[rest.length - 1];
        let mountFile = null;
        if (last && ts.isIdentifier(last)) {
          const t = R.targetOf(last);
          mountFile = importFile.get(last.text) ?? null;
          if (!mountFile && t?.id) mountFile = t.id.split('#')[0];
        }
        if (mountFile && mountFile.endsWith('.ts') && mountFile !== file && /(^|\/)routes\//.test(mountFile) && /routes?$|router$/i.test(last.getText())) {
          out.montajes.push({ padre: file, receptor: recv, prefijo: pathArg ?? '', hijo: mountFile, middlewares: mws.slice(0, -1).filter(Boolean), middlewaresRouterAntes: routerLevel.map((x) => x), linea: lineAt(n) });
        } else if (!pathArg) {
          routerLevel.push(...mws);
          out.middlewaresDeRouter.push({ archivo: file, receptor: recv, middlewares: mws, linea: lineAt(n) });
        } else {
          out.appRutas.push({ tipo: 'use', ruta: pathArg, middlewares: mws, archivo: file, linea: lineAt(n) });
        }
      } else if (METHODS.has(m) && args.length >= 1) {
        const p = strLit(args[0]);
        if (p !== null) {
          const paths = Array.isArray(p) ? p : [p];
          const handlerArg = args[args.length - 1];
          const mwArgs = args.slice(1, -1);
          const mws = mwArgs.flatMap(describeMw);
          const handlerSym = args.length > 1 ? findHandlerTarget(handlerArg) : null;
          for (const pp of paths) {
            out.rutas.push({
              receptor: recv,
              metodo: m.toUpperCase(),
              rutaLocal: pp,
              archivo: file,
              linea: lineAt(n),
              lineaFin: sf.getLineAndCharacterOfPosition(n.getEnd()).line + 1,
              middlewares: mws,
              middlewaresRouter: routerLevel.map((x) => x),
              comentario: leadingComment(n),
              seccion: sectionComment,
              manejador: handlerSym,
              manejadorEnLinea: args.length > 1 ? isFn(handlerArg) : false,
            });
          }
        }
      }
    }
    ts.forEachChild(n, visitAll);
  };
  visitAll(sf);
  return out;
}

/** Une montajes y rutas en rutas absolutas. `montajes` incluye app.ts. */
export function resolveRoutes(allRouteFacts, config = {}) {
  const byFile = new Map();
  const mounts = [];
  for (const f of allRouteFacts) {
    for (const r of f.rutas) {
      if (!byFile.has(r.archivo)) byFile.set(r.archivo, []);
      byFile.get(r.archivo).push(r);
    }
    for (const m of f.montajes) mounts.push(m);
  }
  // archivo hijo -> [{padre, prefijo, middlewares}]
  const parentsOf = new Map();
  for (const m of mounts) {
    if (!parentsOf.has(m.hijo)) parentsOf.set(m.hijo, []);
    parentsOf.get(m.hijo).push(m);
  }
  const prefixesOf = (file, depth = 0, seen = new Set()) => {
    if (depth > 8 || seen.has(file)) return [{ prefijo: '', middlewares: [], cadena: [file] }];
    const ps = parentsOf.get(file);
    if (!ps) return [{ prefijo: '', middlewares: [], cadena: [file] }];
    const out = [];
    for (const p of ps) {
      for (const up of prefixesOf(p.padre, depth + 1, new Set([...seen, file]))) {
        out.push({ prefijo: joinPath(up.prefijo, p.prefijo), middlewares: [...up.middlewares, ...(p.middlewaresRouterAntes ?? []), ...p.middlewares], cadena: [...up.cadena, file] });
      }
    }
    return out;
  };
  const result = [];
  for (const [file, routes] of byFile) {
    const prefs = prefixesOf(file);
    for (const r of routes) {
      for (const pf of prefs) {
        const full = normalizePath(joinPath(pf.prefijo, r.rutaLocal));
        const mws = [...pf.middlewares, ...r.middlewaresRouter, ...r.middlewares];
        result.push({
          id: `${r.metodo} ${full}`,
          metodo: r.metodo,
          ruta: full,
          rutaLocal: r.rutaLocal,
          archivo: r.archivo,
          linea: r.linea,
          lineaFin: r.lineaFin,
          montadaEn: pf.cadena,
          montada: pf.cadena.length > 1,
          middlewares: mws,
          manejador: r.manejador,
          comentario: r.comentario ?? null,
          seccion: r.seccion ?? null,
        });
      }
    }
  }
  return result;
}

export const joinPath = (a, b) => `${a.replace(/\/+$/, '')}/${String(b).replace(/^\/+/, '')}`.replace(/\/+$/, '') || '/';
export function normalizePath(p) {
  let s = p.replace(/\/{2,}/g, '/');
  if (s.length > 1) s = s.replace(/\/+$/, '');
  return s || '/';
}
