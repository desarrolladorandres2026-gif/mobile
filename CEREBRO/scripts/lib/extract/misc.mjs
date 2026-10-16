// Extractores menores: eventos de socket, procesos periódicos, variables de entorno, hosts externos, pruebas.
import { rel } from '../util.mjs';
import { urlTemplate } from './frontend-api.mjs';

const SOCKET_RECV = /(^|\.)(socket|io|sockets|ioServer|namespace|nsp|client|adminSocket|s)$|\.to\(|\.in\(|\.broadcast|\.volatile/i;
const SKIP_RECV = /^(process|window|document|app|server|req|res|stream|child|emitter|bus|events|ws|worker|AppState|Keyboard|Linking|Dimensions|Appearance|BackHandler|NetInfo|Notifications|navigator|chokidar|watcher|cluster)$/i;
const EVENT_NAME = /^[A-Za-z0-9_.-]+(:[A-Za-z0-9_.-]+)+$|^(connect|disconnect|connect_error|reconnect|reconnect_attempt|error|notification|message)$/;

export function extractMisc(ctx, sf, namer, kindOfFile) {
  const { ts } = ctx;
  const file = rel(sf.fileName);
  const lineAt = (n) => sf.getLineAndCharacterOfPosition(n.getStart()).line + 1;
  const out = { eventos: [], periodicos: [], entorno: [], hosts: [], pruebas: { nombres: [], http: [] }, salas: [] };
  const stack = [`${file}#<module>`];
  const cur = () => stack[stack.length - 1];
  const isTest = kindOfFile === 'prueba';

  const visit = (n) => {
    const kind = namer.symbolKind(n, sf);
    let pushed = false;
    if (kind) {
      const p = namer.scopePath(n);
      if (p) { stack.push(`${file}#${p}`); pushed = true; }
    }

    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      // — eventos —
      if (ts.isPropertyAccessExpression(callee)) {
        const m = callee.name.text;
        if (/^(emit|on|once|off|addListener|removeListener|prependListener)$/.test(m) && n.arguments[0] && ts.isStringLiteralLike(n.arguments[0])) {
          const ev = n.arguments[0].text;
          const recv = callee.expression.getText().replace(/\s+/g, '').slice(0, 80);
          const rootName = recv.split(/[.(]/)[0];
          const viaIo = /\.(to|in)\(|get\('io'\)|getIO\(\)/.test(recv);
          if (!isTest && (viaIo || !SKIP_RECV.test(rootName)) && (SOCKET_RECV.test(recv) || EVENT_NAME.test(ev))) {
            const dir = m === 'emit' ? 'emite' : m === 'off' || m === 'removeListener' ? 'deja-de-escuchar' : 'escucha';
            out.eventos.push({ evento: ev, direccion: dir, receptor: recv, de: cur(), archivo: file, linea: lineAt(n) });
          }
        }
        if (m === 'join' || m === 'leave') {
          const recv = callee.expression.getText();
          if (/socket/i.test(recv) && n.arguments[0]) out.salas.push({ accion: m, sala: n.arguments[0].getText().slice(0, 80), de: cur(), archivo: file, linea: lineAt(n) });
        }
      } else if (!isTest && ts.isIdentifier(callee) && /(Event|Socket|Realtime|subscribe|listen)/i.test(callee.text) && !/^emit/.test(callee.text) && n.arguments[0] && ts.isStringLiteralLike(n.arguments[0]) && /^[a-z][A-Za-z0-9_-]*(:[A-Za-z0-9_-]+)+$/.test(n.arguments[0].text)) {
        out.eventos.push({ evento: n.arguments[0].text, direccion: 'escucha', receptor: callee.text + '()', de: cur(), archivo: file, linea: lineAt(n) });
      } else if (!isTest && ts.isIdentifier(callee) && /^emit(To\w*|Event|Realtime\w*)$/.test(callee.text)) {
        const lits = n.arguments.slice(0, 4).filter((a) => ts.isStringLiteralLike(a)).map((a) => a.text);
        const ev = lits.reverse().find((s) => EVENT_NAME.test(s) || /^[a-z]/.test(s));
        if (ev) out.eventos.push({ evento: ev, direccion: 'emite', receptor: callee.text, de: cur(), archivo: file, linea: lineAt(n) });
      }
      // — procesos periódicos —
      if (ts.isIdentifier(callee) && callee.text === 'setInterval') {
        out.periodicos.push({ tipo: 'setInterval', intervalo: n.arguments[1] ? n.arguments[1].getText().replace(/\s+/g, ' ').slice(0, 80) : '?', de: cur(), archivo: file, linea: lineAt(n) });
      }
      if (/(^|\.)schedule$|cron\.schedule/.test(callee.getText())) {
        out.periodicos.push({ tipo: 'cron', intervalo: n.arguments[0] ? n.arguments[0].getText().slice(0, 60) : '?', de: cur(), archivo: file, linea: lineAt(n) });
      }
      // — pruebas —
      if (isTest && ts.isIdentifier(callee) && /^(describe|it|test|suite)$/.test(callee.text) && n.arguments[0] && ts.isStringLiteralLike(n.arguments[0])) {
        out.pruebas.nombres.push({ tipo: callee.text === 'describe' || callee.text === 'suite' ? 'describe' : 'it', nombre: n.arguments[0].text.slice(0, 140), linea: lineAt(n) });
      }
      if (isTest && ts.isPropertyAccessExpression(callee) && /^(it|test|describe)$/.test(callee.expression.getText()) && /^(each|skip|only|todo|concurrent)$/.test(callee.name.text) && n.arguments[0] && ts.isStringLiteralLike(n.arguments[0])) {
        out.pruebas.nombres.push({ tipo: callee.name.text === 'todo' ? 'todo' : callee.name.text === 'skip' ? 'omitida' : 'it', nombre: n.arguments[0].text.slice(0, 140), linea: lineAt(n) });
      }
      if (isTest && ts.isPropertyAccessExpression(callee) && /^(get|post|put|patch|delete)$/.test(callee.name.text)) {
        let root = callee.expression;
        let chain = false;
        while (root) {
          if (ts.isCallExpression(root)) {
            const t = root.expression.getText();
            if (/^(request|supertest|agent|api|http)$/.test(t) || /request\(/.test(root.getText().slice(0, 12))) { chain = true; break; }
            root = ts.isPropertyAccessExpression(root.expression) ? root.expression.expression : null;
          } else if (ts.isPropertyAccessExpression(root)) root = root.expression;
          else if (ts.isIdentifier(root) && /^(request|agent|api|http|client)$/.test(root.text)) { chain = true; break; }
          else break;
        }
        if (chain && n.arguments[0]) {
          const u = urlTemplate(ctx, n.arguments[0], namer);
          if (u.plantilla.startsWith('/')) out.pruebas.http.push({ metodo: callee.name.text.toUpperCase(), plantilla: u.plantilla, de: cur(), archivo: file, linea: lineAt(n) });
        }
      }
    }
    // — listas de nombres de evento (registro dinámico por bucle) —
    if (!isTest && ts.isArrayLiteralExpression(n) && n.elements.length >= 3 && n.elements.every((e) => ts.isStringLiteralLike(e) && /^[a-z][A-Za-z0-9_-]*(:[A-Za-z0-9_-]+)+$/.test(e.text)) && /socket|realtime|Realtime|event/i.test(file + ' ' + cur())) {
      for (const e of n.elements) out.eventos.push({ evento: e.text, direccion: 'escucha', receptor: 'lista de eventos suscritos', de: cur(), archivo: file, linea: lineAt(e) });
    }
    // — mapas de manejadores por evento: { 'order:new': (payload) => … } —
    if (!isTest && ts.isPropertyAssignment(n) && (ts.isStringLiteral(n.name) || ts.isIdentifier(n.name)) && /^[a-z][A-Za-z0-9_-]*(:[A-Za-z0-9_-]+)+$/.test(n.name.text) && namer.unwrapFn(n.initializer)) {
      out.eventos.push({ evento: n.name.text, direccion: 'escucha', receptor: 'mapa de manejadores', de: cur(), archivo: file, linea: lineAt(n) });
    }
    // — variables de entorno —
    if (ts.isPropertyAccessExpression(n)) {
      const t = n.expression.getText();
      if (t === 'process.env' || t === 'import.meta.env') out.entorno.push({ nombre: n.name.text, de: cur(), archivo: file, linea: lineAt(n), origen: t });
    } else if (ts.isElementAccessExpression(n) && /^(process\.env|import\.meta\.env)$/.test(n.expression.getText()) && ts.isStringLiteralLike(n.argumentExpression)) {
      out.entorno.push({ nombre: n.argumentExpression.text, de: cur(), archivo: file, linea: lineAt(n), origen: n.expression.getText() });
    }
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && /^(env|getEnv|requireEnv|envString|envNumber|envBool)$/.test(n.expression.text) && n.arguments[0] && ts.isStringLiteralLike(n.arguments[0])) {
      out.entorno.push({ nombre: n.arguments[0].text, de: cur(), archivo: file, linea: lineAt(n), origen: 'env()' });
    }
    // — hosts externos —
    if (ts.isStringLiteralLike(n) && /^https?:\/\/[a-z0-9.-]+/i.test(n.text) && !isTest) {
      try {
        const u = new URL(n.text);
        if (!/^(localhost|127\.0\.0\.1|0\.0\.0\.0|example\.com|www\.w3\.org)$/.test(u.hostname) && !/\.(svg|png|jpg)$/.test(u.pathname)) {
          out.hosts.push({ host: u.hostname, url: n.text.slice(0, 120), de: cur(), archivo: file, linea: lineAt(n) });
        }
      } catch { /* no es URL */ }
    }
    ts.forEachChild(n, visit);
    if (pushed) stack.pop();
  };
  visit(sf);
  return out;
}
