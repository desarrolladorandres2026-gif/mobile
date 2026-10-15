// Llamadas HTTP desde los frontends (axios / fetch) hacia la API de ZIPP.
import { rel } from '../util.mjs';
import { makeResolver } from './core.mjs';

const HTTP = new Set(['get', 'post', 'put', 'patch', 'delete', 'request', 'head']);
const BASE_NAME = /(^|\.)(API_?(URL|BASE|ORIGIN)|BASE_?URL|API_BASE|apiUrl|apiBase)$/i;

/** Normaliza una expresión de URL a plantilla "/a/:p/b". */
export function urlTemplate(ctx, expr, namer) {
  const { ts, checker } = ctx;
  const parts = [];
  let dinamica = false;
  let desconocida = false;
  const lit = (e) => {
    e = namer.strip(e);
    if (ts.isStringLiteralLike(e) || ts.isNoSubstitutionTemplateLiteral(e)) { parts.push(e.text); return; }
    if (ts.isTemplateExpression(e)) {
      parts.push(e.head.text);
      e.templateSpans.forEach((s, i) => {
        const ex = s.expression.getText();
        if (i === 0 && !e.head.text && BASE_NAME.test(ex)) { /* base de la API */ }
        else if (/^encodeURIComponent\(/.test(ex) || /id$|Id$|slug|code|key|token/i.test(ex) || true) { parts.push(':p'); dinamica = true; }
        parts.push(s.literal.text);
      });
      return;
    }
    if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) { lit(e.left); lit(e.right); return; }
    if (ts.isIdentifier(e) || ts.isPropertyAccessExpression(e)) {
      if (BASE_NAME.test(e.getText())) return;
      try {
        const t = checker.getTypeAtLocation(e);
        if (t && t.isStringLiteral && t.isStringLiteral()) { parts.push(t.value); return; }
      } catch { /* sin tipo */ }
      parts.push(':p'); dinamica = true; desconocida = true;
      return;
    }
    if (ts.isConditionalExpression(e)) { lit(e.whenTrue); return; }
    parts.push(':p'); dinamica = true; desconocida = true;
  };
  lit(expr);
  let t = parts.join('');
  const q = t.indexOf('?');
  const consulta = q >= 0 ? t.slice(q + 1) : null;
  if (q >= 0) t = t.slice(0, q);
  t = t.replace(/\/{2,}/g, '/');
  return { plantilla: t, dinamica, desconocida, consulta };
}

const typeProps = (ctx, node) => {
  const { checker } = ctx;
  try {
    const t = checker.getTypeAtLocation(node);
    if (!t) return [];
    const props = checker.getPropertiesOfType(t).map((p) => p.name);
    return props.slice(0, 60);
  } catch {
    return [];
  }
};

const objKeys = (ctx, namer, node) => {
  const { ts } = ctx;
  node = namer.strip(node);
  if (ts.isObjectLiteralExpression(node)) {
    const keys = [];
    let spread = false;
    for (const p of node.properties) {
      if (ts.isSpreadAssignment(p)) { spread = true; continue; }
      const k = namer.keyText(p.name);
      if (k) keys.push(k);
    }
    if (spread) for (const k of typeProps(ctx, node)) if (!keys.includes(k)) keys.push(k);
    return keys;
  }
  return typeProps(ctx, node);
};

export function extractFrontendCalls(ctx, sf, namer) {
  const { ts, checker } = ctx;
  const R = ctx.resolver || (ctx.resolver = makeResolver(ctx, namer));
  const file = rel(sf.fileName);
  const out = [];
  const stack = [`${file}#<module>`];
  const lineAt = (n) => sf.getLineAndCharacterOfPosition(n.getStart()).line + 1;

  const isHttpReceiver = (recv) => {
    const txt = recv.getText();
    if (/^(api|axios|client|http|apiClient|instance)$/.test(txt)) return true;
    try {
      const t = checker.getTypeAtLocation(recv);
      const name = t?.symbol?.name ?? t?.aliasSymbol?.name ?? '';
      if (/Axios/.test(name)) return true;
    } catch { /* ignorar */ }
    return false;
  };

  const visit = (n) => {
    const kind = namer.symbolKind(n, sf);
    let pushed = false;
    if (kind) {
      const p = namer.scopePath(n);
      if (p) { stack.push(`${file}#${p}`); pushed = true; }
    }
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      let metodo = null;
      let urlArg = null;
      let bodyArg = null;
      let cfgArg = null;
      let via = 'axios';
      if (ts.isPropertyAccessExpression(callee) && HTTP.has(callee.name.text) && isHttpReceiver(callee.expression)) {
        const m = callee.name.text;
        if (m === 'request') {
          const cfg = n.arguments[0] && namer.strip(n.arguments[0]);
          if (cfg && ts.isObjectLiteralExpression(cfg)) {
            for (const pr of cfg.properties) {
              if (!ts.isPropertyAssignment(pr)) continue;
              const k = namer.keyText(pr.name);
              if (k === 'url') urlArg = pr.initializer;
              else if (k === 'method') metodo = ts.isStringLiteralLike(pr.initializer) ? pr.initializer.text.toUpperCase() : null;
              else if (k === 'data') bodyArg = pr.initializer;
            }
          }
          metodo ??= 'DESCONOCIDO';
        } else {
          metodo = m.toUpperCase();
          urlArg = n.arguments[0];
          if (m === 'post' || m === 'put' || m === 'patch') { bodyArg = n.arguments[1]; cfgArg = n.arguments[2]; }
          else cfgArg = n.arguments[1];
        }
      } else if (ts.isIdentifier(callee) && callee.text === 'fetch') {
        via = 'fetch';
        urlArg = n.arguments[0];
        metodo = 'GET';
        const init = n.arguments[1] && namer.strip(n.arguments[1]);
        if (init && ts.isObjectLiteralExpression(init)) {
          for (const pr of init.properties) {
            if (!ts.isPropertyAssignment(pr)) continue;
            const k = namer.keyText(pr.name);
            if (k === 'method' && ts.isStringLiteralLike(pr.initializer)) metodo = pr.initializer.text.toUpperCase();
            if (k === 'body') bodyArg = pr.initializer;
          }
        }
      }
      if (metodo && urlArg) {
        const u = urlTemplate(ctx, urlArg, namer);
        let cuerpo = [];
        if (bodyArg) {
          const b = namer.strip(bodyArg);
          // JSON.stringify({..}) / FormData
          if (ts.isCallExpression(b) && /JSON\.stringify$/.test(b.expression.getText()) && b.arguments[0]) cuerpo = objKeys(ctx, namer, b.arguments[0]);
          else cuerpo = objKeys(ctx, namer, b);
        }
        let params = [];
        if (cfgArg) {
          const c = namer.strip(cfgArg);
          if (ts.isObjectLiteralExpression(c)) {
            for (const pr of c.properties) {
              if (ts.isPropertyAssignment(pr) && namer.keyText(pr.name) === 'params') params = objKeys(ctx, namer, pr.initializer);
              else if (ts.isShorthandPropertyAssignment(pr) && pr.name.text === 'params') params = typeProps(ctx, pr.name);
            }
          }
        }
        if (u.consulta) params = [...new Set([...params, ...u.consulta.split('&').map((x) => x.split('=')[0]).filter(Boolean)])];
        out.push({
          desde: stack[stack.length - 1], archivo: file, linea: lineAt(n), metodo, plantilla: u.plantilla,
          dinamica: u.dinamica, desconocida: u.desconocida, cuerpo, parametros: params, via,
        });
      }
    }
    ts.forEachChild(n, visit);
    if (pushed) stack.pop();
  };
  visit(sf);
  return out;
}
