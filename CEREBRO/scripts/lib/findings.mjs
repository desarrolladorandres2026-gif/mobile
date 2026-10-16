// Hallazgos automáticos: reglas deterministas sobre el grafo + escaneo de texto. Cada hallazgo lleva evidencia localizable.
import fs from 'node:fs';
import { abs, shortHash } from './util.mjs';
import { layerOf } from './domain.mjs';

import path from 'node:path';
function existeRelativo(desde, spec) {
  const base = path.resolve(abs(path.dirname(desde)), spec);
  const cands = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.css', '/index.ts', '/index.tsx', '/index.js'];
  return cands.some((c) => { try { return fs.statSync(base + c).isFile(); } catch { return false; } });
}
const SEV_ORDER = { CRITICO: 0, ALTO: 1, MEDIO: 2, BAJO: 3 };

function mk(regla, clave, base) {
  return {
    id: `${regla}:${shortHash(clave)}`,
    regla,
    origen: 'auto',
    estado: 'abierto',
    area: 'calidad',
    alcance: 'local',
    probabilidad: 'media',
    impacto: 'medio',
    elementos: [],
    evidencia: [],
    ...base,
  };
}

// ── escaneo de secretos (sin guardar nunca el valor) ──
const SECRET_PATTERNS = [
  { nombre: 'clave privada PEM', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/, fuerte: true },
  { nombre: 'credencial AWS', re: /\bAKIA[0-9A-Z]{16}\b/, fuerte: true },
  { nombre: 'llave Wompi/pasarela', re: /\b(?:pub|prv|prod_pub|prod_prv|test_pub|test_prv|test_integrity|prod_integrity|test_events|prod_events)_?(?:test|prod)?_[A-Za-z0-9]{12,}\b/, fuerte: true },
  { nombre: 'llave sk_/pk_', re: /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{12,}\b/, fuerte: true },
  { nombre: 'URI de MongoDB con credenciales', re: /mongodb(?:\+srv)?:\/\/[^\s'"`:@/]+:[^\s'"`@/]+@/, fuerte: true },
  { nombre: 'JWT embebido', re: /\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{6,}/, fuerte: true },
  { nombre: 'asignación sospechosa de secreto', re: /\b(?:secret|passw(?:or)?d|token|api[_-]?key|private[_-]?key|client[_-]?secret)\b\s*[:=]\s*['"]([^'"\s]{16,})['"]/i, fuerte: false },
];
const PLACEHOLDER = /(usuario|cluster|user:|username|contrase|change|your|xxxx|example|placeholder|replace|dummy|test-|tu[_-]|<|\$\{|process\.env|\.\.\.|aaaa|0000|1234|secret-key|reemplaz|cambia|sample|fake|mock)/i;

export function scanSecrets(inventory) {
  const out = [];
  for (const e of inventory) {
    if (e.modo === 'ninguno' && e.clase !== 'doc') continue;
    if (e.clase === 'lock' || e.lineas == null || e.bytes > 600_000) continue;
    let txt;
    try { txt = fs.readFileSync(abs(e.ruta), 'utf8'); } catch { continue; }
    const lines = txt.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.length > 2000) continue;
      for (const p of SECRET_PATTERNS) {
        const m = p.re.exec(line);
        if (!m) continue;
        const val = m[1] ?? m[0];
        if (PLACEHOLDER.test(val) || PLACEHOLDER.test(line.slice(Math.max(0, m.index - 40), m.index + val.length + 5))) continue;
        if (!p.fuerte && /(^|\/)__tests__\/|\.test\.|\.spec\./.test(e.ruta)) continue;
        if (/\.example$|\.sample$/.test(e.ruta) && p.nombre.startsWith('URI')) continue;
        out.push({ archivo: e.ruta, linea: i + 1, patron: p.nombre, fuerte: p.fuerte, valorEnmascarado: `${val.slice(0, 3)}… (${val.length} caracteres)`, clase: e.clase });
        break;
      }
    }
  }
  return out;
}

export function buildAutoFindings(ctx) {
  const { inventory, factsMap, graph, endpointData, actions, screens, models, events, jobs, env, integrations, dead, cycles, dups, tests, secrets, tokenIdx } = ctx;
  const F = [];
  const epById = new Map(endpointData.endpoints.map((e) => [e.id, e]));

  // 1) llamadas de frontend sin endpoint
  for (const c of endpointData.calls) {
    if (c.externa || c.endpoints.length) continue;
    if (/version\.json$|^\/(assets|static)\//.test(c.plantillaApi)) continue;
    F.push(mk('ruta-api-rota', `${c.archivo}:${c.linea}:${c.metodo}${c.plantillaApi}`, {
      titulo: `${c.paquete} llama a ${c.metodo} ${c.plantillaApi}, que no existe en el backend`,
      severidad: 'ALTO', confianza: c.desconocida ? 'probable' : 'confirmado', area: 'ui', alcance: 'modulo', probabilidad: 'alta', impacto: 'alto',
      descripcion: c.metodoOtro?.length ? `La ruta existe pero con ${c.metodoOtro.join('/')}, no con ${c.metodo}.` : 'Ningún endpoint registrado coincide con método y ruta.',
      consecuencia: 'La acción de la interfaz que la dispara falla con 404/405 en ejecución.',
      evidencia: [{ archivo: c.archivo, linea: c.linea, texto: `${c.metodo} ${c.plantillaApi}` }],
      elementos: [c.desde],
      pruebaSugerida: 'Prueba de contrato: cada llamada de frontend debe resolver a un endpoint registrado (apiContract.test.ts ya existe como base).',
    }));
  }

  // 2) endpoints: seguridad estructural
  const authFreeOk = /^(POST \/api\/v1\/auth\/(login|register|refresh-token|forgot-password|reset-password|verify-otp|resend-otp|oauth|google|apple|login-otp|complete|2fa\/login|check|exists)|GET \/(health|api\/v1\/health)|POST \/api\/v1\/payments\/webhook|POST \/api\/v1\/telemetry\/crash|GET \/api\/v1\/app\/version)/;
  for (const ep of endpointData.endpoints) {
    const g = ep.guardas;
    const mut = ep.metodo !== 'GET' && ep.metodo !== 'HEAD' && ep.metodo !== 'OPTIONS';
    if (g.publica && mut && !authFreeOk.test(ep.id) && !/\/api\/v1\/auth\//.test(ep.id) && ep.montada && !ep.publicaDeclarada && !g.otros.includes('identifyIfPossible')) {
      F.push(mk('mutacion-publica', ep.id, {
        titulo: `${ep.id} modifica datos sin exigir sesión`,
        severidad: g.limites.length ? 'MEDIO' : 'ALTO', confianza: g.limites.length ? 'hipotesis' : 'probable', area: 'seguridad', alcance: 'modulo', probabilidad: 'media', impacto: 'alto',
        descripcion: 'La ruta no incluye `authenticate` en su cadena de middlewares ni en el router. Puede ser deliberada (registro, webhook); hay que confirmar que valida identidad por otro medio.',
        consecuencia: 'Cualquier cliente de internet podría invocar la operación.',
        evidencia: [{ archivo: ep.archivo, linea: ep.linea, texto: ep.id }], elementos: [ep.id],
        pruebaSugerida: 'Petición sin Authorization: debe responder 401.',
      }));
    }
    if (mut && g.autenticada && !g.validadores.length && !g.subidas.length && ep.montada && ep.manejador) {
      F.push(mk('mutacion-sin-validacion', ep.id, {
        titulo: `${ep.id} acepta cuerpo sin esquema de validación en la ruta`,
        severidad: 'BAJO', confianza: 'hipotesis', area: 'seguridad', alcance: 'local', probabilidad: 'media', impacto: 'medio',
        descripcion: 'No hay `validate(schema)` entre los middlewares. El controlador podría validar por dentro; no se ha comprobado.',
        consecuencia: 'Campos inesperados o de tipo incorrecto podrían llegar al servicio.',
        evidencia: [{ archivo: ep.archivo, linea: ep.linea, texto: ep.id }], elementos: [ep.id],
        pruebaSugerida: 'Enviar cuerpo vacío y con tipos erróneos; esperar 400.',
      }));
    }
    if (g.autenticada && !g.roles.length && (g.permisos.length || g.permisosCualquiera.length) && !g.soloAdminPermisos.length && ep.montada) {
      F.push(mk('permiso-sin-tipo-de-cuenta', ep.id, {
        titulo: `${ep.id} exige permiso pero no limita el tipo de cuenta`,
        severidad: 'MEDIO', confianza: 'hipotesis', area: 'seguridad', alcance: 'local', probabilidad: 'baja', impacto: 'alto',
        descripcion: '`requirePermission` no restringe por tipo de cuenta (lo dice su propia documentación): un comercio o domiciliario con ese permiso en su rol legacy pasaría. Comprobar que ninguno lo tiene.',
        consecuencia: 'Posible acceso de un rol no administrativo a una operación de administración.',
        evidencia: [{ archivo: ep.archivo, linea: ep.linea, texto: `${ep.id} → ${[...g.permisos, ...g.permisosCualquiera].join(', ')}` }], elementos: [ep.id],
        pruebaSugerida: 'Con un token de BUSINESS/DRIVER que tenga ese permiso, esperar 403.',
      }));
    }
    if (!ep.consumidores?.length && ep.montada && !/webhook|health|oauth/i.test(ep.ruta) && !ep.pruebas?.length) {
      F.push(mk('endpoint-sin-consumidor', ep.id, {
        titulo: `${ep.id} no tiene consumidor ni prueba`,
        severidad: 'BAJO', confianza: 'hipotesis', area: 'arquitectura', alcance: 'local', probabilidad: 'media', impacto: 'bajo',
        descripcion: 'Ningún frontend del repo ni prueba HTTP lo llama. Puede usarlo un cliente externo, un enlace compartido o una integración fuera del repositorio.',
        consecuencia: 'Superficie de ataque y mantenimiento sin uso demostrado.',
        evidencia: [{ archivo: ep.archivo, linea: ep.linea, texto: ep.id }], elementos: [ep.id],
      }));
    }
    if (!ep.manejador && ep.montada) {
      F.push(mk('endpoint-sin-manejador-resuelto', ep.id, {
        titulo: `${ep.id}: el manejador no se pudo resolver a un controlador/servicio`,
        severidad: 'BAJO', confianza: 'hipotesis', area: 'calidad', alcance: 'local',
        descripcion: 'El análisis no encontró una llamada a un símbolo del repo dentro del manejador (puede ser lógica en línea).',
        evidencia: [{ archivo: ep.archivo, linea: ep.linea, texto: ep.id }], elementos: [ep.id],
      }));
    }
  }
  const montadas = new Set(endpointData.endpoints.filter((e) => e.montada).map((e) => e.archivo));
  for (const [file, fx] of factsMap) {
    if (fx.rutasHttp?.rutas.length && /routes\//.test(file) && !montadas.has(file)) {
      F.push(mk('router-sin-montar', file, {
        titulo: `El router ${file} declara rutas pero no está montado`, severidad: 'ALTO', confianza: 'probable', area: 'arquitectura', alcance: 'modulo',
        descripcion: 'Ninguna cadena app.use(...) alcanza este archivo desde app.ts.', consecuencia: 'Esas rutas no existen en ejecución.',
        evidencia: [{ archivo: file, linea: fx.rutasHttp.rutas[0].linea }],
      }));
    }
  }

  // 3) acciones de interfaz
  for (const a of actions) {
    if (a.estado === 'desconectada' || a.estado === 'sin_implementar' || a.estado === 'con_errores' || a.estado === 'parcial') {
      const sev = a.estado === 'con_errores' ? 'ALTO' : a.estado === 'parcial' ? 'BAJO' : 'MEDIO';
      F.push(mk(`accion-${a.estado}`, a.id, {
        titulo: `${a.estado === 'desconectada' ? 'Control desconectado' : a.estado === 'sin_implementar' ? 'Acción sin implementar' : a.estado === 'con_errores' ? 'Acción con error' : 'Acción parcial'}: ${a.tag} «${(a.etiqueta || '').slice(0, 50)}»`,
        severidad: sev, confianza: a.estado === 'parcial' ? 'hipotesis' : 'probable', area: 'ui', alcance: 'local', probabilidad: 'alta', impacto: a.estado === 'parcial' ? 'bajo' : 'medio',
        descripcion: a.razon.join(' '), consecuencia: 'El usuario pulsa y no obtiene el resultado esperado.',
        evidencia: [{ archivo: a.archivo, linea: a.linea }, ...a.evidencias.slice(0, 3)], elementos: [a.id],
      }));
    }
  }

  // 4) imports rotos y errores de sintaxis
  for (const [file, fx] of factsMap) {
    for (const imp of fx.imports ?? []) {
      if (imp.noResuelto && !imp.interno && !existeRelativo(file, imp.spec)) {
        F.push(mk('import-roto', `${file}:${imp.spec}`, {
          titulo: `Import que no resuelve: «${imp.spec}» en ${file}`, severidad: 'ALTO', confianza: 'confirmado', area: 'calidad', alcance: 'local',
          descripcion: 'El módulo relativo no existe o no se pudo resolver con la configuración de TypeScript del paquete.', consecuencia: 'Falla la compilación o el arranque del módulo.',
          evidencia: [{ archivo: file, linea: imp.linea, texto: imp.spec }],
        }));
      }
    }
    if (fx.erroresSintaxis) {
      F.push(mk('error-sintaxis', file, { titulo: `${file} tiene ${fx.erroresSintaxis} errores de sintaxis`, severidad: 'ALTO', confianza: 'confirmado', evidencia: [{ archivo: file, linea: 1 }] }));
    }
  }

  // 5) ciclos
  for (const c of cycles.slice(0, 40)) {
    F.push(mk('dependencia-circular', c.join('|'), {
      titulo: `Dependencia circular entre ${c.length} archivos (${c.slice(0, 3).map((x) => x.split('/').pop()).join(' ↔ ')}${c.length > 3 ? '…' : ''})`,
      severidad: c.length > 6 ? 'MEDIO' : 'BAJO', confianza: 'confirmado', area: 'arquitectura', alcance: 'modulo',
      descripcion: `Los imports de valor forman un ciclo: ${c.join(' → ')}.`, consecuencia: 'Orden de inicialización frágil; imports que devuelven undefined según el orden de carga.',
      evidencia: c.slice(0, 8).map((f) => ({ archivo: f, linea: 1 })),
    }));
  }

  // 6) código sin uso
  for (const d of dead) {
    if (d.nivel === 'solo-pruebas') continue;
    F.push(mk('codigo-sin-uso', d.id, {
      titulo: `${d.tipo} sin referencias: ${d.id.split('#')[1]}`,
      severidad: 'BAJO', confianza: d.nivel === 'sin-referencias' ? 'probable' : 'hipotesis', area: 'calidad',
      descripcion: d.nivel === 'sin-referencias'
        ? 'Ninguna referencia resuelta por el verificador de tipos ni mención textual en otros archivos de producción.'
        : `Sin referencias resueltas, pero el nombre aparece en ${d.mencionadoEn.length ? d.mencionadoEn.join(', ') : 'otros archivos'} (puede ser uso dinámico).`,
      evidencia: [{ archivo: d.archivo, linea: d.linea }], elementos: [d.id],
    }));
  }

  // 7) duplicación
  for (const g of dups.slice(0, 60)) {
    F.push(mk('duplicacion', g.hash, {
      titulo: `Lógica duplicada (${g.copias.length} copias, ~${g.largo} caracteres)`, severidad: 'BAJO', confianza: 'confirmado', area: 'calidad', alcance: 'transversal',
      descripcion: `Cuerpos idénticos tras normalizar espacios y comentarios: ${g.copias.map((c) => c.id.split('#')[1]).slice(0, 4).join(', ')}.`,
      consecuencia: 'Una corrección aplicada a una copia deja las demás con el error.',
      evidencia: g.copias.slice(0, 5).map((c) => ({ archivo: c.archivo, linea: c.linea })), elementos: g.copias.map((c) => c.id),
    }));
  }

  // 8) eventos
  for (const ev of events) {
    if (ev.integrado) continue;
    const empaquetados = new Set(ev.oyentes.map((o) => o.paquete));
    if (ev.emisores.length && !ev.oyentes.length) {
      F.push(mk('evento-sin-oyente', ev.evento, {
        titulo: `El evento «${ev.evento}» se emite pero nadie lo escucha`, severidad: 'BAJO', confianza: 'probable', area: 'arquitectura',
        descripcion: 'No se encontró `.on(\'' + ev.evento + '\')` en ningún paquete del repo.', evidencia: ev.emisores.slice(0, 3).map((x) => ({ archivo: x.archivo, linea: x.linea })),
      }));
    }
    if (ev.oyentes.length && !ev.emisores.length) {
      F.push(mk('oyente-sin-emisor', ev.evento, {
        titulo: `Se escucha «${ev.evento}» pero nadie lo emite`, severidad: 'MEDIO', confianza: 'probable', area: 'arquitectura',
        descripcion: 'El oyente nunca se dispara (salvo que lo emita un componente fuera del repo o de forma dinámica).', evidencia: ev.oyentes.slice(0, 3).map((x) => ({ archivo: x.archivo, linea: x.linea })),
      }));
    }
    void empaquetados;
  }

  // 9) procesos
  for (const j of jobs) {
    if (!j.arrancado && j.ambito !== 'ui') {
      F.push(mk('proceso-no-arrancado', `${j.archivo}:${j.linea}`, {
        titulo: `Proceso periódico sin arranque demostrado: ${(j.arrancador ?? j.de).split('#')[1]}`, severidad: 'MEDIO', confianza: 'probable', area: 'operacion',
        descripcion: j.soloPruebas ? 'Solo las pruebas llaman al arrancador.' : 'Nadie llama al arrancador desde código de producción.',
        consecuencia: 'La tarea programada nunca corre.', evidencia: [{ archivo: j.archivo, linea: j.linea, texto: `setInterval ${j.intervalo}` }], elementos: [j.arrancador].filter(Boolean),
      }));
    }
  }

  // 10) entorno
  for (const v of env.variables) {
    if (!v.documentada && v.paquetes.some((p) => ['backend', 'admin', 'business', 'web'].includes(p)) && !/^(NODE_ENV|PORT|DEV|PROD|MODE|BASE_URL|SSR)$/.test(v.nombre)) {
      F.push(mk('variable-entorno-no-documentada', v.nombre, {
        titulo: `Variable de entorno ${v.nombre} se lee en código pero no figura en ningún .env de ejemplo`, severidad: 'BAJO', confianza: 'probable', area: 'operacion',
        descripcion: 'Sin documentarla, el despliegue puede olvidarla y el código cae en su valor por defecto.', evidencia: v.usos.slice(0, 3).map((u) => ({ archivo: u.archivo, linea: u.linea })),
      }));
    }
  }

  // 11) pruebas desactivadas
  for (const t of tests) {
    if (t.omitidas || t.pendientes) {
      F.push(mk('pruebas-desactivadas', t.archivo, {
        titulo: `${t.archivo}: ${t.omitidas} pruebas omitidas, ${t.pendientes} pendientes (todo)`, severidad: 'BAJO', confianza: 'confirmado', area: 'calidad',
        evidencia: [{ archivo: t.archivo, linea: 1 }],
      }));
    }
  }

  // 12) secretos
  for (const s of secrets) {
    if (!s.fuerte && s.clase === 'doc') continue;
    F.push(mk('secreto-en-repositorio', `${s.archivo}:${s.linea}:${s.patron}`, {
      titulo: `Posible secreto (${s.patron}) en ${s.archivo}:${s.linea}`, severidad: s.fuerte ? 'CRITICO' : 'ALTO', confianza: s.fuerte ? 'probable' : 'hipotesis', area: 'seguridad', alcance: 'transversal', probabilidad: 'media', impacto: 'alto',
      descripcion: `Coincidencia con el patrón «${s.patron}». Valor enmascarado: ${s.valorEnmascarado}. No se reproduce el valor.`,
      consecuencia: 'Una credencial en el repositorio queda expuesta a quien lo clone y permanece en el historial git.',
      evidencia: [{ archivo: s.archivo, linea: s.linea, texto: s.patron }], pruebaSugerida: 'Revisar el archivo, rotar la credencial si es real y retirarla del historial.',
    }));
  }
  for (const e of inventory) {
    if (/(^|\/)\.env(\.[a-z]+)?$/.test(e.ruta) && !/example|sample|template/.test(e.ruta)) {
      F.push(mk('env-versionado', e.ruta, { titulo: `${e.ruta} está en el repositorio`, severidad: 'ALTO', confianza: 'confirmado', area: 'seguridad', evidencia: [{ archivo: e.ruta, linea: 1 }] }));
    }
    if (/(^|\/)(__pycache__)\/|\.pyc$/.test(e.ruta) || (/\.py$/.test(e.ruta) && /(^|\/)src\//.test(e.ruta))) {
      F.push(mk('residuo-en-src', e.ruta, {
        titulo: `Archivo de herramienta suelto dentro de src: ${e.ruta}`, severidad: 'BAJO', confianza: 'confirmado', area: 'calidad',
        descripcion: 'Scripts auxiliares de Python (o su bytecode) viven entre el código de la aplicación. No participan en el build pero ensucian el repo.', evidencia: [{ archivo: e.ruta, linea: 1 }],
      }));
    }
  }

  // 13) configuración de modelos sin lector (heurística por menciones)
  for (const m of models) {
    for (const c of m.campos) {
      const capas = c.menciones;
      const escribePanel = (capas.validador ?? 0) > 0;
      const lee = (capas.servicio ?? 0) + (capas.utilidad ?? 0) + (capas.controlador ?? 0) > 0;
      if (escribePanel && !lee && !/^(_id|createdAt|updatedAt|__v)$/.test(c.nombre)) {
        F.push(mk('campo-sin-lector', `${m.nombre}.${c.nombre}`, {
          titulo: `${m.nombre}.${c.nombre}: se envía/valida pero ningún servicio ni controlador lo menciona`,
          severidad: 'MEDIO', confianza: 'hipotesis', area: 'finanzas', alcance: 'modulo', probabilidad: 'media', impacto: 'medio',
          descripcion: 'El nombre del campo aparece en validadores o interfaces pero no en servicios, controladores ni utilidades. Si es una regla de negocio configurable, podría no estar aplicándose. Hay que confirmar que no se lee por acceso dinámico o por spread de objeto.',
          consecuencia: 'Un parámetro configurable en el panel podría no tener efecto en la operación.',
          evidencia: [{ archivo: m.archivo, linea: c.linea, texto: c.nombre }], elementos: [m.simbolo],
          pruebaSugerida: 'Cambiar el valor y comprobar que cambia el resultado calculado.',
        }));
      }
    }
  }
  F.sort((a, b) => SEV_ORDER[a.severidad] - SEV_ORDER[b.severidad] || a.regla.localeCompare(b.regla));
  return F;
}
