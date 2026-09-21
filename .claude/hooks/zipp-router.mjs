#!/usr/bin/env node
/**
 * ZIPP — enrutador automático a agentes especializados.
 *
 * Se engancha dos veces en .claude/settings.json:
 *   UserPromptSubmit  -> mira el texto de la petición
 *   PreToolUse        -> mira la ruta del archivo que se va a editar
 *
 * Solo AVISA: inyecta contexto adicional. Nunca deniega una herramienta ni
 * concede permisos, porque un hook que bloquea acaba desactivado a la tercera
 * sesión, y uno que auto-aprueba edita ledger.service.ts sin que nadie mire.
 *
 * Node 22, sin dependencias. Entrada JSON por stdin, salida JSON por stdout.
 */

// ---------------------------------------------------------------------------
// TODO(usuario): esta lista es criterio, no técnica. Pocas palabras y el hook
// no se entera; demasiadas y avisa en cada frase hasta que se ignora. Ajusta
// los términos a cómo hablas tú de cada tema cuando trabajas.
// El texto se compara sin tildes y en minúsculas.
// ---------------------------------------------------------------------------
const KEYWORD_ROUTES = [
  {
    tema: 'dinero',
    agentes: ['zipp-finance'],
    palabras: [
      'ledger', 'libro mayor', 'asiento', 'comision', 'liquidacion', 'payout',
      'wompi', 'pasarela', 'cobro', 'facturac', 'rentabilidad', 'margen',
      'cupon', 'descuento', 'cashback', 'puntos', 'reembolso', 'chargeback',
      'efectivo', 'tarifa', 'precio', 'cuanto ganamos', 'cuanto gana',
    ],
  },
  {
    tema: 'seguridad',
    agentes: ['zipp-security'],
    palabras: [
      'seguridad', 'vulnerab', 'token', 'jwt', 'sesion', 'refresh', 'login',
      'contrasena', 'password', 'permiso', 'rol', 'rbac', '2fa',
      'totp', 'cifrad', 'encriptad', 'fraude', 'abuso', 'suplantac',
      'rate limit', 'datos personales', 'habeas data',
    ],
  },
  {
    tema: 'arquitectura',
    agentes: ['zipp-architect'],
    palabras: [
      'migracion', 'migrar', 'schema', 'modelo nuevo', 'refactor',
      'escalar', 'escalab', 'arquitectura', 'indice', 'agregacion',
    ],
  },
  {
    tema: 'pruebas',
    agentes: ['zipp-qa'],
    palabras: ['test', 'prueba', 'cobertura', 'suite', 'vitest', 'jest'],
  },
  {
    tema: 'descubrimiento',
    agentes: ['zipp-discovery'],
    palabras: [
      'explorar', 'descubrimiento', 'recomendac', 'coleccion', 'feed',
      'inicio', 'home', 'busqueda', 'buscador', 'retencion', 'personalizac',
    ],
  },
  {
    tema: 'operación',
    agentes: ['zipp-operations'],
    palabras: [
      'dispatch', 'reparto', 'asignac', 'cancelac', 'incidenc', 'sos',
      'soporte', 'pqrs', 'despliegue', 'deploy', 'produccion', 'monitoreo',
    ],
  },
  {
    tema: 'crecimiento',
    agentes: ['zipp-growth'],
    palabras: [
      'promocion', 'campana', 'referid', 'publicidad', 'anuncio',
      'crecimiento', 'zipp pro', 'membresia', 'fidelizac',
    ],
  },
  {
    tema: 'competencia',
    agentes: ['zipp-competitor'],
    palabras: ['rappi', 'didi', 'uber eats', 'ifood', 'competencia', 'competidor'],
  },
  {
    tema: 'comercio',
    agentes: ['zipp-merchant'],
    palabras: ['comercio', 'restaurante', 'tienda', 'menu', 'inventario', 'onboarding'],
  },
  {
    tema: 'repartidor',
    agentes: ['zipp-driver'],
    palabras: ['repartidor', 'domiciliario', 'turno', 'oferta de pedido', 'fondo rotatorio'],
  },
  {
    tema: '¿ya existe?',
    agentes: ['zipp-auditor'],
    palabras: ['ya existe', 'esta implementado', 'codigo muerto', 'deuda tecnica', 'auditar'],
  },
];

// ---------------------------------------------------------------------------
// Rutas → especialistas. El orden importa: lo más específico primero.
// ---------------------------------------------------------------------------
const P = '(^|/)';
const PATH_ROUTES = [
  {
    motivo: 'pagos y pasarela',
    agentes: ['zipp-finance', 'zipp-security'],
    re: new RegExp(P + 'backend/src/(services/payments/|models/(Payment|SavedCard|Refund)\\.ts|controllers/payment\\.controller\\.ts|routes/payment\\.routes\\.ts)', 'i'),
  },
  {
    motivo: 'dinero: el asiento tiene que cuadrar',
    agentes: ['zipp-finance'],
    re: new RegExp(P + 'backend/src/(services/(ledger|pricing|pricingConfig|payout|loyalty|coupon|refund|cashReconciliation|cashIncident)\\.service\\.ts|utils/money\\.ts|models/(LedgerEntry|Payout|Commission|Loyalty\\w*|Coupon|CashReconciliation|CashPaymentIncident|DriverDebt|PlatformPricingConfig|AdInvoice|Settlement)\\.ts|controllers/finance\\.controller\\.ts|routes/finance\\.routes\\.ts)', 'i'),
  },
  {
    motivo: 'seguridad: pregúntate cómo se abusa de esto',
    agentes: ['zipp-security'],
    re: new RegExp(P + 'backend/src/(security/|services/(auth|mfa|authorization|accountDeletion)\\.service\\.ts|middlewares/(auth|security|validate)\\.ts|routes/(auth|rbac|security)\\.routes\\.ts|models/(User|Role|OAuthReplay)\\.ts)', 'i'),
  },
  {
    motivo: 'núcleo del pedido: la cascada llega hasta la liquidación',
    agentes: ['zipp-architect', 'zipp-operations'],
    re: new RegExp(P + 'backend/src/services/(order|dispatch|tracking|errand|orderSecurity|orderFlow)\\w*\\.service\\.ts', 'i'),
  },
  {
    motivo: 'descubrimiento: mira docs/EXPLORAR.md antes',
    agentes: ['zipp-discovery'],
    re: new RegExp(P + '(backend/src/services/(homeSections|search|offers|explore)\\w*\\.service\\.ts|docs/EXPLORAR\\.md)', 'i'),
  },
  {
    motivo: 'schema o migración: compatibilidad y backfill',
    agentes: ['zipp-architect', 'zipp-auditor'],
    re: new RegExp(P + 'backend/src/(models/|migrations/)', 'i'),
  },
  {
    motivo: 'el color vive en DOS archivos y se sincronizan a mano',
    agentes: ['zipp-mobile'],
    re: new RegExp(P + '(variables de color/colores\\.css|mobile/theme/tokens\\.ts)', 'i'),
  },
  {
    motivo: 'app móvil',
    agentes: ['zipp-mobile'],
    re: new RegExp(P + 'mobile/', 'i'),
  },
  {
    motivo: 'panel de comercios',
    agentes: ['zipp-merchant'],
    re: new RegExp(P + 'business/', 'i'),
  },
  {
    motivo: 'panel de administración',
    agentes: ['zipp-operations'],
    re: new RegExp(P + '(admin/|deploy/)', 'i'),
  },
  {
    motivo: 'backend',
    agentes: ['zipp-backend'],
    re: new RegExp(P + 'backend/src/', 'i'),
  },
];

const sinTildes = (s) =>
  String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/**
 * El término debe EMPEZAR donde empieza una palabra, pero puede continuar
 * dentro de ella: así 'comision' casa "comisiones" y 'sos' no casa "permisos".
 * Comparar con includes() a secas producía avisos de SOS cada vez que se
 * hablaba de permisos.
 *
 * El guion bajo cuenta como letra: sin eso, 'token' casaba dentro de
 * "subagent_tokens" — metadatos del propio arnés, no algo que el usuario
 * escribiera — y el hook avisaba de seguridad en turnos automáticos.
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
    `[ZIPP] ${aviso.detalle}. La doctrina de CLAUDE.md pide consultar a ` +
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
