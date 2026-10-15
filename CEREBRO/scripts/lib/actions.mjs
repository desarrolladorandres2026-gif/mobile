// Pantallas y acciones de interfaz: trazado del recorrido completo y clasificación de estado.
import { bfs, pathTo } from './graph.mjs';

const FRONT = ['mobile', 'admin', 'business', 'web'];
export const ESTADOS = {
  verificada: 'Funcional y verificada',
  parcial: 'Parcialmente funcional',
  desconectada: 'Desconectada',
  sin_implementar: 'Sin implementar',
  con_errores: 'Con errores',
  pendiente: 'Pendiente de verificación',
  no_aplica: 'Entrada de datos (sin acción propia)',
};

/** Pantallas: rutas de expo-router (mobile) y <Route> de react-router (paneles). */
export function buildScreens(factsMap, graph) {
  const screens = [];
  const byRoute = new Map();
  const add = (s) => { screens.push(s); byRoute.set(`${s.paquete}:${s.ruta}`, s); };

  for (const [file, fx] of factsMap) {
    if (fx.paquete === 'mobile' && /^mobile\/app\//.test(file) && /\.(tsx|ts)$/.test(file)) {
      const sub = file.slice('mobile/app/'.length).replace(/\.(tsx|ts)$/, '');
      const isLayout = /(^|\/)_layout$/.test(sub);
      const special = /^\+/.test(sub.split('/').pop());
      let ruta = '/' + sub.replace(/\/index$/, '').replace(/^index$/, '');
      if (ruta === '/') ruta = '/';
      const variante = /^\(client\)/.test(sub) ? 'client' : /^\(driver\)/.test(sub) ? 'driver' : /^\(auth\)/.test(sub) ? 'auth' : /^preview\//.test(sub) ? 'preview' : 'raiz';
      const def = fx.defaultExport ? `${file}#${fx.defaultExport}` : null;
      add({
        id: `pantalla:mobile:${ruta}${isLayout ? ':layout' : ''}`, paquete: 'mobile', ruta, variante, archivo: file, linea: 1,
        tipo: isLayout ? 'layout' : special ? 'especial' : 'pantalla', componente: def && graph.symbols.has(def) ? def : null,
        actor: variante === 'client' ? 'CLIENT' : variante === 'driver' ? 'DRIVER' : null,
      });
    }
    if (['admin', 'business', 'web'].includes(fx.paquete)) {
      for (const r of fx.ui?.rutasPantalla ?? []) {
        const tag = r.etiquetas.find((t) => t.id && graph.symbols.has(t.id) && !/^(RequireAccess|PrivateRoute|PermissionGate|Navigate|Suspense|Layout)$/.test(t.tag)) ?? r.etiquetas.find((t) => t.id);
        let comp = tag?.id ?? null;
        // Página perezosa: const X = lazy(() => import('./pages/X'))
        if (comp) {
          const vi = [...graph.varInits.values()].find((v) => v.id === comp && v.importDinamico);
          if (vi) {
            const dfx = factsMap.get(vi.importDinamico);
            comp = dfx?.defaultExport ? `${vi.importDinamico}#${dfx.defaultExport}` : null;
          }
        }
        const guardas = r.etiquetas.filter((t) => Object.keys(t.atributos).length).map((t) => ({ componente: t.tag, ...t.atributos }));
        add({
          id: `pantalla:${fx.paquete}:${r.ruta ?? (r.indice ? '(índice)' : '?')}`, paquete: fx.paquete, ruta: r.ruta ?? (r.indice ? '(índice)' : '?'), variante: null,
          archivo: file, linea: r.linea, tipo: 'pantalla', componente: comp && graph.symbols.has(comp) ? comp : null, guardasUi: guardas,
          actor: fx.paquete === 'admin' ? 'ADMIN' : fx.paquete === 'business' ? 'BUSINESS' : 'PUBLICO',
        });
      }
    }
  }
  // Componentes alcanzables desde cada pantalla (renderizado).
  const compScreens = new Map(); // componente -> Set(screenId)
  for (const sc of screens) {
    if (!sc.componente) continue;
    const seen = bfs(graph, [sc.componente], { maxDepth: 7, maxNodes: 1500, follow: () => false });
    // bfs sólo sigue llamadas; aquí seguimos 'renderiza'
    const q = [sc.componente];
    const vis = new Set(q);
    while (q.length) {
      const cur = q.shift();
      for (const e of graph.edgesOut.get(cur) ?? []) {
        if (e.tipo !== 'renderiza' && !(e.tipo === 'llama' && graph.symbols.get(e.a)?.tipo === 'hook' && false)) continue;
        if (vis.has(e.a)) continue;
        vis.add(e.a);
        q.push(e.a);
      }
    }
    for (const c of vis) {
      if (!compScreens.has(c)) compScreens.set(c, new Set());
      compScreens.get(c).add(sc.id);
    }
  }
  return { screens, compScreens, byRoute };
}

const actorOfElement = (el, pkgId, screenList) => {
  if (pkgId === 'admin') return 'ADMIN';
  if (pkgId === 'business') return 'BUSINESS';
  if (pkgId === 'web') return 'PUBLICO';
  if (pkgId === 'mobile') {
    if (/mobile\/app\/\(client\)\//.test(el.archivo)) return 'CLIENT';
    if (/mobile\/app\/\(driver\)\//.test(el.archivo)) return 'DRIVER';
    const actors = new Set((screenList ?? []).map((s) => s.actor).filter(Boolean));
    if (actors.size === 1) return [...actors][0];
  }
  return null;
};

export function buildActions(factsMap, graph, endpointData, screensData, verification = null) {
  const { endpoints, calls } = endpointData;
  const epById = new Map(endpoints.map((e) => [e.id, e]));
  const callsBySymbol = new Map();
  for (const c of calls) {
    if (!callsBySymbol.has(c.desde)) callsBySymbol.set(c.desde, []);
    callsBySymbol.get(c.desde).push(c);
  }
  const effectsBySymbol = new Map();
  for (const [file, fx] of factsMap) for (const ef of fx.ui?.efectos ?? []) {
    if (!effectsBySymbol.has(ef.de)) effectsBySymbol.set(ef.de, []);
    effectsBySymbol.get(ef.de).push({ ...ef, archivo: file });
  }
  const screenById = new Map(screensData.screens.map((s) => [s.id, s]));
  const routeSet = new Map(); // paquete -> rutas de pantalla
  for (const s of screensData.screens) { if (!routeSet.has(s.paquete)) routeSet.set(s.paquete, []); routeSet.get(s.paquete).push(s.ruta); }
  const inRenderers = (id) => (graph.edgesIn.get(id) ?? []).filter((e) => e.tipo === 'renderiza').length;
  // Uso dinámico: el componente se referencia como valor (mapa de variantes, lazy…), no solo como <Tag/>.
  const inRefs = (id) => (graph.edgesIn.get(id) ?? []).filter((e) => (e.tipo === 'referencia' || e.tipo === 'llama') && !e.de.startsWith(`${id}/`) && !e.de.startsWith(`${id}.`)).length;

  const verifiedRoutes = verification?.rutasProbadas ?? null; // Set de ids de endpoint con prueba que pasó
  const actions = [];

  for (const [file, fx] of factsMap) {
    for (const el of fx.ui?.elementos ?? []) {
      const pkg = fx.paquete;
      const compId = el.componente;
      const screenIds = [...(screensData.compScreens.get(compId) ?? [])];
      // Las pantallas propias (el archivo es la pantalla) también cuentan.
      for (const sc of screensData.screens) if (sc.archivo === file && sc.componente === compId && !screenIds.includes(sc.id)) screenIds.push(sc.id);
      const screenList = screenIds.map((i) => screenById.get(i)).filter(Boolean);
      const actor = actorOfElement(el, pkg, screenList);

      const evidencias = [];
      const a = {
        id: el.id, paquete: pkg, archivo: file, linea: el.linea, lineaFin: el.lineaFin, etiqueta: el.etiqueta, tag: el.tag, tipo: el.tipo,
        componente: compId, contenedor: el.contenedor, pantallas: screenIds, actor,
        deshabilitado: el.deshabilitado, destino: el.destino,
      };

      // — manejadores —
      const starts = [];
      const notas = [];
      let tieneManejador = false;
      let soloNulos = el.manejadores.length > 0;
      let noResuelto = false;
      let propSinBinding = false;
      for (const m of el.manejadores) {
        for (const c of m.candidatos) {
          if (c.tipo === 'nulo') continue;
          soloNulos = false;
          tieneManejador = true;
          if (c.simbolo && c.simbolo.startsWith('prop:')) {
            const res = graph.resolveFuzzy({ a: c.simbolo, componente: c.componente }, file);
            if (res.length) for (const r of res) starts.push({ id: r.a, via: r.via, prop: m.prop });
            else {
              propSinBinding = true;
              notas.push(`prop \`${c.simbolo.slice(5)}\` sin binding en ningún uso del componente`);
            }
          } else if (c.simbolo && c.simbolo.startsWith('var:')) {
            const res = graph.resolveFuzzy({ a: c.simbolo, miembro: c.miembro ?? null }, file);
            if (res.length) for (const r of res) starts.push({ id: r.a, via: r.via, prop: m.prop });
            else notas.push(`manejador local \`${c.texto}\` (estado/hook) sin destino rastreable`);
          } else if (c.simbolo && graph.symbols.has(c.simbolo)) {
            starts.push({ id: c.simbolo, via: null, prop: m.prop });
          } else {
            noResuelto = true;
            notas.push(`expresión no resuelta: ${c.texto}`);
          }
        }
      }
      const formH = el.enviaFormulario?.manejadores?.filter((c) => c.simbolo && graph.symbols.has(c.simbolo)) ?? [];
      for (const c of formH) starts.push({ id: c.simbolo, via: 'onSubmit del formulario', prop: 'onSubmit' });
      if (el.enviaFormulario && formH.length) tieneManejador = true;

      a.naturaleza = null;
      a.manejadores = [...new Set(starts.map((s) => s.id))];

      // — recorrido —
      const reached = new Map();
      const sym0 = new Set(starts.map((s) => s.id));
      let apiCalls = [];
      let efectos = [];
      let banderas = [];
      const seen = starts.length ? bfs(graph, [...sym0], { maxDepth: 8, maxNodes: 1500, follow: (e) => !/\/__tests__\//.test(e.a) }) : new Map();
      // Manejadores que llegan por prop: un cuerpo vacío en un uso suele ser deliberado
      // (p. ej. un sheet que no se puede cerrar); solo cuenta si TODOS los usos lo están.
      const viaProp = starts.filter((s) => s.via && /^prop|onSubmit/.test(s.via) === true && s.via !== 'onSubmit del formulario');
      const propStartsFlagged = viaProp.length > 0 && viaProp.every((s) => { const b = graph.symbols.get(s.id)?.banderas; return b && (b.vacio || b.soloLog); });
      for (const id of seen.keys()) {
        for (const c of callsBySymbol.get(id) ?? []) apiCalls.push({ llamada: c, ruta: pathTo(seen, id) });
        for (const ef of effectsBySymbol.get(id) ?? []) efectos.push({ ...ef, ruta: pathTo(seen, id) });
        const s = graph.symbols.get(id);
        if (s?.banderas && sym0.has(id)) {
          const fromProp = viaProp.some((v) => v.id === id);
          if (!fromProp || propStartsFlagged || s.banderas.pendiente) banderas.push({ id, ...s.banderas, archivo: s.archivo, linea: s.linea });
        }
        if (s?.banderas && !sym0.has(id) && (s.banderas.pendiente || s.banderas.vacio) && s.tipo !== 'modulo') banderas.push({ id, ...s.banderas, archivo: s.archivo, linea: s.linea, indirecto: true });
      }
      const apiUnicas = [];
      const seenCalls = new Set();
      for (const ac of apiCalls) {
        const k = `${ac.llamada.archivo}:${ac.llamada.linea}`;
        if (seenCalls.has(k)) continue;
        seenCalls.add(k);
        apiUnicas.push(ac);
      }
      a.llamadasApi = apiUnicas.map((ac) => ({
        metodo: ac.llamada.metodo, plantilla: ac.llamada.plantillaApi, archivo: ac.llamada.archivo, linea: ac.llamada.linea, externa: ac.llamada.externa,
        endpoints: ac.llamada.endpoints, cuerpo: ac.llamada.cuerpo, parametros: ac.llamada.parametros, recorrido: ac.ruta, ambigua: ac.llamada.ambigua, metodoOtro: ac.llamada.metodoOtro,
      }));
      const navs = efectos.filter((e) => e.tipo === 'navegacion');
      const estados = efectos.filter((e) => e.tipo === 'estado-local');
      const uis = efectos.filter((e) => e.tipo === 'efecto-ui');
      a.efectos = [
        ...navs.map((e) => ({ tipo: 'navegacion', llamada: e.llamada, destino: e.destino, archivo: e.archivo, linea: e.linea })),
        ...uis.map((e) => ({ tipo: 'efecto-ui', llamada: e.llamada, destino: e.destino, archivo: e.archivo, linea: e.linea })),
        ...(estados.length ? [{ tipo: 'estado-local', n: estados.length, archivo: estados[0].archivo, linea: estados[0].linea }] : []),
      ];

      // Naturaleza
      const nat = [];
      if (a.llamadasApi.length) nat.push('api');
      if (navs.length || (el.destino && el.tipo === 'enlace')) nat.push('navegacion');
      if (estados.length && !a.llamadasApi.length && !navs.length) nat.push('estado-local');
      if (el.tipo === 'formulario' || el.enviaFormulario) nat.push('formulario');
      a.naturaleza = nat;

      // — estado —
      let estado = 'pendiente';
      const razon = [];
      const isDecorativeSummary = el.tag === 'summary';
      if (el.tipo === 'campo' || el.tipo === 'opcion') {
        estado = el.manejadores.length || tieneManejador ? 'pendiente' : 'no_aplica';
        if (estado === 'no_aplica') razon.push('Campo sin manejador propio: se lee al enviar el formulario o es no controlado.');
      }
      if (isDecorativeSummary) { estado = 'no_aplica'; razon.push('Elemento <summary>: se expande/contrae de forma nativa.'); }
      else if (el.tipo !== 'campo' && el.tipo !== 'opcion') {
        const sinHandler = !tieneManejador && !el.enviaFormulario && !el.destino && el.tipo !== 'formulario';
        if (sinHandler || soloNulos) {
          estado = 'desconectada';
          razon.push(el.manejadores.length ? 'El manejador se pasa como null/undefined/false.' : `El ${el.tag} no tiene manejador ni destino.`);
        } else if (el.tipo === 'formulario' && !tieneManejador) {
          estado = 'desconectada';
          razon.push('<form> sin onSubmit: el envío recarga la página o no hace nada.');
        } else if (banderas.some((b) => !b.indirecto && (b.vacio || b.soloLog))) {
          estado = 'sin_implementar';
          const b = banderas.find((x) => !x.indirecto && (x.vacio || x.soloLog));
          razon.push(b.vacio ? 'El manejador tiene el cuerpo vacío.' : 'El manejador solo escribe en consola.');
          evidencias.push({ archivo: b.archivo, linea: b.linea, texto: `manejador ${b.id.split('#')[1]}: ${b.vacio ? 'cuerpo vacío' : 'solo console.*'}` });
        } else if (banderas.some((b) => b.pendiente)) {
          estado = 'sin_implementar';
          const b = banderas.find((x) => x.pendiente);
          razon.push(`Marca de pendiente («${b.pendiente}») en ${b.indirecto ? 'una función alcanzada' : 'el manejador'}.`);
          evidencias.push({ archivo: b.archivo, linea: b.pendienteLinea ?? b.linea, texto: `marcador «${b.pendiente}»` });
        }
      }

      // API: ruta inexistente, método incorrecto, rol incompatible
      let problemas = 0;
      let rutasOk = 0;
      let escrituraSinEfecto = 0;
      let lectura = 0;
      for (const ac of a.llamadasApi) {
        if (ac.externa) { razon.push(`Llamada a servicio externo (${ac.plantilla.slice(0, 50)}): no verificable desde el repo.`); continue; }
        if (!ac.endpoints.length) {
          problemas++;
          if (ac.metodoOtro?.length) razon.push(`${ac.metodo} ${ac.plantilla} no existe; la ruta existe con ${ac.metodoOtro.join('/')}.`);
          else razon.push(`${ac.metodo} ${ac.plantilla} no coincide con ningún endpoint del backend.`);
          evidencias.push({ archivo: ac.archivo, linea: ac.linea, texto: `${ac.metodo} ${ac.plantilla} sin endpoint` });
          continue;
        }
        rutasOk++;
        for (const id of ac.endpoints) {
          const ep = epById.get(id);
          if (!ep) continue;
          const g = ep.guardas;
          if (actor === 'PUBLICO' && g.autenticada) { problemas++; razon.push(`${id} exige sesión y el sitio público no autentica.`); evidencias.push({ archivo: ep.archivo, linea: ep.linea, texto: `${id} requiere authenticate` }); }
          else if (actor && actor !== 'PUBLICO' && g.roles.length && !g.roles.includes(actor)) {
            problemas++;
            razon.push(`${id} solo admite ${g.roles.join('/')} y esta pantalla actúa como ${actor}.`);
            evidencias.push({ archivo: ep.archivo, linea: ep.linea, texto: `authorize(${g.roles.join(', ')}) no incluye ${actor}` });
          }
          if (ep.metodo === 'GET') lectura++;
          else if (ep.cierre && !ep.escribe && !ep.cierre.externos.length && !ep.cierre.eventos.length) escrituraSinEfecto++;
        }
      }

      if (estado === 'pendiente') {
        if (problemas) estado = 'con_errores';
        else if (propSinBinding && !a.llamadasApi.length && !navs.length && !estados.length && !uis.length && inRenderers(compId) > 0 && inRefs(compId) === 0) {
          estado = 'parcial';
          razon.push('Manejador recibido por prop que ninguno de los usos del componente proporciona.');
        } else if (propSinBinding && !a.llamadasApi.length && !navs.length && !estados.length && !uis.length) {
          estado = 'pendiente';
          razon.push(inRenderers(compId) + inRefs(compId) === 0
            ? 'El componente no se usa en ningún sitio rastreable (¿huérfano?) y su manejador llega por prop.'
            : 'El manejador llega por prop y el componente se usa de forma dinámica (mapa/variante): binding no rastreable.');
        } else if (noResuelto && !starts.length && !a.destino && !el.enviaFormulario) {
          estado = 'pendiente';
          razon.push('El manejador no se pudo resolver estáticamente.');
        } else if (escrituraSinEfecto > 0 && a.llamadasApi.length === escrituraSinEfecto) {
          estado = 'parcial';
          razon.push('Todos los endpoints de escritura alcanzados no muestran, estáticamente, escritura en BD ni emisión; revisar si delegan dinámicamente.');
        } else if (a.llamadasApi.some((ac) => !ac.externa && ac.endpoints.length)) {
          const todasProbadas = a.llamadasApi.filter((ac) => !ac.externa && ac.endpoints.length).every((ac) => ac.endpoints.every((id) => {
            const ep = epById.get(id);
            return ep?.pruebas?.length && (!verifiedRoutes || verifiedRoutes.has(id));
          }));
          if (todasProbadas && verifiedRoutes) {
            estado = 'verificada';
            razon.push('Cadena interfaz→API→backend completa y el endpoint lo ejercita una prueba que se ejecutó y pasó.');
          } else {
            estado = 'pendiente';
            razon.push(todasProbadas ? 'Hay pruebas del endpoint pero aún no hay resultado de ejecución registrado.' : 'Cadena estática completa; ninguna prueba ejercita el endpoint desde el borde HTTP.');
          }
        } else if (navs.length || el.destino) {
          // Navegación: ¿el destino existe?
          const destinos = [...navs.map((n) => n.destino), el.destino].filter(Boolean);
          estado = 'pendiente';
          razon.push(`Navegación (${destinos.slice(0, 2).join(' · ').slice(0, 90)}): sin prueba de interfaz que la ejecute.`);
        } else if (estados.length || uis.length) {
          estado = 'pendiente';
          razon.push('Efecto local (estado de interfaz): sin prueba de interfaz que lo ejecute.');
        } else {
          estado = 'pendiente';
          razon.push('El manejador no alcanza API, navegación ni estado local rastreable.');
        }
      } else if (estado === 'desconectada' || estado === 'sin_implementar') {
        // ya clasificado
      }
      if (estado === 'pendiente' && a.llamadasApi.length === 0 && !navs.length && !el.destino && !estados.length && !uis.length && tieneManejador && !noResuelto && starts.length) {
        // nada observable
      }
      a.estado = estado;
      a.razon = razon;
      a.notas = notas;
      a.evidencias = evidencias;
      a.banderas = banderas.slice(0, 4);
      a.propSinBinding = propSinBinding;
      actions.push(a);
    }
  }
  return actions;
}
