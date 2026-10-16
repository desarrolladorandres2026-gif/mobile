// Modelos Mongoose: campos, referencias, índices, hooks.
import { rel } from '../util.mjs';

const text = (n, max = 120) => n.getText().replace(/\s+/g, ' ').slice(0, max);

export function extractModels(ctx, sf, namer) {
  const { ts } = ctx;
  const file = rel(sf.fileName);
  const lineAt = (n) => sf.getLineAndCharacterOfPosition(n.getStart()).line + 1;
  const schemas = new Map(); // nombre var -> { node, interfaz }
  const models = [];
  const result = [];

  const OPTION_KEYS = new Set(['type', 'default', 'required', 'min', 'max', 'enum', 'ref', 'unique', 'index', 'validate', 'trim', 'lowercase', 'uppercase', 'maxlength', 'minlength', 'select', 'sparse', 'immutable', 'of', 'get', 'set']);
  const optionObjects = new Map();
  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st)) continue;
    for (const d of st.declarationList.declarations) {
      if (ts.isIdentifier(d.name) && d.initializer && ts.isObjectLiteralExpression(namer.strip(d.initializer))) optionObjects.set(d.name.text, namer.strip(d.initializer));
    }
  }
  /** Propiedades de un literal de opciones, expandiendo los spreads de objetos conocidos del archivo. */
  const specProps = (obj, depth = 0) => {
    const out = [];
    for (const q of obj.properties) {
      if (ts.isSpreadAssignment(q)) {
        const e = namer.strip(q.expression);
        const ref = ts.isIdentifier(e) ? optionObjects.get(e.text) : null;
        if (ref && depth < 3) out.push(...specProps(ref, depth + 1));
        else out.push({ spreadDesconocido: true });
      } else if (ts.isPropertyAssignment(q)) out.push(q);
    }
    return out;
  };
  const looksLikeSpec = (obj) => specProps(obj).some((q) => q.spreadDesconocido || (q.name && OPTION_KEYS.has(namer.keyText(q.name) ?? '')));

  const visit = (n) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      const init = namer.strip(n.initializer);
      if (ts.isNewExpression(init) && /Schema$/.test(init.expression.getText())) {
        schemas.set(n.name.text, { init, decl: n, generico: init.typeArguments?.[0]?.getText() ?? null });
      } else if (ts.isCallExpression(init) && /(^|\.)model$/.test(init.expression.getText())) {
        const nameArg = init.arguments[0];
        const schemaArg = init.arguments[1];
        models.push({
          variable: n.name.text,
          nombre: nameArg && ts.isStringLiteralLike(nameArg) ? nameArg.text : n.name.text,
          schemaVar: schemaArg && ts.isIdentifier(schemaArg) ? schemaArg.text : null,
          coleccion: init.arguments[2] && ts.isStringLiteralLike(init.arguments[2]) ? init.arguments[2].text : null,
          linea: lineAt(n),
          lineaFin: sf.getLineAndCharacterOfPosition(n.getEnd()).line + 1,
        });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);

  const fieldsOf = (obj, prefix, depth, out) => {
    for (const p of obj.properties) {
      if (!ts.isPropertyAssignment(p)) continue;
      const key = namer.keyText(p.name);
      if (!key) continue;
      const name = prefix ? `${prefix}.${key}` : key;
      const v = namer.strip(p.initializer);
      const field = { nombre: name, linea: lineAt(p), tipo: null, requerido: false, ref: null, enum: false, unico: false, indice: false, default: null, min: null, max: null, array: false, validador: false };
      let spec = null;
      if (ts.isObjectLiteralExpression(v)) {
        if (looksLikeSpec(v)) spec = v;
        else if (depth < 3) { fieldsOf(v, name, depth + 1, out); continue; }
        else { field.tipo = 'subdocumento'; out.push(field); continue; }
      } else if (ts.isArrayLiteralExpression(v)) {
        field.array = true;
        const el = v.elements[0] && namer.strip(v.elements[0]);
        if (el && ts.isObjectLiteralExpression(el)) {
          if (looksLikeSpec(el)) spec = el;
          else if (depth < 3) { fieldsOf(el, `${name}[]`, depth + 1, out); continue; }
        } else if (el) field.tipo = text(el, 40);
      } else {
        field.tipo = text(v, 60);
      }
      if (spec) {
        for (const q of specProps(spec)) {
          if (q.spreadDesconocido || !q.name) continue;
          const k = namer.keyText(q.name);
          const qv = namer.strip(q.initializer);
          if (k === 'type') field.tipo = text(qv, 60);
          else if (k === 'required') field.requerido = qv.kind !== ts.SyntaxKind.FalseKeyword;
          else if (k === 'ref') field.ref = ts.isStringLiteralLike(qv) ? qv.text : text(qv, 40);
          else if (k === 'enum') field.enum = true;
          else if (k === 'unique') field.unico = qv.kind !== ts.SyntaxKind.FalseKeyword;
          else if (k === 'index') field.indice = qv.kind !== ts.SyntaxKind.FalseKeyword;
          else if (k === 'default') field.default = text(qv, 50);
          else if (k === 'min') field.min = text(qv, 30);
          else if (k === 'max') field.max = text(qv, 30);
          else if (k === 'validate') field.validador = true;
        }
      }
      if (field.tipo && /^\[/.test(field.tipo)) field.array = true;
      out.push(field);
    }
  };

  for (const m of models) {
    const sch = m.schemaVar ? schemas.get(m.schemaVar) : null;
    const rec = {
      id: `${file}#${m.variable}`,
      nombre: m.nombre,
      variable: m.variable,
      archivo: file,
      linea: m.linea,
      coleccion: m.coleccion,
      interfaz: sch?.generico ?? null,
      campos: [],
      indices: [],
      hooks: [],
      virtuales: [],
      plugins: [],
      opciones: null,
    };
    if (sch) {
      const obj = sch.init.arguments[0] && namer.strip(sch.init.arguments[0]);
      if (obj && ts.isObjectLiteralExpression(obj)) fieldsOf(obj, '', 0, rec.campos);
      const opt = sch.init.arguments[1];
      if (opt && ts.isObjectLiteralExpression(opt)) rec.opciones = text(opt, 160);
      rec.lineaEsquema = lineAt(sch.decl);
      const schemaName = m.schemaVar;
      const walk = (n) => {
        if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ts.isIdentifier(n.expression.expression) && n.expression.expression.text === schemaName) {
          const meth = n.expression.name.text;
          const a0 = n.arguments[0];
          if (meth === 'index') rec.indices.push({ campos: a0 ? text(a0, 140) : '', opciones: n.arguments[1] ? text(n.arguments[1], 140) : null, linea: lineAt(n) });
          else if (meth === 'pre' || meth === 'post') rec.hooks.push({ tipo: meth, evento: a0 ? text(a0, 60) : '', linea: lineAt(n) });
          else if (meth === 'virtual') rec.virtuales.push({ nombre: a0 && ts.isStringLiteralLike(a0) ? a0.text : text(a0, 30), linea: lineAt(n) });
          else if (meth === 'plugin') rec.plugins.push({ plugin: a0 ? text(a0, 60) : '', linea: lineAt(n) });
        }
        ts.forEachChild(n, walk);
      };
      walk(sf);
    }
    result.push(rec);
  }
  return result;
}
