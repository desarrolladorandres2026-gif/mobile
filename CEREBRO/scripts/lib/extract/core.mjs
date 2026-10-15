// Núcleo del análisis: programa TypeScript por paquete, símbolos, importaciones y grafo de llamadas.
//
// Todo lo que sale de aquí es análisis ESTÁTICO resuelto con el verificador de tipos
// de TypeScript (confianza "estatica"). Lo que se infiere por convención de nombres
// (props, mutaciones de react-query, stores de zustand, interfaces) se marca "inferida".
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { ROOT, abs, rel, loadTs } from '../util.mjs';

const FN_WRAPPERS = new Set(['useCallback', 'memo', 'forwardRef', 'lazy', 'observer', 'debounce', 'throttle', 'useEvent', 'withSpring']);
const CALLBACK_REGISTRARS = new Set(['on', 'once', 'get', 'post', 'put', 'patch', 'delete', 'all', 'use', 'handle', 'addListener', 'subscribe']);
const MODEL_WRITE = /^(create|insertMany|save|update\w*|findOneAndUpdate|findByIdAndUpdate|findOneAndReplace|replaceOne|delete\w*|remove|findOneAndDelete|findByIdAndDelete|findByIdAndRemove|bulkWrite|bulkSave|upsert|init|syncIndexes)$/;
const MODEL_READ = /^(find\w*|count\w*|estimatedDocumentCount|aggregate|exists|distinct|populate|watch|where|lean|select|sort|get\w*|hydrate)$/;

export const classifyModelMethod = (m) => (MODEL_WRITE.test(m) ? 'write' : MODEL_READ.test(m) ? 'read' : 'other');

/** Crea el contexto TypeScript de un paquete. */
export function createPackageContext(pkg, rootFiles, oldCtx = null) {
  const { ts, version, desde } = loadTs(pkg.ts ?? pkg.id);
  const tsconfigPath = pkg.tsconfig ? abs(pkg.tsconfig) : null;
  let options = { allowJs: true, checkJs: false, skipLibCheck: true, noEmit: true, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler };
  const configErrors = [];
  if (tsconfigPath && fs.existsSync(tsconfigPath)) {
    const cfgFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
    if (cfgFile.error) configErrors.push(ts.flattenDiagnosticMessageText(cfgFile.error.messageText, '\n'));
    const parsed = ts.parseJsonConfigFileContent(cfgFile.config ?? {}, ts.sys, path.dirname(tsconfigPath), undefined, tsconfigPath);
    for (const e of parsed.errors) configErrors.push(ts.flattenDiagnosticMessageText(e.messageText, '\n'));
    options = { ...parsed.options };
  }
  // Solo nos interesa resolver y tipar; nunca emitir ni diagnosticar.
  Object.assign(options, {
    allowJs: true, checkJs: false, noEmit: true, skipLibCheck: true, declaration: false, declarationMap: false,
    sourceMap: false, incremental: false, composite: false, tsBuildInfoFile: undefined, noUnusedLocals: false, noUnusedParameters: false,
  });
  if (options.moduleResolution === ts.ModuleResolutionKind.Classic || options.moduleResolution === undefined) {
    options.moduleResolution = ts.ModuleResolutionKind.Bundler;
  }
  const host = ts.createCompilerHost(options, true);
  const names = rootFiles.map((f) => abs(f));
  const program = ts.createProgram({ rootNames: names, options, host, oldProgram: oldCtx?.program });
  const checker = program.getTypeChecker();
  const moduleCache = ts.createModuleResolutionCache(ROOT, (s) => s, options);
  return { pkg, ts, tsVersion: version, tsFrom: desde, program, checker, options, host, moduleCache, configErrors, rootFiles: new Set(rootFiles) };
}

const isNodeModules = (fileName) => fileName.includes('/node_modules/') || fileName.includes('\\node_modules\\');
export function repoRelOrNull(fileName) {
  if (isNodeModules(fileName)) return null;
  const normalized = fileName.split(path.sep).join('/');
  const rootNorm = ROOT.split(path.sep).join('/');
  if (!normalized.toLowerCase().startsWith(rootNorm.toLowerCase() + '/')) return null;
  return normalized.slice(rootNorm.length + 1);
}

// ───────────────────────────── nombres y ámbitos ─────────────────────────────

export function makeNamer(ts) {
  const strip = (e) => {
    while (e && (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression?.(e) || ts.isNonNullExpression(e) || ts.isTypeAssertionExpression?.(e))) e = e.expression;
    return e;
  };
  const isFnExpr = (n) => !!n && (ts.isArrowFunction(n) || ts.isFunctionExpression(n));

  /** Si `init` es (o envuelve) una función, la devuelve. */
  function unwrapFn(init) {
    init = strip(init);
    if (!init) return null;
    if (isFnExpr(init)) return init;
    if (ts.isCallExpression(init)) {
      const callee = init.expression;
      const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : '';
      if (FN_WRAPPERS.has(name) && init.arguments.length) {
        const a = strip(init.arguments[0]);
        if (isFnExpr(a)) return a;
      }
    }
    return null;
  }

  const keyText = (name) => {
    if (!name) return null;
    if (ts.isIdentifier(name) || ts.isPrivateIdentifier?.(name)) return name.text;
    if (ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return name.text;
    if (ts.isComputedPropertyName(name)) return `[${name.expression.getText().slice(0, 30)}]`;
    return null;
  };

  const lineOf = (n) => n.getSourceFile().getLineAndCharacterOfPosition(n.getStart()).line + 1;

  /** ¿Es este nodo una función (para decidir el separador y el tipo)? */
  function isFnNode(n) {
    if (ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) || ts.isGetAccessor(n) || ts.isSetAccessor(n) || ts.isConstructorDeclaration(n) || isFnExpr(n)) return true;
    if (ts.isVariableDeclaration(n)) return !!unwrapFn(n.initializer);
    if (ts.isPropertyDeclaration(n) || ts.isPropertyAssignment(n)) return !!unwrapFn(n.initializer);
    return false;
  }

  function callbackName(fnNode) {
    let p = fnNode.parent;
    if (!p) return null;
    // JSX: onClick={() => ...}, también bajo cond ? () => … : undefined, a && () => …
    let hops = 0;
    while (p && hops < 4 && (ts.isParenthesizedExpression(p) || ts.isConditionalExpression(p) || (ts.isBinaryExpression(p) && p.right !== undefined) || ts.isAsExpression(p) || ts.isNonNullExpression(p))) { p = p.parent; hops++; }
    if (p && ts.isJsxExpression(p) && p.parent && ts.isJsxAttribute(p.parent)) {
      return `${p.parent.name.getText()}@L${lineOf(fnNode)}`;
    }
    p = fnNode.parent;
    // socket.on('x', () => ...), router.post('/x', ..., () => ...)
    if (ts.isCallExpression(p) && p.arguments.includes(fnNode)) {
      const callee = p.expression;
      if (ts.isPropertyAccessExpression(callee) && CALLBACK_REGISTRARS.has(callee.name.text) && p.arguments.length >= 1) {
        const first = p.arguments[0];
        const lit = ts.isStringLiteralLike(first) || ts.isNoSubstitutionTemplateLiteral(first) ? first.text.slice(0, 40) : '';
        return `${callee.name.text}${lit ? `:${lit}` : ''}@L${lineOf(fnNode)}`;
      }
    }
    return null;
  }

  /** Segmento de nombre que un nodo aporta a la ruta de ámbito (o null). */
  function segment(n) {
    if (ts.isFunctionDeclaration(n)) return n.name ? n.name.text : (n.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword) ? 'default' : null);
    if (ts.isClassDeclaration(n) || ts.isClassExpression(n)) return n.name ? n.name.text : (ts.isClassDeclaration(n) ? 'default' : null);
    if (ts.isMethodDeclaration(n) || ts.isGetAccessor(n) || ts.isSetAccessor(n)) return keyText(n.name);
    if (ts.isConstructorDeclaration(n)) return 'constructor';
    if (ts.isPropertyDeclaration(n) || ts.isPropertyAssignment(n)) return keyText(n.name);
    if (ts.isVariableDeclaration(n)) return ts.isIdentifier(n.name) ? n.name.text : null;
    if (ts.isInterfaceDeclaration(n) || ts.isTypeAliasDeclaration(n) || ts.isEnumDeclaration(n)) return n.name.text;
    if (isFnExpr(n)) {
      // Se absorben en su variable/propiedad salvo los callbacks nombrables.
      const parent = n.parent;
      if (parent && (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent))) return null;
      if (parent && ts.isCallExpression(parent) && parent.parent && ts.isVariableDeclaration(parent.parent) && unwrapFn(parent.parent.initializer) === n) return null;
      return callbackName(n);
    }
    return null;
  }

  /** Ruta de ámbito de un nodo declaración (null si no se puede nombrar). */
  function scopePath(node) {
    const segs = [];
    for (let n = node; n && !ts.isSourceFile(n); n = n.parent) {
      const s = segment(n);
      if (s) segs.push({ s, fn: isFnNode(n), n });
    }
    if (!segs.length) return null;
    segs.reverse();
    let out = segs[0].s;
    for (let i = 1; i < segs.length; i++) out += (segs[i - 1].fn ? '/' : '.') + segs[i].s;
    return out;
  }

  const MODEL_CALL = /(^|\.)model$/;

  /** ¿Este nodo declara un símbolo que merece nodo propio? Devuelve el tipo. */
  function symbolKind(n, sf) {
    const atModuleLevel = (x) => {
      let p = x.parent;
      while (p && !ts.isSourceFile(p)) {
        if (ts.isVariableDeclarationList(p) || ts.isVariableStatement(p) || ts.isExportAssignment(p) || ts.isModuleBlock(p) || ts.isModuleDeclaration(p)) { p = p.parent; continue; }
        return false;
      }
      return true;
    };
    if (ts.isFunctionDeclaration(n)) {
      const nm = n.name?.text ?? '';
      if (/^use[A-Z0-9]/.test(nm)) return 'hook';
      if (/^[A-Z]/.test(nm) && sf.fileName.endsWith('x')) return 'componente';
      return 'funcion';
    }
    if (ts.isClassDeclaration(n)) return 'clase';
    if (ts.isMethodDeclaration(n) || ts.isGetAccessor(n) || ts.isSetAccessor(n) || ts.isConstructorDeclaration(n)) return 'metodo';
    if (ts.isInterfaceDeclaration(n)) return 'interfaz';
    if (ts.isTypeAliasDeclaration(n)) return 'tipo';
    if (ts.isEnumDeclaration(n)) return 'enum';
    if (ts.isPropertyAssignment(n) || ts.isPropertyDeclaration(n)) {
      const fn = unwrapFn(n.initializer);
      if (fn) return 'metodo';
      return null;
    }
    if (isFnExpr(n) && segment(n)) return 'inline';
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) {
      const nm = n.name.text;
      const fn = unwrapFn(n.initializer);
      if (fn) {
        if (/^use[A-Z0-9]/.test(nm)) return 'hook';
        if (/^[A-Z]/.test(nm) && (sf.fileName.endsWith('x') || sf.fileName.endsWith('.js'))) return 'componente';
        return 'funcion';
      }
      if (!atModuleLevel(n)) return null;
      const init = strip(n.initializer);
      if (init && ts.isCallExpression(init)) {
        const c = init.expression.getText();
        if (MODEL_CALL.test(c) && /mongoose|models?$/i.test(c.split('.')[0] + '')) return 'modelo';
        if (/Router$|^Router|\.Router$/.test(c)) return 'router';
        if (/^create(Store)?$|^create<|zustand/.test(c)) return 'store';
      }
      if (init && ts.isNewExpression(init) && /^Schema$|Schema$/.test(init.expression.getText())) return 'esquema';
      if (init && ts.isObjectLiteralExpression(init)) return 'objeto';
      return 'constante';
    }
    return null;
  }

  return { strip, unwrapFn, isFnExpr, isFnNode, segment, scopePath, symbolKind, keyText, lineOf };
}

// ───────────────────────────── extracción por archivo ─────────────────────────────

function jsDocLine(ts, node, sf) {
  try {
    const target = ts.isVariableDeclaration(node) ? (node.parent?.parent && ts.isVariableStatement(node.parent.parent) ? node.parent.parent : node) : node;
    const ranges = ts.getLeadingCommentRanges(sf.text, target.getFullStart());
    if (!ranges || !ranges.length) return null;
    const last = ranges[ranges.length - 1];
    const raw = sf.text.slice(last.pos, last.end);
    const cleaned = raw.replace(/^\/\*+|\*+\/$/g, '').split('\n').map((l) => l.replace(/^\s*\/\/\s?/, '').replace(/^\s*\*\s?/, '').trim()).filter((l) => l && !l.startsWith('@')).join(' ');
    return cleaned ? cleaned.slice(0, 260) : null;
  } catch {
    return null;
  }
}

function signatureOf(ts, node) {
  try {
    const fn = ts.isVariableDeclaration(node) || ts.isPropertyAssignment(node) || ts.isPropertyDeclaration(node) ? (node.initializer ? unwrapAny(ts, node.initializer) : null) : node;
    if (!fn || !fn.parameters) return null;
    const params = fn.parameters.map((p) => p.getText().replace(/\s+/g, ' ')).join(', ');
    const ret = fn.type ? `: ${fn.type.getText().replace(/\s+/g, ' ')}` : '';
    const s = `(${params})${ret}`;
    return s.length > 300 ? s.slice(0, 297) + '…' : s;
  } catch {
    return null;
  }
}
function unwrapAny(ts, init) {
  while (init && (ts.isParenthesizedExpression(init) || ts.isAsExpression(init))) init = init.expression;
  if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) return init;
  if (init && ts.isCallExpression(init) && init.arguments.length) return unwrapAny(ts, init.arguments[0]);
  return null;
}

/** Resolución de identificadores a símbolos del repo mediante el verificador de tipos. */
export function makeResolver(ctx, namer) {
  const { ts, checker } = ctx;
  function resolveDecl(exprNode) {
    let sym;
    try {
      sym = checker.getSymbolAtLocation(exprNode);
      if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
    } catch {
      return null;
    }
    if (!sym) return null;
    const decls = sym.declarations ?? (sym.valueDeclaration ? [sym.valueDeclaration] : []);
    return { sym, decls };
  }
  function declToId(decl) {
    if (!decl) return null;
    const drel = repoRelOrNull(decl.getSourceFile().fileName);
    if (!drel) return null;
    const p = namer.scopePath(decl);
    if (!p) return null;
    return `${drel}#${p}`;
  }
  const isPropsOwner = (owner) => {
    if (!owner) return false;
    if (ts.isInterfaceDeclaration(owner)) return /Props$|Options$|Config$|Handlers?$|Callbacks?$/.test(owner.name.text);
    if (ts.isTypeLiteralNode(owner)) {
      const p = owner.parent;
      return !!p && ts.isTypeAliasDeclaration(p) && /Props$|Options$|Handlers?$|Callbacks?$/.test(p.name.text);
    }
    return false;
  };
  /** Destino interno de una expresión invocada/referenciada. */
  function targetOf(expr) {
    const nameNode = ts.isPropertyAccessExpression(expr) ? expr.name : ts.isElementAccessExpression(expr) ? expr.argumentExpression : expr;
    const r = resolveDecl(nameNode);
    if (!r || !r.decls.length) return null;
    for (const d of r.decls) {
      const drel = repoRelOrNull(d.getSourceFile().fileName);
      if (!drel) continue;
      if (ts.isBindingElement(d)) {
        // Desestructurado de props (parámetro) o de un hook/store (variable).
        let n = d.parent;
        while (n && (ts.isObjectBindingPattern(n) || ts.isArrayBindingPattern(n) || ts.isBindingElement(n))) n = n.parent;
        if (n && ts.isParameter(n)) return { prop: true, name: (d.propertyName ?? d.name).getText() };
        if (n && ts.isVariableDeclaration(n)) return { varKey: varKeyOf(n), member: (d.propertyName ?? d.name).getText() };
      }
      if (ts.isParameter(d)) return { prop: false, param: true, name: r.sym.name };
      if (ts.isVariableDeclaration(d) && !namer.unwrapFn(d.initializer)) {
        const id = declToId(d);
        // Variable local sin símbolo propio: puede ser el resultado de un hook/store.
        if (d.parent && ts.isVariableDeclarationList(d.parent) && d.getSourceFile() === nameNode.getSourceFile() && !isModuleLevel(d)) {
          return { varKey: varKeyOf(d), local: true };
        }
        if (id) return { id };
      }
      if (ts.isMethodSignature(d) || ts.isPropertySignature(d)) {
        const owner = d.parent;
        if (isPropsOwner(owner)) return { prop: true, name: r.sym.name };
        const ownerName = owner && ts.isInterfaceDeclaration(owner) ? owner.name.text : null;
        return { firma: true, ownerId: ownerName ? `${drel}#${ownerName}` : null, member: r.sym.name, file: drel };
      }
      const id = declToId(d);
      if (id) return { id };
    }
    return null;
  }
  const isModuleLevel = (d) => {
    let p = d.parent;
    while (p && !ts.isSourceFile(p)) {
      if (ts.isVariableDeclarationList(p) || ts.isVariableStatement(p)) { p = p.parent; continue; }
      return false;
    }
    return true;
  };
  function varKeyOf(varDecl) {
    const sf = varDecl.getSourceFile();
    const lc = sf.getLineAndCharacterOfPosition(varDecl.getStart());
    return `${repoRelOrNull(sf.fileName)}@${lc.line + 1}:${lc.character}`;
  }
  return { resolveDecl, declToId, targetOf, varKeyOf, isModuleLevel };
}

/** Señales de cuerpo vacío / solo log / marcadores de pendiente. */
function bodyFlags(ts, fn, sf) {
  const body = fn.body;
  if (!body) return null;
  const flags = {};
  if (ts.isBlock(body)) {
    const sts = body.statements;
    if (sts.length === 0) flags.vacio = true;
    else if (sts.every((s) => ts.isExpressionStatement(s) && /^console\.\w+\(/.test(s.expression.getText()))) flags.soloLog = true;
  } else if (body.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(body) && body.text === 'undefined')) {
    flags.vacio = true;
  }
  const txt = body.getText();
  const m = /\b(TODO|FIXME|HACK)\b/.exec(txt) || /pr[o\u00f3]ximamente|not implemented|no implementad[oa]|coming soon|\bmock(ed)?\b|\bstub\b|hardcod/i.exec(txt);
  if (m) {
    flags.pendiente = m[0];
    flags.pendienteLinea = sf.getLineAndCharacterOfPosition(body.getStart() + m.index).line + 1;
  }
  return Object.keys(flags).length ? flags : null;
}

const addRange = (arr, a, b) => arr.push([a, b]);

/**
 * Extrae los hechos de un archivo: símbolos, aristas, importaciones.
 * `shared` lleva índices que dependen de todo el paquete (implementaciones de stores, props).
 */
export function extractFile(ctx, sf, namer) {
  const { ts, checker } = ctx;
  const file = rel(sf.fileName);
  const text = sf.text;
  const lineAt = (pos) => sf.getLineAndCharacterOfPosition(pos).line + 1;
  const facts = {
    archivo: file,
    imports: [],
    exports: [],
    simbolos: [],
    aristas: [],
    usosExternos: [],
    herencia: [],
    bindingsProps: [],
    reexportSolo: true,
    erroresSintaxis: (sf.parseDiagnostics ?? []).length,
    rangosIndexados: [],
    tokens: [],
  };
  const symbolIds = new Set();
  const moduleId = `${file}#<module>`;

  // — imports (sintácticos + resolución de módulo) —
  const importBinding = new Map(); // nombre local -> especificador
  const resolveSpec = (spec) => {
    const r = ts.resolveModuleName(spec, sf.fileName, ctx.options, ctx.host, ctx.moduleCache);
    const rf = r.resolvedModule?.resolvedFileName;
    if (!rf) return { interno: null, externo: !spec.startsWith('.') && !spec.startsWith('@/') ? spec : null, noResuelto: spec.startsWith('.') };
    const rr = repoRelOrNull(rf);
    if (rr) return { interno: rr, externo: null };
    return { interno: null, externo: spec };
  };
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
      const spec = st.moduleSpecifier.text;
      const res = resolveSpec(spec);
      const clause = st.importClause;
      const names = [];
      if (clause) {
        if (clause.name) { names.push(clause.name.text); importBinding.set(clause.name.text, spec); }
        const nb = clause.namedBindings;
        if (nb && ts.isNamedImports(nb)) for (const el of nb.elements) { names.push(el.name.text); importBinding.set(el.name.text, spec); }
        if (nb && ts.isNamespaceImport(nb)) { names.push('* as ' + nb.name.text); importBinding.set(nb.name.text, spec); }
      }
      facts.imports.push({ spec, ...res, tipo: clause?.isTypeOnly ? 'tipo' : 'valor', nombres: names, linea: lineAt(st.getStart()) });
      facts.reexportSolo = facts.reexportSolo && true;
    } else if (ts.isExportDeclaration(st)) {
      if (st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)) {
        const spec = st.moduleSpecifier.text;
        const res = resolveSpec(spec);
        const names = st.exportClause && ts.isNamedExports(st.exportClause) ? st.exportClause.elements.map((e) => e.name.text) : ['*'];
        facts.imports.push({ spec, ...res, tipo: 'reexport', nombres: names, linea: lineAt(st.getStart()) });
        for (const n of names) facts.exports.push(n);
      } else if (st.exportClause && ts.isNamedExports(st.exportClause)) {
        for (const e of st.exportClause.elements) facts.exports.push(e.name.text);
        facts.reexportSolo = false;
      }
    } else if (ts.isVariableStatement(st) || ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st) || ts.isExpressionStatement(st) || ts.isIfStatement(st) || ts.isForStatement(st)) {
      facts.reexportSolo = false;
    } else if (ts.isExportAssignment(st)) {
      facts.reexportSolo = false;
    }
    // Rango de líneas de la sentencia (incluye comentario previo): cuenta como indexado.
    const startLine = lineAt(st.getFullStart() + (text.slice(st.getFullStart(), st.getStart()).match(/^\s*/)?.[0].length ?? 0));
    addRange(facts.rangosIndexados, Math.min(startLine, lineAt(st.getStart())), lineAt(st.getEnd()));
  }
  if (!sf.statements.length) facts.reexportSolo = false;

  const modulePending = [];

  // — símbolos —
  function registerSymbol(node, kind) {
    const p = namer.scopePath(node);
    if (!p) return null;
    const id = `${file}#${p}`;
    if (symbolIds.has(id)) return id;
    symbolIds.add(id);
    const start = node.getStart();
    const exported = (() => {
      let n = node;
      if (ts.isVariableDeclaration(n)) n = n.parent?.parent ?? n;
      return !!(ts.getCombinedModifierFlags?.(n) & ts.ModifierFlags.Export) || !!(n.modifiers?.some?.((m) => m.kind === ts.SyntaxKind.ExportKeyword));
    })();
    const rec = {
      id, nombre: p.split(/[./]/).pop(), ruta: p, tipo: kind, archivo: file,
      linea: lineAt(start), lineaFin: lineAt(node.getEnd()), exportado: exported && !p.includes('/') && !p.includes('.'),
      doc: jsDocLine(ts, node, sf), firma: kind === 'clase' || kind === 'interfaz' || kind === 'tipo' || kind === 'enum' ? null : signatureOf(ts, node),
    };
    {
      const fnNode = ts.isVariableDeclaration(node) || ts.isPropertyAssignment(node) || ts.isPropertyDeclaration(node) ? namer.unwrapFn(node.initializer) : (node.body !== undefined || namer.isFnExpr(node) ? node : null);
      const fl = fnNode ? bodyFlags(ts, fnNode, sf) : null;
      if (fl) rec.banderas = fl;
      if (fnNode && fnNode.body && kind !== 'inline') {
        const bt = fnNode.body.getText();
        if (bt.length >= 260) {
          const norm = bt.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').replace(/\s+/g, ' ');
          rec.hashCuerpo = crypto.createHash('sha1').update(norm).digest('hex').slice(0, 12);
          rec.largoCuerpo = norm.length;
        }
      }
    }
    if (kind === 'enum') rec.miembros = node.members.map((m) => namer.keyText(m.name));
    facts.simbolos.push(rec);
    if (exported && rec.exportado) facts.exports.push(rec.nombre);
    return id;
  }

  const R = ctx.resolver || (ctx.resolver = makeResolver(ctx, namer));
  const { resolveDecl, declToId, targetOf } = R;

  // ── recorrido ──
  const stack = [moduleId];
  const currentId = () => stack[stack.length - 1];
  const edge = (to, kind, node, extra = {}) => {
    facts.aristas.push({ de: currentId(), a: to, tipo: kind, linea: lineAt(node.getStart()), ...extra });
  };
  const componentOf = () => {
    for (let i = stack.length - 1; i >= 0; i--) {
      const s = facts.simbolos.find((x) => x.id === stack[i]);
      if (s && (s.tipo === 'componente' || s.tipo === 'hook')) return s;
    }
    return null;
  };

  function rootIdentifier(expr) {
    let e = expr;
    while (e && (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e) || ts.isCallExpression(e) || ts.isNonNullExpression(e) || ts.isParenthesizedExpression(e) || ts.isAsExpression(e))) e = e.expression;
    return e && ts.isIdentifier(e) ? e : null;
  }

  /** Cómo se usa un miembro de enum: escritura de estado, comparación o filtro/otro. */
  function enumUse(node) {
    let p = node.parent;
    while (p && (ts.isParenthesizedExpression(p) || ts.isAsExpression(p))) p = p.parent;
    if (!p) return 'otro';
    if (ts.isPropertyAssignment(p) && p.initializer === node) return /status|state|estado/i.test(p.name.getText()) ? 'escribe' : 'otro';
    if (ts.isBinaryExpression(p)) {
      const op = p.operatorToken.kind;
      if (op === ts.SyntaxKind.EqualsToken && p.right === node) return /status|state|estado/i.test(p.left.getText()) ? 'escribe' : 'otro';
      if (op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken) return 'compara';
    }
    if (ts.isCaseClause(p)) return 'compara';
    if (ts.isArrayLiteralExpression(p)) return 'lista';
    if (ts.isComputedPropertyName(p)) return 'clave';
    return 'otro';
  }

  /** Identificadores de manejadores contenidos en la expresión de un atributo JSX. */
  function collectHandlerIds(expr, acc, depth) {
    const e = namer.strip(expr);
    if (!e || depth > 4) return;
    if (namer.isFnExpr(e)) { const p = namer.scopePath(e); if (p) acc.push(`${file}#${p}`); return; }
    if (ts.isIdentifier(e) || ts.isPropertyAccessExpression(e)) {
      const tt = targetOf(e);
      if (tt?.id) acc.push(tt.id);
      else if (tt?.prop) acc.push(`prop:${tt.name}`);
      else if (tt?.varKey) acc.push(`var:${tt.varKey}`);
      return;
    }
    if (ts.isConditionalExpression(e)) { collectHandlerIds(e.whenTrue, acc, depth + 1); collectHandlerIds(e.whenFalse, acc, depth + 1); return; }
    if (ts.isBinaryExpression(e)) {
      collectHandlerIds(e.right, acc, depth + 1);
      const op = e.operatorToken.kind;
      if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) collectHandlerIds(e.left, acc, depth + 1);
      return;
    }
    if (ts.isCallExpression(e)) for (const a of e.arguments) collectHandlerIds(a, acc, depth + 1);
  }

  /** Si la expresión es un documento de Mongoose (IAlgo con save()), devuelve el nombre del modelo. */
  function docModelName(expr) {
    try {
      const t = checker.getTypeAtLocation(expr);
      if (!t) return null;
      const cands = [];
      const add = (x) => { if (x && x.symbol) cands.push(x.symbol.name); if (x && x.aliasSymbol) cands.push(x.aliasSymbol.name); };
      add(t);
      for (const a of t.aliasTypeArguments ?? []) add(a);
      for (const a of (t.typeArguments ?? [])) add(a);
      if (t.isUnion && t.isUnion()) for (const u of t.types) { add(u); for (const a of (u.typeArguments ?? [])) add(a); }
      for (const n of cands) {
        const m = /^I([A-Z][A-Za-z0-9]+)$/.exec(n ?? '');
        if (m) return m[1];
      }
    } catch { /* sin tipo */ }
    return null;
  }

  function visit(node) {
    const kind = namer.symbolKind(node, sf);
    let pushed = false;
    if (kind) {
      const id = registerSymbol(node, kind);
      if (id) {
        // Clases: herencia.
        if (ts.isClassDeclaration(node) && node.heritageClauses) {
          for (const h of node.heritageClauses) {
            for (const t of h.types) {
              const r = resolveDecl(t.expression);
              const d = r?.decls?.[0];
              facts.herencia.push({ clase: id, tipo: h.token === ts.SyntaxKind.ExtendsKeyword ? 'extends' : 'implements', destino: d ? declToId(d) : null, nombre: t.expression.getText(), linea: lineAt(t.getStart()) });
            }
          }
        }
        stack.push(id);
        pushed = true;
      }
    }

    if (ts.isVariableDeclaration(node) && node.initializer) {
      // Resultados de hooks/stores/lazy: sirven para resolver mutate(), selectores y páginas perezosas.
      const init = namer.strip(node.initializer);
      if (init && ts.isCallExpression(init) && !namer.unwrapFn(init)) {
        const calleeT = targetOf(init.expression);
        const calleeName = ts.isIdentifier(init.expression) ? init.expression.text : ts.isPropertyAccessExpression(init.expression) ? init.expression.name.text : '';
        let selector = null;
        const a0 = init.arguments[0] && namer.strip(init.arguments[0]);
        if (a0 && ts.isArrowFunction(a0) && a0.parameters.length === 1) {
          const bodyEx = namer.strip(a0.body);
          if (bodyEx && ts.isPropertyAccessExpression(bodyEx)) selector = bodyEx.name.text;
        }
        const inner = [];
        const findInner = (n) => {
          if (ts.isPropertyAssignment(n) && /^(mutationFn|queryFn|onSuccess|onError|onSettled|select)$/.test(namer.keyText(n.name) ?? '')) {
            const p = namer.scopePath(n);
            if (p && namer.unwrapFn(n.initializer)) inner.push(`${file}#${p}`);
          }
          ts.forEachChild(n, findInner);
        };
        ts.forEachChild(init, findInner);
        let dyn = null;
        const findDyn = (n) => {
          if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword && n.arguments[0] && ts.isStringLiteralLike(n.arguments[0])) dyn = resolveSpec(n.arguments[0].text).interno;
          if (!dyn) ts.forEachChild(n, findDyn);
        };
        findDyn(init);
        facts.varInits ??= [];
        facts.varInits.push({
          clave: R.varKeyOf(node), nombreVar: ts.isIdentifier(node.name) ? node.name.text : null,
          id: (() => { const p = namer.scopePath(node); return p ? `${file}#${p}` : null; })(),
          hook: calleeT?.id ?? null, hookNombre: calleeName, selector, internas: inner, importDinamico: dyn, linea: lineAt(node.getStart()),
        });
      }
    }
    if (ts.isExportAssignment(node) && !node.isExportEquals) {
      const e = namer.strip(node.expression);
      if (ts.isIdentifier(e)) facts.defaultExport = e.text;
    }
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)) {
      facts.defaultExport = node.name?.text ?? 'default';
    }

    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const root = rootIdentifier(callee);
      const ext = root && importBinding.get(root.text);
      if (ext && !ext.startsWith('.') && !ext.startsWith('@/')) {
        facts.usosExternos.push({ de: currentId(), modulo: ext, llamada: callee.getText().slice(0, 80), linea: lineAt(node.getStart()) });
      }
      if (callee.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) {
        const spec = node.arguments[0].text;
        facts.imports.push({ spec, ...resolveSpec(spec), tipo: 'dinamico', nombres: [], linea: lineAt(node.getStart()) });
      }
      if (ts.isIdentifier(callee) && callee.text === 'require' && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) {
        const spec = node.arguments[0].text;
        facts.imports.push({ spec, ...resolveSpec(spec), tipo: 'require', nombres: [], linea: lineAt(node.getStart()) });
      }
      if (ts.isPropertyAccessExpression(callee) && /^(save|deleteOne|remove|updateOne|markModified|populate|isModified)$/.test(callee.name.text)) {
        const mn = docModelName(callee.expression);
        if (mn) edge(`modelo-doc:${mn}`, 'llama', node, { via: callee.name.text, conf: 'inferida' });
      }
      let t = targetOf(callee);
      const viaName = ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined;
      // m.mutate(): el método es de la librería, pero m es una variable local con hook/store detrás.
      if (!t && ts.isPropertyAccessExpression(callee)) {
        const rt = targetOf(callee.expression);
        if (rt?.varKey) t = { varKey: rt.varKey, member: viaName, viaReceptor: true };
      }
      if (t) {
        if (t.id) edge(t.id, 'llama', node, viaName ? { via: viaName } : {});
        else if (t.firma) edge(t.ownerId ? `${t.ownerId}.${t.member}` : `?${t.member}`, 'llama', node, { via: 'firma-interfaz', conf: 'inferida', miembro: t.member, archivoDecl: t.file, ownerId: t.ownerId });
        else if (t.prop) edge(`prop:${t.name}`, 'llama', node, { via: 'prop', conf: 'inferida', componente: componentOf()?.id ?? null, prop: t.name });
        else if (t.varKey) edge(`var:${t.varKey}`, 'llama', node, { via: 'variable-local', conf: 'inferida', miembro: t.member ?? null });
      }
    } else if (ts.isNewExpression(node)) {
      const root = rootIdentifier(node.expression);
      const ext = root && importBinding.get(root.text);
      if (ext && !ext.startsWith('.') && !ext.startsWith('@/')) {
        facts.usosExternos.push({ de: currentId(), modulo: ext, llamada: 'new ' + node.expression.getText().slice(0, 70), linea: lineAt(node.getStart()) });
      }
      const t = targetOf(node.expression);
      if (t?.id) edge(t.id, 'instancia', node);
    } else if (ts.isJsxOpeningLikeElement(node)) {
      const tag = node.tagName;
      if ((ts.isIdentifier(tag) && /^[A-Z]/.test(tag.text)) || ts.isPropertyAccessExpression(tag)) {
        const t = targetOf(tag);
        if (t?.id) {
          edge(t.id, 'renderiza', node);
          for (const attr of node.attributes.properties) {
            if (!ts.isJsxAttribute(attr) || !attr.initializer || !ts.isJsxExpression(attr.initializer) || !attr.initializer.expression) continue;
            const pname = attr.name.getText();
            if (!/^on[A-Z]|^render|Handler$|^set[A-Z]|^handle|Click$|Press$|Change$|Submit$|Close$|Confirm$|Cancel$|Save$|Select$|Toggle$/.test(pname)) continue;
            const ids = [];
            collectHandlerIds(attr.initializer.expression, ids, 0);
            for (const handlerId of ids) facts.bindingsProps.push({ hijo: t.id, prop: pname, handler: handlerId, padre: currentId(), linea: lineAt(attr.getStart()) });
          }
        }
      }
    } else if (ts.isPropertyAccessExpression(node)) {
      const parent = node.parent;
      const isCallee = parent && ts.isCallExpression(parent) && parent.expression === node;
      const base = node.expression;
      let isEnumMember = false;
      if (ts.isIdentifier(base) && /^[A-Z]/.test(base.text)) {
        const r = resolveDecl(base);
        const d = r?.decls?.[0];
        if (d && ts.isEnumDeclaration(d)) {
          const id = declToId(d);
          if (id) { edge(id, 'usa-enum', node, { via: node.name.text, uso: enumUse(node) }); isEnumMember = true; }
        }
      }
      if (!isEnumMember && !isCallee && !(parent && ts.isPropertyAccessExpression(parent) && parent.expression === node)) {
        const t = targetOf(node);
        if (t?.id && !t.id.endsWith('<module>')) edge(t.id, 'referencia', node, { via: node.name.text });
      }
    } else if (ts.isIdentifier(node)) {
      const p = node.parent;
      const skip = p && (
        (ts.isVariableDeclaration(p) && p.name === node) || (ts.isFunctionDeclaration(p) && p.name === node) || (ts.isClassDeclaration(p) && p.name === node) ||
        (ts.isParameter(p) && p.name === node) || (ts.isPropertyAssignment(p) && p.name === node) || (ts.isPropertyAccessExpression(p) && p.name === node) ||
        ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isExportSpecifier(p) || ts.isNamespaceImport(p) || (ts.isMethodDeclaration(p) && p.name === node) ||
        (ts.isPropertyDeclaration(p) && p.name === node) || (ts.isBindingElement(p) && (p.name === node || p.propertyName === node)) || ts.isTypeReferenceNode(p) ||
        (ts.isJsxAttribute(p) && p.name === node) || (ts.isCallExpression(p) && p.expression === node) || (ts.isNewExpression(p) && p.expression === node) ||
        ts.isJsxOpeningElement(p) || ts.isJsxSelfClosingElement(p) || ts.isJsxClosingElement(p) || (ts.isEnumMember(p) && p.name === node) ||
        ts.isInterfaceDeclaration(p) || ts.isTypeAliasDeclaration(p) || ts.isEnumDeclaration(p) || ts.isQualifiedName(p) || ts.isTypeQueryNode(p) ||
        ts.isMethodSignature(p) || ts.isPropertySignature(p)
      );
      if (!skip) {
        const t = targetOf(node);
        if (t?.id) edge(t.id, 'referencia', node);
      }
    }

    ts.forEachChild(node, visit);
    if (pushed) stack.pop();
  }

  ts.forEachChild(sf, visit);

  // Tokens para búsqueda textual (identificadores y literales cortas).
  const tok = new Set();
  const collect = (n) => {
    if (ts.isIdentifier(n)) tok.add(n.text);
    else if (ts.isStringLiteralLike(n) && n.text.length < 80) tok.add(n.text);
    ts.forEachChild(n, collect);
  };
  collect(sf);
  facts.tokens = [...tok];
  facts.exports = [...new Set(facts.exports)];
  // Aristas deduplicadas: misma (de, a, tipo, via) agrupa sus líneas.
  const merged = new Map();
  for (const e of facts.aristas) {
    const k = `${e.de}|${e.a}|${e.tipo}|${e.via ?? ''}|${e.miembro ?? ''}|${e.uso ?? ''}`;
    const m = merged.get(k);
    if (m) { if (m.lineas.length < 8 && !m.lineas.includes(e.linea)) m.lineas.push(e.linea); m.n++; }
    else { merged.set(k, { ...e, lineas: [e.linea], n: 1 }); }
  }
  facts.aristas = [...merged.values()];
  // El símbolo <module> existe siempre.
  facts.simbolos.unshift({ id: moduleId, nombre: '<module>', ruta: '<module>', tipo: 'modulo', archivo: file, linea: 1, lineaFin: sf.getLineAndCharacterOfPosition(sf.getEnd()).line + 1, exportado: false, doc: null, firma: null });
  return facts;
}
