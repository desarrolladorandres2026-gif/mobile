import dotenv from 'dotenv';
import os from 'os';
import crypto from 'crypto';
dotenv.config();

// VITEST is set by the test runner in every worker before any application
// module loads. NODE_ENV alone is not reliable here: dotenv.config() above
// applies .env (which pins NODE_ENV=development) and whether that happens
// before or after the runner sets NODE_ENV depends on import order.
const isTest = process.env.NODE_ENV === 'test' || !!process.env.VITEST;
const isDev = !isTest && (process.env.NODE_ENV || 'development') === 'development';

// ── Get local network IP for mobile/Expo connections ──
function getLocalIP(): string {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

const localIP = getLocalIP();

// ── Secret resolution ────────────────────────────────────────────────
// Known-bad values that must never sign a token in production. These were
// shipped as fallbacks at some point, so anyone can guess them.
const FORBIDDEN_SECRETS = new Set([
  'default_jwt_secret',
  'default_refresh_secret',
  'debuta_super_secreto_2025',
  'debuta_refresh_secreto_2025',
  'changeme',
  'secret',
]);

const startupErrors: string[] = [];

/**
 * Resolves a required secret.
 *
 * In production a missing, weak, or known-leaked value is a hard startup
 * failure — we never silently fall back, because a predictable signing key
 * lets anyone mint valid tokens for any account.
 *
 * Outside production we generate a random ephemeral value so local dev works
 * without setup. The value changes on every restart, which invalidates old
 * sessions; that is intentional and much safer than a shared constant.
 */
function requireSecret(name: string, minLength = 32): string {
  const value = process.env[name];

  if (!value || value.trim() === '') {
    if (isDev || isTest) {
      const ephemeral = crypto.randomBytes(48).toString('hex');
      if (!isTest) {
        console.warn(
          `[SECURITY] ${name} no está definida. Se generó una clave efímera para desarrollo. ` +
            `Las sesiones se invalidarán al reiniciar. Define ${name} en tu .env.`
        );
      }
      return ephemeral;
    }
    startupErrors.push(`${name} es obligatoria en producción y no está definida.`);
    return '';
  }

  if (FORBIDDEN_SECRETS.has(value.toLowerCase())) {
    const message = `${name} usa un valor conocido/filtrado. Debe reemplazarse.`;
    if (isDev || isTest) {
      console.warn(`[SECURITY] ${message}`);
    } else {
      startupErrors.push(message);
    }
  }

  if (value.length < minLength) {
    const message = `${name} es demasiado corta (${value.length} caracteres, mínimo ${minLength}).`;
    if (isDev || isTest) {
      console.warn(`[SECURITY] ${message}`);
    } else {
      startupErrors.push(message);
    }
  }

  return value;
}

function requireValue(name: string, fallbackForDev: string): string {
  const value = process.env[name];
  if (value && value.trim() !== '') return value;

  if (isDev || isTest) return fallbackForDev;

  startupErrors.push(`${name} es obligatoria en producción y no está definida.`);
  return '';
}

// Ports Expo/Metro actually bind to in local development. Shared between
// the CORS allowlist and the payment redirect allowlist below, so both stay
// in sync instead of drifting into two slightly different lists of "the
// dev ports we trust".
const EXPO_DEV_PORTS = ['8081', '8082', '19000', '19006'];

// ── Build CORS origins ──
function buildCorsOrigins(): string[] {
  const origins = [
    process.env.CLIENT_URL || 'http://localhost:3000',
    process.env.ADMIN_URL || 'http://localhost:3001',
    process.env.BUSINESS_URL || 'http://localhost:3002',
  ];

  if (isDev) {
    // Add common Expo/React Native ports on localhost and LAN IP
    for (const port of EXPO_DEV_PORTS) {
      origins.push(`http://localhost:${port}`);
      origins.push(`http://${localIP}:${port}`);
      origins.push(`exp://${localIP}:${port}`);
    }
    origins.push(`http://${localIP}:3000`);
  }

  return origins;
}

/**
 * `exp://host:port` targets a payment redirect may land on when the app runs
 * inside Expo Go, in development only.
 *
 * Not a wildcard: `URL.origin` is the string `"null"` for any non-special
 * scheme (`exp:`, `zipp:`, …) per the WHATWG URL spec, so an `includes()`
 * check against `cors.origins` — which does hold `exp://…` strings — can
 * never match one. This builds the same finite, explicit host:port list
 * `buildCorsOrigins` already trusts for Expo's own dev ports, compared by
 * `host` instead of `origin`, and only when `isDev` — a packaged build has
 * no Expo Go client to return to, so the list is empty outside development.
 */
function buildDevExpoRedirectHosts(): string[] {
  if (!isDev) return [];
  const hosts: string[] = [];
  for (const host of ['localhost', localIP]) {
    for (const port of EXPO_DEV_PORTS) hosts.push(`${host}:${port}`);
  }
  return hosts;
}

const jwtSecret = requireSecret('JWT_SECRET', 32);
const jwtRefreshSecret = requireSecret('JWT_REFRESH_SECRET', 32);
const encryptionKey = requireSecret('ENCRYPTION_KEY', 32);
const csrfSecret = requireSecret('CSRF_SECRET', 32);
const mongoUri = requireValue('MONGODB_URI', 'mongodb://localhost:27017/zipp');

/**
 * Resuelve el token de Mapbox que el servidor entregará a los clientes.
 *
 * Mapbox tiene dos familias de token y solo una puede salir del servidor:
 *
 * - `pk.` — público. Está *diseñado* para viajar al dispositivo: sin él
 *   la app no puede pedir tiles. Se protege restringiéndolo por URL y por
 *   ámbito en el panel de Mapbox, no escondiéndolo.
 * - `sk.` — secreto. Da acceso a la cuenta (crear tokens, subir tilesets,
 *   facturación). Si alguien lo pone aquí por error, `GET /tracking/config`
 *   se lo entregaría a cada teléfono que abra la app — y un token secreto
 *   filtrado no se "arregla", se rota y se paga lo que se haya gastado.
 *
 * Por eso un `sk.` aquí es un fallo de arranque en producción, no un aviso.
 */
function resolveMapboxToken(): string {
  const value = (process.env.MAPBOX_ACCESS_TOKEN || '').trim();
  if (!value) {
    if (!isDev && !isTest) {
      console.warn(
        '[MAPBOX] MAPBOX_ACCESS_TOKEN no está definida. Los mapas, las rutas y ' +
          'el ETA quedan desactivados; el seguimiento seguirá funcionando con ' +
          'distancia en línea recta.'
      );
    }
    return '';
  }

  if (value.startsWith('sk.')) {
    const message =
      'MAPBOX_ACCESS_TOKEN contiene un token SECRETO (sk.). Ese token da acceso a ' +
      'la cuenta de Mapbox y el servidor lo entregaría a cada cliente. Usa el token ' +
      'público (pk.).';
    if (isDev || isTest) console.warn(`[SECURITY] ${message}`);
    else startupErrors.push(message);
    return '';
  }

  if (!value.startsWith('pk.')) {
    console.warn(
      '[MAPBOX] MAPBOX_ACCESS_TOKEN no parece un token de Mapbox (debería empezar por "pk.").'
    );
  }

  return value;
}

const mapboxToken = resolveMapboxToken();

if (jwtSecret && jwtRefreshSecret && jwtSecret === jwtRefreshSecret) {
  const message = 'JWT_SECRET y JWT_REFRESH_SECRET no pueden ser iguales.';
  if (isDev || isTest) console.warn(`[SECURITY] ${message}`);
  else startupErrors.push(message);
}

/**
 * Lo que impide que un despliegue de producción "cobre" sin cobrar.
 *
 * El proveedor `sandbox` aprueba cada pago al instante y sin tocar dinero:
 * es perfecto para desarrollo y letal en producción, donde cada pedido en
 * línea saldría marcado como pagado, el comercio cocinaría y ZIPP liquidaría
 * un dinero que nunca entró. Lo mismo, en versión más sutil, con unas llaves
 * `pub_test_` de Wompi en producción: los cobros van al sandbox de Wompi y
 * se aprueban con tarjetas de prueba.
 *
 * Ninguno de los dos es un error de programación: son un `.env` copiado a
 * medias. Por eso se comprueba al arrancar y no se confía en que alguien lo
 * note en el panel. Un entorno de pruebas desplegado con NODE_ENV=production
 * puede optar explícitamente con ALLOW_SANDBOX_PAYMENTS=true.
 *
 * Es una función pura sobre un mapa de variables para poder probarla sin
 * arrancar el proceso con otro NODE_ENV.
 */
export function paymentConfigErrors(env: Record<string, string | undefined>): string[] {
  const errors: string[] = [];
  const provider = (env.PAYMENT_PROVIDER || 'sandbox').trim();
  const sandboxAllowed = env.ALLOW_SANDBOX_PAYMENTS === 'true';

  if (provider === 'sandbox' && !sandboxAllowed) {
    errors.push(
      'PAYMENT_PROVIDER=sandbox aprueba pagos sin cobrar dinero real. En producción configura ' +
        'PAYMENT_PROVIDER=wompi con sus 4 credenciales, o declara explícitamente ' +
        'ALLOW_SANDBOX_PAYMENTS=true si este es un entorno de pruebas.'
    );
  }

  if (provider === 'wompi') {
    const required = [
      'WOMPI_PUBLIC_KEY',
      'WOMPI_PRIVATE_KEY',
      'WOMPI_INTEGRITY_SECRET',
      'WOMPI_EVENTS_SECRET',
    ] as const;
    for (const name of required) {
      if (!env[name] || !env[name]!.trim()) {
        errors.push(`${name} es obligatoria cuando PAYMENT_PROVIDER=wompi.`);
      }
    }

    const publicKey = (env.WOMPI_PUBLIC_KEY || '').trim();
    const privateKey = (env.WOMPI_PRIVATE_KEY || '').trim();
    const testKeys = publicKey.startsWith('pub_test_') || privateKey.startsWith('prv_test_');
    const prodKeys = publicKey.startsWith('pub_prod_') && privateKey.startsWith('prv_prod_');

    if (publicKey && privateKey && testKeys && !sandboxAllowed) {
      errors.push(
        'WOMPI_PUBLIC_KEY/WOMPI_PRIVATE_KEY son llaves de PRUEBA (pub_test_/prv_test_): los cobros ' +
          'irían al sandbox de Wompi. Usa las llaves pub_prod_/prv_prod_, o declara ' +
          'ALLOW_SANDBOX_PAYMENTS=true si este es un entorno de pruebas.'
      );
    } else if (publicKey && privateKey && !testKeys && !prodKeys) {
      errors.push(
        'WOMPI_PUBLIC_KEY/WOMPI_PRIVATE_KEY no tienen el formato de Wompi (pub_prod_/prv_prod_ o pub_test_/prv_test_).'
      );
    }
  }

  return errors;
}

if (!isDev && !isTest) {
  startupErrors.push(...paymentConfigErrors(process.env));
}

// Fail fast: refuse to boot a production server with an insecure configuration.
if (startupErrors.length > 0) {
  console.error('\n❌ Configuración inválida. El servidor no puede iniciar:\n');
  for (const err of startupErrors) console.error(`   • ${err}`);
  console.error('\nRevisa tu archivo .env (usa .env.example como referencia).\n');
  process.exit(1);
}

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  isDev,
  isTest,
  localIP,

  mongodb: {
    uri: mongoUri,
  },

  jwt: {
    secret: jwtSecret,
    refreshSecret: jwtRefreshSecret,
    expiresIn: process.env.JWT_EXPIRES_IN || '15m',
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d',
  },

  cloudinary: {
    cloudName: process.env.CLOUDINARY_CLOUD_NAME || '',
    apiKey: process.env.CLOUDINARY_API_KEY || '',
    apiSecret: process.env.CLOUDINARY_API_SECRET || '',
  },

  googleMaps: {
    apiKey: process.env.GOOGLE_MAPS_API_KEY || '',
  },

  // ── Mapbox: mapas, rutas y seguimiento ────────────────────────────
  // El token público (pk.) es el único que sale del servidor: lo entrega
  // `GET /tracking/config` a clientes ya autenticados, porque renderizar
  // un mapa en el dispositivo exige que el token viaje con cada petición
  // de tiles. Se sirve por API en vez de compilarlo dentro de la app para
  // poder rotarlo sin publicar una versión nueva en las tiendas.
  //
  // Las rutas (Directions) NO se piden desde el teléfono: las pide el
  // servidor, que cachea y agrupa. Así una ruta se calcula una vez por
  // pedido y no una vez por repartidor que abre la pantalla.
  mapbox: {
    accessToken: mapboxToken,
    /** Perfil de ruteo. La flota es de motos: `driving` es el correcto. */
    directionsProfile: process.env.MAPBOX_DIRECTIONS_PROFILE || 'driving',
    /** Estilo por defecto de los mapas. Se envía a los clientes. */
    style: process.env.MAPBOX_STYLE_URL || 'mapbox://styles/mapbox/streets-v12',
    styleDark: process.env.MAPBOX_STYLE_URL_DARK || 'mapbox://styles/mapbox/dark-v11',
    /** Cuánto vive una ruta cacheada. Una ruta urbana no cambia en minutos. */
    routeCacheTtlMs: parseInt(process.env.MAPBOX_ROUTE_CACHE_TTL_MS || '300000', 10),
    /**
     * Cuánto vive una dirección cacheada. Por defecto un día.
     *
     * Es mucho más largo que el de las rutas porque el dato es de otra
     * naturaleza: una ruta depende del tráfico de este momento, pero el
     * nombre de una calle no cambia entre semana y semana. Y la app pide
     * geocodificación cada vez que alguien suelta el mapa, así que este
     * caché es lo que separa una factura de Mapbox razonable de una que
     * crece con cada dedo indeciso.
     */
    geocodeCacheTtlMs: parseInt(process.env.MAPBOX_GEOCODE_CACHE_TTL_MS || '86400000', 10),
    /** Corta la petición a Mapbox: sin ruta se sigue entregando, con ETA estimado. */
    timeoutMs: parseInt(process.env.MAPBOX_TIMEOUT_MS || '4000', 10),
    get enabled(): boolean {
      return mapboxToken.length > 0;
    },
  },

  // ── Seguimiento GPS en vivo ───────────────────────────────────────
  // Los umbrales del lado servidor. El teléfono decide cada cuánto pide
  // un fix al GPS (eso es batería); el servidor decide cada cuánto lo
  // escribe y lo retransmite (eso es base de datos y datos móviles).
  // Son dos problemas distintos y por eso son dos números distintos.
  // ── Reparto automático ──
  //
  // Apagado por defecto, y no por prudencia genérica: mientras la app del
  // domiciliario no sepa mostrar una oferta, encender esto le quita el
  // pedido de la lista sin darle ninguna forma de aceptarlo. La cascada
  // solo es una mejora cuando existe el otro extremo del cable.
  dispatch: {
    enabled: process.env.DISPATCH_ENABLED === 'true',
  },

  tracking: {
    /** Mínimo entre dos escrituras en `Driver.currentLocation`, en ms. */
    minPersistIntervalMs: parseInt(process.env.TRACKING_MIN_PERSIST_MS || '5000', 10),
    /** Metros de movimiento por debajo de los cuales el ping se descarta. */
    minMoveMeters: parseInt(process.env.TRACKING_MIN_MOVE_METERS || '15', 10),
    /** Precisión peor que esto se ignora: un fix de 500 m miente más de lo que informa. */
    maxAccuracyMeters: parseInt(process.env.TRACKING_MAX_ACCURACY_METERS || '100', 10),
    /** Días que se conserva el rastro de un pedido, para auditar una entrega. */
    historyRetentionDays: parseInt(process.env.TRACKING_HISTORY_DAYS || '30', 10),
    /** Sin señal por más de esto, el repartidor se muestra como "perdido". */
    staleAfterMs: parseInt(process.env.TRACKING_STALE_AFTER_MS || '90000', 10),
    /** Radio por defecto para buscar el repartidor más cercano, en metros. */
    nearestRadiusMeters: parseInt(process.env.TRACKING_NEAREST_RADIUS_METERS || '8000', 10),
  },

  // Client IDs de OAuth de Google (uno por plataforma, todos apuntan al
  // mismo proyecto de Google Cloud). verifyIdToken acepta cualquiera de
  // ellos como audiencia válida.
  google: {
    webClientId: process.env.GOOGLE_OAUTH_CLIENT_ID_WEB || '',
    iosClientId: process.env.GOOGLE_OAUTH_CLIENT_ID_IOS || '',
    androidClientId: process.env.GOOGLE_OAUTH_CLIENT_ID_ANDROID || '',
  },

  // ── Payments ──────────────────────────────────────────────────────
  // The platform talks to payments through the PaymentProvider interface
  // (src/services/payments). "sandbox" is a fully functional in-process
  // provider for development and tests; real providers are plugged in by
  // setting PAYMENT_PROVIDER and their credentials.
  payments: {
    provider: process.env.PAYMENT_PROVIDER || 'sandbox',
    currency: process.env.PAYMENT_CURRENCY || 'COP',
    // Sandbox behaviour knobs (ignored by real providers)
    sandbox: {
      // Amounts ending in these cents force a failure, so the failure path
      // is testable without special-casing the client.
      failOnAmountSuffix: parseInt(process.env.SANDBOX_FAIL_SUFFIX || '13', 10),
      autoApprove: process.env.SANDBOX_AUTO_APPROVE !== 'false',
    },
    webhookSecret: process.env.PAYMENT_WEBHOOK_SECRET || '',

    // Wompi Colombia (PAYMENT_PROVIDER=wompi). Sandbox vs. production is
    // derived from the key prefix (pub_test_/pub_prod_) inside the provider
    // itself, not from a separate flag — see WompiPaymentProvider.
    // WOMPI_PRIVATE_KEY and the two secrets are server-only and must never
    // reach the mobile app or any client response.
    wompi: {
      publicKey: process.env.WOMPI_PUBLIC_KEY || '',
      privateKey: process.env.WOMPI_PRIVATE_KEY || '',
      integritySecret: process.env.WOMPI_INTEGRITY_SECRET || '',
      eventsSecret: process.env.WOMPI_EVENTS_SECRET || '',
      // How long a Web Checkout link stays payable. Without a bound, a link
      // recovered from a log or a screenshot is still a live charge months
      // later, for an order that may since have been cancelled or re-priced.
      checkoutExpiryMinutes: parseInt(process.env.WOMPI_CHECKOUT_EXPIRY_MINUTES || '30', 10),
      // Oldest event `timestamp` still accepted by the webhook, in seconds.
      // Generous — Wompi retries failed deliveries for a while and its clock
      // is not ours — but finite: a captured event stops being verifiable
      // at all once it ages out, instead of relying only on deduplication.
      // 0 disables the bound.
      webhookMaxAgeSeconds: parseInt(process.env.WOMPI_WEBHOOK_MAX_AGE_SECONDS || '259200', 10),
    },
  },

  // Where a post-payment redirect is allowed to land. The gateway will send
  // the customer wherever this URL points, from a page hosted on the
  // gateway's own trusted domain — so it is an allowlist, never free text.
  // See validators/payment.validator.ts.
  deepLinkScheme: process.env.APP_DEEP_LINK_SCHEME || 'zipp',
  // `exp://host:port` targets allowed only in development — see
  // buildDevExpoRedirectHosts above. Always empty in production.
  devExpoRedirectHosts: buildDevExpoRedirectHosts(),

  otp: {
    expiryMinutes: parseInt(process.env.OTP_EXPIRY_MINUTES || '5', 10),
  },

  platform: {
    commissionRate: parseFloat(process.env.PLATFORM_COMMISSION_RATE || '0.10'),
    defaultDeliveryFee: parseInt(process.env.DEFAULT_DELIVERY_FEE || '5000', 10),
    defaultDriverBaseFund: parseInt(process.env.DEFAULT_DRIVER_BASE_FUND || '50000', 10),

    // ── Delivery pricing ──
    // Fee = base + (billable km × perKm), clamped to [min, max] and rounded
    // to the nearest `rounding` so customers never see odd amounts.
    delivery: {
      baseFee: parseInt(process.env.DELIVERY_BASE_FEE || '4000', 10),
      perKm: parseInt(process.env.DELIVERY_PER_KM || '900', 10),
      freeRadiusKm: parseFloat(process.env.DELIVERY_FREE_RADIUS_KM || '1'),
      minFee: parseInt(process.env.DELIVERY_MIN_FEE || '3000', 10),
      maxFee: parseInt(process.env.DELIVERY_MAX_FEE || '20000', 10),
      rounding: parseInt(process.env.DELIVERY_ROUNDING || '100', 10),
      maxRadiusKm: parseFloat(process.env.DELIVERY_MAX_RADIUS_KM || '12'),
    },

    // Consumer-facing prices in Colombia already include IVA, so the default
    // is 0. Set PLATFORM_TAX_RATE if your jurisdiction requires adding it.
    taxRate: parseFloat(process.env.PLATFORM_TAX_RATE || '0'),

    maxTipRate: parseFloat(process.env.MAX_TIP_RATE || '1'),
  },

  cors: {
    origins: buildCorsOrigins(),
  },

  // ── Security Configuration ──
  // ── Flujo de entrega: chat, evidencias y códigos de seguridad ──────
  // Todos los límites del traspaso físico del pedido viven aquí, no
  // repartidos en constantes por archivo: una operación puede querer
  // códigos de 4 dígitos, un castigo más corto o fotos más pesadas sin
  // que nadie tenga que buscar el número dentro de un servicio.
  orderFlow: {
    code: {
      length: parseInt(process.env.ORDER_CODE_LENGTH || '6', 10),
      /** Intentos fallidos antes de bloquear temporalmente el código. */
      maxAttempts: parseInt(process.env.ORDER_CODE_MAX_ATTEMPTS || '5', 10),
      lockMinutes: parseInt(process.env.ORDER_CODE_LOCK_MINUTES || '15', 10),
      /** Vida del código desde que se emite. 0 = sin caducidad. */
      ttlHours: parseInt(process.env.ORDER_CODE_TTL_HOURS || '24', 10),
    },
    chat: {
      maxLength: parseInt(process.env.ORDER_CHAT_MAX_LENGTH || '1000', 10),
      /** Mensajes por ventana y por usuario, por pedido. */
      maxPerWindow: parseInt(process.env.ORDER_CHAT_MAX_PER_WINDOW || '30', 10),
      windowMs: parseInt(process.env.ORDER_CHAT_WINDOW_MS || '60000', 10),
    },
    evidence: {
      maxBytes: parseInt(process.env.ORDER_EVIDENCE_MAX_BYTES || '5242880', 10),
      /** Minutos que vive la URL firmada de una evidencia. */
      signedUrlTtlMinutes: parseInt(process.env.ORDER_EVIDENCE_URL_TTL_MIN || '10', 10),
      folder: process.env.ORDER_EVIDENCE_FOLDER || 'zipp/order-evidence',
    },
    call: {
      /** Una llamada colgada sin avisar se cierra sola pasado esto. */
      maxDurationMinutes: parseInt(process.env.ORDER_CALL_MAX_MINUTES || '15', 10),
      /** Segundos que suena antes de darse por perdida. */
      ringSeconds: parseInt(process.env.ORDER_CALL_RING_SECONDS || '45', 10),
    },
  },

  /**
   * Imágenes del catálogo de productos.
   *
   * El mínimo de 500 px no es arbitrario: la variante de ficha se sirve a
   * 800, así que por debajo de eso el catálogo estaría ampliando píxeles
   * y el producto se vería peor en ZIPP que en el celular del comercio.
   * Se rechaza con un mensaje que lo explica, en vez de aceptarla y
   * dejar que el cliente vea una foto borrosa.
   */
  productImages: {
    folder: process.env.PRODUCT_IMAGE_FOLDER || 'zipp/products',
    maxBytes: parseInt(process.env.PRODUCT_IMAGE_MAX_BYTES || '8388608', 10),
    minDimension: parseInt(process.env.PRODUCT_IMAGE_MIN_DIMENSION || '500', 10),
    /**
     * Recorte de fondo con IA.
     *
     * Es un **complemento de pago** de Cloudinary que la mayoría de las
     * cuentas no tiene. Por defecto está apagado y el panel no enseña el
     * botón: un botón que falla siempre es peor que no tenerlo.
     */
    backgroundRemoval: process.env.CLOUDINARY_BACKGROUND_REMOVAL === 'true',
  },

  /**
   * Flyers de campañas publicitarias.
   *
   * Mismo criterio que `productImages`: el mínimo evita un flyer que se ve
   * pixelado a pantalla completa, y el tope de peso está separado del de
   * producto porque un flyer patrocinado puede venir de una agencia con
   * fotos de mucha más resolución que la de un celular de comercio.
   */
  advertisements: {
    folder: process.env.AD_FLYER_FOLDER || 'zipp/advertisements',
    maxBytes: parseInt(process.env.AD_FLYER_MAX_BYTES || '5242880', 10), // 5 MB
    minDimension: parseInt(process.env.AD_FLYER_MIN_DIMENSION || '480', 10),
  },

  /**
   * Cómo se corta la semana de liquidación.
   *
   * La zona horaria no es cosmética: agrupar por semanas en UTC mueve
   * cinco horas la frontera, así que los pedidos del domingo por la noche
   * en Colombia caerían en la liquidación de la semana siguiente. Un
   * comercio que cuadra su caja el domingo vería un descuadre que no
   * existe.
   */
  settlement: {
    timezone: process.env.SETTLEMENT_TIMEZONE || 'America/Bogota',
    /** Día en que arranca el periodo semanal. */
    startOfWeek: process.env.SETTLEMENT_START_OF_WEEK || 'monday',
    /** Semanas de histórico que devuelve el extracto del comercio. */
    historyWeeks: parseInt(process.env.SETTLEMENT_HISTORY_WEEKS || '8', 10),
  },

  security: {
    encryptionKey,

    // Rate limiting.
    // Counters are per-process and shared by every test in a file, so the
    // production limits would turn unrelated assertions into 429s. The
    // middleware stays on the tested path; only the ceiling is lifted.
    rateLimit: {
      windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000', 10), // 15 min
      maxRequests: isTest
        ? Number.MAX_SAFE_INTEGER
        : parseInt(process.env.RATE_LIMIT_MAX || '100', 10),
      authMaxRequests: isTest
        ? Number.MAX_SAFE_INTEGER
        : parseInt(process.env.AUTH_RATE_LIMIT_MAX || '10', 10),
    },

    // Session
    session: {
      maxActiveSessions: parseInt(process.env.MAX_ACTIVE_SESSIONS || '5', 10),
      sessionTTLDays: parseInt(process.env.SESSION_TTL_DAYS || '7', 10),
    },

    // Brute force
    bruteForce: {
      maxAttemptsPerUser: parseInt(process.env.BF_MAX_USER_ATTEMPTS || '5', 10),
      maxAttemptsPerIP: parseInt(process.env.BF_MAX_IP_ATTEMPTS || '20', 10),
      lockDurationMinutes: parseInt(process.env.BF_LOCK_DURATION_MIN || '15', 10),
    },

    // 2FA
    twoFactor: {
      requiredForAdmins: process.env.TOTP_REQUIRED_ADMINS !== 'false',
      issuer: process.env.TOTP_ISSUER || 'ZIPP',
    },

    csrfSecret,
  },
};
