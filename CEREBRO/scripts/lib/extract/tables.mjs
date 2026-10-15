// Tablas de configuración de dominio (máquinas de estado, permisos por rol…) evaluadas desde el AST.
import { rel } from '../util.mjs';

const TABLE_NAME = /(TRANSITIONS|_STATUSES|STATUSES|ALLOWED_STATUSES|ROLE_PERMISSIONS|_PERMISSIONS|PERMISSION_MATRIX|ROLE_MATRIX|CANCELLER_BY_ROLE|_ROLES|ROLE_ALLOWED|TERMINAL_\w+|COMMISSION\w*|FEE\w*|RATE\w*|_BPS|_MS|THRESHOLD\w*|LIMIT\w*|MAX_\w+|MIN_\w+|DEFAULT_\w+)$/;
const STATE_ONLY = /(TRANSITIONS|STATUSES|ALLOWED_STATUSES|ROLE_ALLOWED|CANCELLER_BY_ROLE|ROLE_PERMISSIONS|_PERMISSIONS|PERMISSION_MATRIX|ROLE_MATRIX)$/;

/** Evalúa una expresión literal a una estructura JSON; lo no evaluable queda como texto marcado. */
export function evalNode(ts, namer, node, depth = 0) {
  node = namer.strip(node);
  if (!node || depth > 6) return { _texto: node ? node.getText().slice(0, 100) : '' };
  if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isPropertyAccessExpression(node)) {
    const base = node.expression.getText();
    if (/^[A-Z][A-Za-z]+$/.test(base)) return { _enum: base, miembro: node.name.text };
    return { _texto: node.getText().slice(0, 100) };
  }
  if (ts.isArrayLiteralExpression(node)) return node.elements.map((e) => (ts.isSpreadElement(e) ? { _spread: e.expression.getText().slice(0, 80) } : evalNode(ts, namer, e, depth + 1)));
  if (ts.isObjectLiteralExpression(node)) {
    const o = {};
    for (const p of node.properties) {
      if (ts.isSpreadAssignment(p)) { (o._spreads ??= []).push(p.expression.getText().slice(0, 80)); continue; }
      if (!ts.isPropertyAssignment(p) && !ts.isShorthandPropertyAssignment(p)) continue;
      let key;
      if (ts.isComputedPropertyName(p.name)) {
        const k = evalNode(ts, namer, p.name.expression, depth + 1);
        key = k && k._enum ? `${k._enum}.${k.miembro}` : (typeof k === 'string' ? k : JSON.stringify(k));
      } else key = namer.keyText(p.name);
      o[key] = ts.isShorthandPropertyAssignment(p) ? { _texto: p.name.text } : evalNode(ts, namer, p.initializer, depth + 1);
    }
    return o;
  }
  if (ts.isCallExpression(node) || ts.isBinaryExpression(node) || ts.isIdentifier(node) || ts.isConditionalExpression(node) || ts.isPrefixUnaryExpression(node)) {
    return { _texto: node.getText().replace(/\s+/g, ' ').slice(0, 140) };
  }
  return { _texto: node.getText().replace(/\s+/g, ' ').slice(0, 100) };
}

export function extractTables(ctx, sf, namer, factsOfFile) {
  const { ts } = ctx;
  const file = rel(sf.fileName);
  const out = [];
  const lineAt = (n) => sf.getLineAndCharacterOfPosition(n.getStart()).line + 1;
  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st)) continue;
    for (const d of st.declarationList.declarations) {
      if (!ts.isIdentifier(d.name) || !d.initializer) continue;
      const nm = d.name.text;
      if (!TABLE_NAME.test(nm)) continue;
      const init = namer.strip(d.initializer);
      const interesting = ts.isObjectLiteralExpression(init) || ts.isArrayLiteralExpression(init) || ts.isNumericLiteral(init) || ts.isBinaryExpression(init) || ts.isCallExpression(init) || ts.isPrefixUnaryExpression(init);
      if (!interesting) continue;
      const esEstado = STATE_ONLY.test(nm);
      // Constantes numéricas/expresiones: solo las que parecen dinero, tiempo o límites.
      if (!esEstado && !(ts.isNumericLiteral(init) || ts.isBinaryExpression(init) || ts.isPrefixUnaryExpression(init))) continue;
      out.push({
        nombre: nm,
        id: `${file}#${nm}`,
        archivo: file,
        linea: lineAt(d),
        lineaFin: sf.getLineAndCharacterOfPosition(d.getEnd()).line + 1,
        exportada: !!st.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword),
        categoria: esEstado ? 'dominio' : 'constante',
        valor: evalNode(ts, namer, init),
        texto: init.getText().replace(/\s+/g, ' ').slice(0, 200),
      });
    }
  }
  return out;
}
