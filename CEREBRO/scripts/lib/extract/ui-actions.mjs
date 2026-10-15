// Elementos interactivos (botones, enlaces, formularios, interruptores…) y sus manejadores.
import { rel } from '../util.mjs';
import { makeResolver } from './core.mjs';

const DOM_TIPOS = { button: 'boton', a: 'enlace', form: 'formulario', input: 'campo', textarea: 'campo', select: 'selector', summary: 'boton', option: 'opcion' };
const RN_TIPOS = {
  Pressable: 'boton', TouchableOpacity: 'boton', TouchableHighlight: 'boton', TouchableWithoutFeedback: 'boton', TouchableNativeFeedback: 'boton',
  Button: 'boton', Switch: 'interruptor', TextInput: 'campo', Link: 'enlace', NavLink: 'enlace', RefreshControl: 'refresco', Checkbox: 'interruptor',
};
const ACTION_PROPS = /^(onClick|onPress|onLongPress|onSubmit|onChange|onChangeText|onValueChange|onSelect|onSelectionChange|onToggle|onConfirm|onCancel|onClose|onSave|onDelete|onRemove|onRefresh|onRetry|onSubmitEditing|onEndEditing|onDismiss|onAccept|onReject|onApply|onSend|onPick|onAdd|onEdit|onNext|onBack|onSearch|onDone|onDoubleClick|onContextMenu|onDrop|onCheckedChange|onOpenChange|onTabChange)$/;
const NOISE_PROPS = /^(onLayout|onScroll|onFocus|onBlur|onLoad|onLoadEnd|onLoadStart|onError|onMouse\w*|onKey\w*|onContentSizeChange|onViewableItemsChanged|onEndReached\w*|onMomentum\w*|onScroll\w*|onTouch\w*|onPointer\w*|onAnimation\w*|onTransition\w*|onPlay\w*|onProgress|onReady|onDrag\w*|onPress(In|Out)|onHover\w*|onShow|onRequestClose|onMapReady|onRegion\w*|onMarker\w*|onCameraChange)$/;
const NAV_CALL = /(^|\.)(router\.(push|replace|navigate|back|dismiss|dismissAll|setParams)|navigation\.(navigate|push|goBack|replace)|navigate|history\.(push|replace|go|back)|Linking\.(openURL|openSettings|canOpenURL)|window\.(open|location\.\w+)|location\.(assign|replace|href))$/;

export function extractUi(ctx, sf, namer) {
  const { ts } = ctx;
  const R = ctx.resolver || (ctx.resolver = makeResolver(ctx, namer));
  const file = rel(sf.fileName);
  const out = { elementos: [], efectos: [], rutasPantalla: [] };
  const stack = [`${file}#<module>`];
  const lineAt = (n) => sf.getLineAndCharacterOfPosition(n.getStart()).line + 1;
  const cur = () => stack[stack.length - 1];

  const textOf = (n, depth = 0) => {
    const parts = [];
    const walk = (c, d) => {
      if (d > 3 || parts.join(' ').length > 90) return;
      if (ts.isJsxText(c)) { const t = c.text.replace(/\s+/g, ' ').trim(); if (t) parts.push(t); }
      else if (ts.isJsxExpression(c) && c.expression) {
        const e = namer.strip(c.expression);
        if (ts.isStringLiteralLike(e) || ts.isNoSubstitutionTemplateLiteral(e)) parts.push(e.text);
        else if (ts.isTemplateExpression(e)) parts.push(e.head.text + '…');
        else if (ts.isConditionalExpression(e)) { for (const br of [e.whenTrue, e.whenFalse]) { const b = namer.strip(br); if (ts.isStringLiteralLike(b)) parts.push(b.text); else if (ts.isJsxElement(b) || ts.isJsxFragment(b)) walk(b, d + 1); } }
        else if (ts.isBinaryExpression(e)) { const r = namer.strip(e.right); if (ts.isJsxElement(r) || ts.isJsxFragment(r)) walk(r, d + 1); else if (ts.isStringLiteralLike(r)) parts.push(r.text); }
        else if (ts.isCallExpression(e) && /^t$|\bt\b/.test(e.expression.getText()) && e.arguments[0] && ts.isStringLiteralLike(e.arguments[0])) parts.push(e.arguments[0].text);
        else if (ts.isJsxElement(e) || ts.isJsxFragment(e)) walk(e, d + 1);
      } else if (ts.isJsxElement(c) || ts.isJsxFragment(c)) {
        const kids = ts.isJsxElement(c) ? c.children : c.children;
        const tag = ts.isJsxElement(c) ? c.openingElement.tagName.getText() : '';
        if (ts.isJsxElement(c) && !kids.length) { /* vacío */ }
        for (const k of kids) walk(k, d + 1);
        if (!kids.length && /^[A-Z]/.test(tag)) parts.push(`⟨${tag}⟩`);
      } else if (ts.isJsxSelfClosingElement(c)) {
        const tag = c.tagName.getText();
        if (/^[A-Z]/.test(tag)) parts.push(`⟨${tag}⟩`);
      }
    };
    walk(n, depth);
    return parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, 90);
  };

  const attrText = (attrs, names) => {
    for (const a of attrs.properties) {
      if (!ts.isJsxAttribute(a)) continue;
      const nm = a.name.getText();
      if (!names.includes(nm)) continue;
      if (!a.initializer) return 'true';
      if (ts.isStringLiteral(a.initializer)) return a.initializer.text;
      if (ts.isJsxExpression(a.initializer) && a.initializer.expression) {
        const e = namer.strip(a.initializer.expression);
        if (ts.isStringLiteralLike(e)) return e.text;
        if (ts.isTemplateExpression(e)) return e.getText().slice(0, 80);
        return '{' + e.getText().replace(/\s+/g, ' ').slice(0, 70) + '}';
      }
    }
    return null;
  };

  /** Candidatos de manejador dentro de la expresión de un atributo. */
  const handlersOf = (expr) => {
    const res = [];
    const seen = new Set();
    const push = (o) => { const k = `${o.tipo}:${o.simbolo ?? o.texto}`; if (!seen.has(k)) { seen.add(k); res.push(o); } };
    const walk = (e, top) => {
      e = namer.strip(e);
      if (!e) return;
      if (namer.isFnExpr(e)) {
        const p = namer.scopePath(e);
        push({ tipo: 'inline', simbolo: p ? `${file}#${p}` : null, texto: e.getText().replace(/\s+/g, ' ').slice(0, 100) });
        return;
      }
      if (e.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(e) && e.text === 'undefined')) { push({ tipo: 'nulo', simbolo: null, texto: e.getText() }); return; }
      if (e.kind === ts.SyntaxKind.FalseKeyword) { push({ tipo: 'nulo', simbolo: null, texto: 'false' }); return; }
      if (ts.isIdentifier(e) || ts.isPropertyAccessExpression(e)) {
        const t = R.targetOf(e);
        if (t?.id) push({ tipo: 'referencia', simbolo: t.id, texto: e.getText().slice(0, 80) });
        else if (t?.prop) push({ tipo: 'prop', simbolo: `prop:${t.name}`, texto: e.getText().slice(0, 80), componente: nearestComponent() });
        else if (t?.varKey) push({ tipo: 'variable', simbolo: `var:${t.varKey}`, texto: e.getText().slice(0, 80), miembro: t.member ?? null });
        else {
          // m.mutate (variable local con método de librería)
          if (ts.isPropertyAccessExpression(e)) {
            const rt = R.targetOf(e.expression);
            if (rt?.varKey) { push({ tipo: 'variable', simbolo: `var:${rt.varKey}`, texto: e.getText().slice(0, 80), miembro: e.name.text }); return; }
          }
          push({ tipo: 'expresion', simbolo: null, texto: e.getText().slice(0, 80) });
        }
        return;
      }
      if (ts.isConditionalExpression(e)) { walk(e.whenTrue, false); walk(e.whenFalse, false); return; }
      if (ts.isBinaryExpression(e)) { walk(e.right, false); if (e.operatorToken.kind === ts.SyntaxKind.BarBarToken || e.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) walk(e.left, false); return; }
      if (ts.isCallExpression(e)) {
        // handleSubmit(onValid) / useCallback ya desenvuelto / debounce(fn)
        let any = false;
        for (const a of e.arguments) { const before = res.length; walk(a, false); if (res.length > before) any = true; }
        const t = R.targetOf(e.expression);
        if (t?.id) { push({ tipo: 'llamada-directa', simbolo: t.id, texto: e.getText().slice(0, 80) }); any = true; }
        if (!any) push({ tipo: 'expresion', simbolo: null, texto: e.getText().slice(0, 80) });
        return;
      }
      push({ tipo: 'expresion', simbolo: null, texto: e.getText().slice(0, 80) });
    };
    walk(expr, true);
    return res;
  };

  const nearestComponent = () => {
    // Primer segmento del símbolo actual: es el componente raíz.
    const id = cur();
    const [f, p] = id.split('#');
    const seg = p.split(/[./]/)[0];
    return `${f}#${seg}`;
  };

  const enclosingForm = (node) => {
    for (let p = node.parent; p; p = p.parent) {
      if (ts.isJsxElement(p) && p.openingElement.tagName.getText() === 'form') return p;
      if (ts.isFunctionDeclaration(p) || ts.isArrowFunction(p) && ts.isVariableDeclaration(p.parent)) break;
    }
    return null;
  };

  const visit = (n) => {
    const kind = namer.symbolKind(n, sf);
    let pushed = false;
    if (kind) {
      const p = namer.scopePath(n);
      if (p) { stack.push(`${file}#${p}`); pushed = true; }
    }

    // — rutas de pantalla (react-router): <Route path element={<Page/>}> —
    if ((ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) && n.tagName.getText() === 'Route') {
      const pathTxt = attrText(n.attributes, ['path']);
      const isIndex = n.attributes.properties.some((a) => ts.isJsxAttribute(a) && a.name.getText() === 'index');
      const elAttr = n.attributes.properties.find((a) => ts.isJsxAttribute(a) && a.name.getText() === 'element');
      const tags = [];
      if (elAttr && elAttr.initializer && ts.isJsxExpression(elAttr.initializer) && elAttr.initializer.expression) {
        const walkTags = (x) => {
          if (ts.isJsxOpeningElement(x) || ts.isJsxSelfClosingElement(x)) {
            const tn = x.tagName.getText();
            if (/^[A-Z]/.test(tn)) {
              const t = R.targetOf(x.tagName);
              tags.push({ tag: tn, id: t?.id ?? null, atributos: Object.fromEntries(x.attributes.properties.filter((a) => ts.isJsxAttribute(a) && /^(permission|permissions|anyOf|allOf|roles|module|requires|to|replace)$/.test(a.name.getText())).map((a) => [a.name.getText(), attrText(x.attributes, [a.name.getText()])])) });
            }
          }
          ts.forEachChild(x, walkTags);
        };
        walkTags(elAttr.initializer.expression);
      }
      out.rutasPantalla.push({ ruta: pathTxt, indice: isIndex, etiquetas: tags, linea: lineAt(n) });
    }

    // — elementos JSX —
    if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
      const tag = n.tagName.getText();
      const attrs = n.attributes;
      const isDom = /^[a-z]/.test(tag);
      let tipo = isDom ? DOM_TIPOS[tag] : RN_TIPOS[tag];
      const actionAttrs = [];
      for (const a of attrs.properties) {
        if (!ts.isJsxAttribute(a)) continue;
        const nm = a.name.getText();
        if (!/^on[A-Z]/.test(nm) || NOISE_PROPS.test(nm)) continue;
        const known = ACTION_PROPS.test(nm);
        // onDark / onPrimary…: booleanos o literales, no manejadores.
        if (!a.initializer) continue;
        if (ts.isStringLiteral(a.initializer)) continue;
        if (ts.isJsxExpression(a.initializer) && a.initializer.expression) {
          const ie = namer.strip(a.initializer.expression);
          if (ie.kind === ts.SyntaxKind.TrueKeyword || ts.isStringLiteralLike(ie) || ts.isNumericLiteral(ie)) continue;
        }
        // En componentes propios aceptamos cualquier onXxx no ruidoso.
        const custom = !isDom && !tipo;
        if (!known && !custom) continue;
        actionAttrs.push(a);
      }
      const hrefAttr = attrText(attrs, ['href', 'to']);
      const typeAttr = attrText(attrs, ['type']);
      const isInteractive = !!tipo || actionAttrs.length > 0;
      if (isInteractive) {
        if (!tipo) tipo = isDom ? 'elemento-clicable' : 'componente';
        const parentEl = ts.isJsxOpeningElement(n) ? n.parent : n;
        const rawLabel = textOf(ts.isJsxOpeningElement(n) ? n.parent : n);
        const attrLabel = attrText(attrs, ['aria-label', 'accessibilityLabel', 'title', 'label', 'placeholder', 'name', 'testID', 'data-testid']);
        const plainLabel = rawLabel.replace(/\u27e8[^\u27e9]*\u27e9/g, '').trim();
        const label = plainLabel || attrLabel || rawLabel || '';
        const manejadores = [];
        for (const a of actionAttrs) {
          const init = a.initializer;
          if (!init) { manejadores.push({ prop: a.name.getText(), candidatos: [{ tipo: 'nulo', simbolo: null, texto: '' }] }); continue; }
          if (ts.isJsxExpression(init) && init.expression) manejadores.push({ prop: a.name.getText(), candidatos: handlersOf(init.expression) });
        }
        const form = isDom && tag === 'button' ? enclosingForm(n) : null;
        let formManejadores = null;
        if (form) {
          const fa = form.openingElement.attributes.properties.find((x) => ts.isJsxAttribute(x) && x.name.getText() === 'onSubmit');
          if (fa && fa.initializer && ts.isJsxExpression(fa.initializer) && fa.initializer.expression) formManejadores = handlersOf(fa.initializer.expression);
        }
        out.elementos.push({
          id: `${file}:${lineAt(n)}:${tag}`,
          archivo: file,
          linea: lineAt(n),
          lineaFin: sf.getLineAndCharacterOfPosition((ts.isJsxOpeningElement(n) ? n.parent : n).getEnd()).line + 1,
          etiqueta: label,
          tag,
          tipo,
          tipoAtributo: typeAttr,
          destino: hrefAttr,
          deshabilitado: attrText(attrs, ['disabled']),
          contenedor: cur(),
          componente: nearestComponent(),
          manejadores,
          enviaFormulario: form ? { lineaFormulario: lineAt(form), manejadores: formManejadores } : null,
        });
      }
    }

    // — efectos de interfaz y navegación dentro de funciones —
    if (ts.isCallExpression(n)) {
      const calleeTxt = n.expression.getText().replace(/\s+/g, '');
      if (NAV_CALL.test(calleeTxt)) {
        out.efectos.push({ de: cur(), tipo: 'navegacion', llamada: calleeTxt.slice(0, 60), destino: n.arguments[0] ? n.arguments[0].getText().replace(/\s+/g, ' ').slice(0, 90) : null, linea: lineAt(n) });
      } else if (/^(Alert\.alert|alert|confirm|toast(\.\w+)?|showToast|Toast\.show|Share\.share|Clipboard\.setString\w*|navigator\.clipboard\.writeText|Haptics\.\w+|window\.print|print)$/.test(calleeTxt)) {
        out.efectos.push({ de: cur(), tipo: 'efecto-ui', llamada: calleeTxt.slice(0, 60), destino: n.arguments[0] ? n.arguments[0].getText().replace(/\s+/g, ' ').slice(0, 90) : null, linea: lineAt(n) });
      } else if (ts.isIdentifier(n.expression) && /^set[A-Z]/.test(n.expression.text)) {
        const t = R.targetOf(n.expression);
        if (t === null || t?.param) {
          // setter de useState (desestructurado de un array): sin símbolo propio
          const r = R.resolveDecl(n.expression);
          const d = r?.decls?.[0];
          if (d && ts.isBindingElement(d) && d.parent && ts.isArrayBindingPattern(d.parent)) {
            out.efectos.push({ de: cur(), tipo: 'estado-local', llamada: n.expression.text, destino: null, linea: lineAt(n) });
          }
        } else if (t?.varKey) {
          out.efectos.push({ de: cur(), tipo: 'estado-local', llamada: n.expression.text, destino: null, linea: lineAt(n) });
        }
      }
    }
    ts.forEachChild(n, visit);
    if (pushed) stack.pop();
  };
  visit(sf);
  return out;
}
