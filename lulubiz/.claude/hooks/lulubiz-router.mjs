#!/usr/bin/env node
/**
 * Lulubiz — enrutador automático a agentes especializados.
 *
 * Se engancha dos veces en .claude/settings.json:
 *   UserPromptSubmit  -> mira el texto de la petición
 *   PreToolUse        -> mira la ruta del archivo que se va a editar
 *
 * Solo AVISA: inyecta contexto adicional. Nunca deniega una herramienta ni
 * concede permisos: un hook que bloquea acaba desactivado, y uno que
 * auto-aprueba deja editar el libro sin que nadie mire.
 *
 * Node 22, sin dependencias. Entrada JSON por stdin, salida JSON por stdout.
 */

// El texto se compara sin tildes y en minúsculas. Pocas palabras y el hook no
// se entera; demasiadas y avisa en cada frase hasta que se ignora.
const KEYWORD_ROUTES = [
  {
    tema: 'contabilidad',
    agentes: ['lulubiz-contabilidad'],
    palabras: [
      'asiento', 'libro', 'partida doble', 'plan de cuentas', 'saldo', 'periodo',
      'cierre de ejercicio', 'cartera', 'conciliacion', 'activo fijo',
      'depreciacion', 'inventario', 'kardex', 'balance', 'estado de resultados',
      'presupuesto', 'flujo de efectivo', 'verificador',
    ],
  },
  {
    tema: 'análisis contable',
    agentes: ['lulubiz-contador'],
    palabras: [
      'contador', 'niif', 'estados financieros', 'razones financieras',
      'liquidez', 'endeudamiento', 'rentabilidad', 'tratamiento contable',
      'balance de prueba', 'conciliacion', 'cuenta contable',
    ],
  },
  {
    tema: 'registro operativo',
    agentes: ['lulubiz-auxiliar'],
    palabras: [
      'auxiliar contable', 'borrador de asiento', 'prepara el asiento',
      'contabilizar', 'comprobante', 'registrar la factura', 'registrar una',
      'clasificar movimiento', 'extracto', 'documento soporte duplicado',
    ],
  },
  {
    tema: 'seguridad',
    agentes: ['lulubiz-security'],
    palabras: [
      'seguridad', 'vulnerab', 'sesion', 'login', 'contrasena', 'password',
      'permiso', 'rol', 'totp', '2fa', 'clave de api', 'api key', 'cifrad',
      'tenant', 'aislamiento', 'cookie', 'csrf', 'rate limit', 'abuso',
      'habeas data', 'datos personales',
    ],
  },
  {
    tema: 'arquitectura',
    agentes: ['lulubiz-architect'],
    palabras: [
      'migracion', 'migrar', 'esquema', 'coleccion nueva', 'refactor', 'escalar',
      'escalab', 'arquitectura', 'indice', 'agregacion', 'transaccion',
      'sharding', 'consecutivo',
    ],
  },
  {
    tema: 'impuestos y normativa',
    agentes: ['lulubiz-impuestos'],
    palabras: [
      'dian', 'iva', 'retencion', 'reteica', 'reteiva', 'ica', 'exogena',
      'factura electronica', 'cufe', 'resolucion', 'documento soporte', 'nomina',
      'prima', 'cesantias', 'pila', 'uvt', 'tributari',
    ],
  },
  {
    tema: 'pruebas',
    agentes: ['lulubiz-qa'],
    palabras: ['test', 'pruebas', 'cobertura', 'suite', 'vitest', 'playwright', 'e2e'],
  },
  {
    tema: 'competencia',
    agentes: ['lulubiz-competitor'],
    palabras: ['siigo', 'alegra', 'world office', 'quickbooks', 'competencia', 'competidor'],
  },
  {
    tema: '¿ya existe?',
    agentes: ['lulubiz-auditor'],
    palabras: ['ya existe', 'esta implementado', 'codigo muerto', 'deuda tecnica', 'auditar'],
  },
];

// Rutas → especialistas. El orden importa: lo más específico primero.
const P = '(^|/)';
const PATH_ROUTES = [
  {
    motivo: 'libro: el asiento tiene que cuadrar y nada se edita, se revierte',
    agentes: ['lulubiz-contabilidad', 'lulubiz-architect'],
    re: new RegExp(P + 'backend/src/(ledger/|core/money\\.js|closing/|accounts/)', 'i'),
  },
  {
    motivo: 'seguridad: pregúntate cómo se abusa de esto',
    agentes: ['lulubiz-security'],
    re: new RegExp(P + 'backend/src/(auth/|data/tenantCollection\\.js|core/(tenant|limiter)\\.js|audit/|exporting/|scripts/deleteTenant\\.js)', 'i'),
  },
  {
    motivo: 'impuestos, nómina y facturación electrónica: la norma cambia por año',
    agentes: ['lulubiz-impuestos', 'lulubiz-contabilidad'],
    re: new RegExp(P + 'backend/src/(taxes/|payroll/|invoicing/|countries/)', 'i'),
  },
  {
    motivo: 'módulo que asienta: debe cuadrar con el libro y estar en el verificador',
    agentes: ['lulubiz-contabilidad'],
    re: new RegExp(P + 'backend/src/(receivables|purchases|advances|inventory|pos|bank|fixedAssets|reports|budgets|costCenters|commercial)/', 'i'),
  },
  {
    motivo: 'verificador de integridad y configuración de base',
    agentes: ['lulubiz-architect', 'lulubiz-contabilidad'],
    re: new RegExp(P + 'backend/src/scripts/(verifyIntegrity|db-setup|dbSetup)\\w*\\.js', 'i'),
  },
  {
    motivo: 'interfaz: reglamento de diseño (azul/verde/rojo, sin iconos, sin tarjetas)',
    agentes: ['lulubiz-frontend'],
    re: new RegExp(P + '(frontend/(src|tailwind)|e2e/tests/)', 'i'),
  },
  {
    motivo: 'backend',
    agentes: ['lulubiz-backend'],
    re: new RegExp(P + 'backend/src/', 'i'),
  },
];

const sinTildes = (s) =>
  String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/**
 * El término debe EMPEZAR donde empieza una palabra, pero puede continuar
 * dentro de ella: así 'retencion' casa "retenciones" y 'ica' no casa
 * "publica". El guion bajo cuenta como letra para no casar dentro de
 * metadatos del propio arnés.
 */
const contieneTermino = (texto, termino) => {
  const t = sinTildes(termino).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9_])${t}`).test(texto);
};

const leerStdin = () =>
  new Promise((resolve) => {
    let datos = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { datos += c; });
    process.stdin.on('end', () => resolve(datos));
    process.stdin.on('error', () => resolve(''));
  });

/** Saca la ruta del archivo de cualquiera de las formas de tool_input. */
function rutaDe(entrada) {
  const ti = entrada?.tool_input;
  if (!ti || typeof ti !== 'object') return '';
  const cruda = ti.file_path || ti.notebook_path || ti.path || '';
  return String(cruda).replace(/\\/g, '/');
}

function avisoPorRuta(ruta) {
  if (!ruta) return null;
  for (const regla of PATH_ROUTES) {
    if (regla.re.test(ruta)) {
      return { detalle: `${ruta} — ${regla.motivo}`, agentes: regla.agentes };
    }
  }
  return null;
}

function avisoPorTexto(texto) {
  if (!texto) return null;
  const t = sinTildes(texto);
  const temas = [];
  const agentes = new Set();
  for (const regla of KEYWORD_ROUTES) {
    if (regla.palabras.some((p) => contieneTermino(t, p))) {
      temas.push(regla.tema);
      regla.agentes.forEach((a) => agentes.add(a));
    }
  }
  if (!agentes.size) return null;
  // Más de tres temas suele ser una petición amplia, no una señal: no satura.
  if (temas.length > 3) return null;
  return { detalle: `la petición toca ${temas.join(', ')}`, agentes: [...agentes] };
}

function mensaje(aviso) {
  return (
    `[Lulubiz] ${aviso.detalle}. CLAUDE.md pide consultar a ` +
    `${aviso.agentes.join(' y ')} antes de dar el trabajo por terminado. ` +
    `Si decides no hacerlo, di por qué en una línea.`
  );
}

const salir = (obj) => {
  if (obj) process.stdout.write(JSON.stringify(obj));
  process.exit(0);
};

const main = async () => {
  let entrada;
  try {
    entrada = JSON.parse(await leerStdin());
  } catch {
    salir(null); // entrada ilegible: callar es mejor que romper la sesión
  }

  const evento =
    entrada?.hook_event_name || (entrada?.tool_name ? 'PreToolUse' : 'UserPromptSubmit');

  if (evento === 'PreToolUse') {
    const aviso = avisoPorRuta(rutaDe(entrada));
    if (!aviso) salir(null);
    // Sin permissionDecision a propósito: el flujo de permisos normal no se toca.
    salir({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: mensaje(aviso),
      },
    });
  }

  const aviso = avisoPorTexto(entrada?.prompt);
  if (!aviso) salir(null);
  salir({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: mensaje(aviso),
    },
  });
};

main().catch(() => process.exit(0));
