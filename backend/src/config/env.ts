import dotenv from 'dotenv';
import os from 'os';
import crypto from 'crypto';
dotenv.config();

// VITEST is set by the test runner in every worker before any application
// module loads. NODE_ENV alone is not reliable here: dotenv.config() above
// applies .env (which pins NODE_ENV=development) and whether that happens
// before or after the runner sets NODE_ENV depends on import order.
const isTest = process.env.NODE_ENV === 'test' || !!process.env.VITEST;
// El desarrollo es un opt-in explícito, no el valor por defecto.
//
// Antes, `NODE_ENV` vacío o ausente se leía como `'development'`: CORS
// aceptaba cualquier origen (`app.ts`), Socket.IO también, los secretos se
// generaban efímeros sin avisar en producción y los pagos sandbox pasaban
// sin aviso (`paymentConfigErrors` solo corre si `!isDev`). Un despliegue
// manual (`node dist/app.js` sin pasar por Docker/PM2/systemd, que sí fijan
// la variable) heredaba silenciosamente el modo más permisivo.
//
// Ahora hace falta escribir `NODE_ENV=development` a propósito. El flujo de
// desarrollo documentado (`.env.example`) ya lo hace explícito, así que esto
// no cambia nada para quien siguió esa plantilla.
const isDev = !isTest && process.env.NODE_ENV === 'development';

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

/**
 * `TOTP_REQUIRED_BUSINESS_FROM`: desde cuándo el 2FA de comercios bloquea.
 * Exige zona horaria explícita (`2026-10-05T06:00:00-05:00`): sin ella, la
 * fecha se leería en la hora del servidor (UTC) y el corte caería cinco
 * horas antes de lo que se creyó programar, en pleno servicio. Una fecha mal
 * escrita no arranca en producción: un corte que no se sabe cuándo ocurre es
 * peor que no tenerlo.
 */
function parseTotpCutoff(name: string): Date | null {
  const value = process.env[name]?.trim();
  if (!value) return null;
  const date = new Date(value);
  const hasZone = /(Z|[+-]\d{2}:\d{2})$/.test(value);
  if (!hasZone || Number.isNaN(date.getTime())) {
    const message = `${name} no es una fecha ISO con zona horaria (ej. 2026-10-05T06:00:00-05:00): "${value}".`;
    if (isDev || isTest) console.warn(`[SECURITY] ${message}`);
    else startupErrors.push(message);
    return null;
  }
  return date;
}

// Ports Expo/Metro actually bind to in local development. Shared between
// the CORS allowlist and the payment redirect allowlist below, so both stay
// in sync instead of drifting into two slightly different lists of "the
// dev ports we trust".
const EXPO_DEV_PORTS = ['8081', '8082', '19000', '19006'];

/**
 * El sitio público (`web/`). Constante aparte porque lo leen dos secciones
 * de la configuración: los enlaces para compartir y la dirección de regreso
 * de PSE.
 */
const WEB_URL = (process.env.WEB_URL || 'https://45-93-100-122.sslip.io').replace(/\/+$/, '');

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

/**
 * La clave del proveedor de recorte de fondo.
 *
 * Solo la lee el backend: el panel se entera de si el recorte existe por
 * `GET /products/image-capabilities`, que devuelve un booleano. Faltar no
 * impide arrancar —las fotos se guardan con su fondo, como antes— pero en
 * producción se avisa, igual que una clave de sandbox: esa funciona, y
 * precisamente por eso es peligrosa, porque le pone marca de agua a cada
 * foto del catálogo.
 *
 * En pruebas se ignora la del `.env`: una clave real ahí haría que la suite
 * gastara créditos de verdad.
 */
function resolvePhotoroomKey(): string {
  if (isTest) return '';
  const value = (process.env.PHOTOROOM_API_KEY || '').trim();
  if (!value) {
    if (!isDev) {
      console.warn(
        '[IMAGE_BG] PHOTOROOM_API_KEY no está definida. El recorte de fondo queda ' +
          'apagado y las fotos de producto se guardan con su fondo.'
      );
    }
    return '';
  }
  if (value.startsWith('sandbox_') && !isDev) {
    console.warn(
      '[IMAGE_BG] PHOTOROOM_API_KEY es una clave de sandbox: las fotos recortadas ' +
        'saldrán con marca de agua. Usa la clave de producción.'
    );
  }
  return value;
}

const photoroomApiKey = resolvePhotoroomKey();

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

/**
 * Lo que impide que un despliegue de producción "mande" OTP que nunca llegan.
 *
 * Los servicios de WhatsApp y correo tenían sus proveedores comentados y
 * siempre caían a un `console.log` con el código: en producción ningún
 * usuario recibía el OTP y todos quedaban en los logs, legibles por
 * cualquiera con acceso al servidor. Ahora el código nunca se imprime y
 * producción no arranca sin un proveedor real completo.
 *
 * El correo es un canal de login aparte: si no se va a ofrecer, se apaga
 * explícitamente con `EMAIL_OTP_ENABLED=false` en vez de dejarlo roto.
 *
 * Función pura sobre un mapa de variables, igual que `paymentConfigErrors`.
 */
export const WHATSAPP_PROVIDERS = ['meta_cloud_api', 'twilio_whatsapp'] as const;
export const EMAIL_PROVIDERS = ['sendgrid'] as const;
export const DEV_OTP_PROVIDER = 'dev_outbox';

export function otpDeliveryConfigErrors(env: Record<string, string | undefined>): string[] {
  const errors: string[] = [];
  const value = (name: string) => (env[name] || '').trim();

  const whatsapp = value('WHATSAPP_PROVIDER');
  if (!whatsapp) {
    errors.push(
      'WHATSAPP_PROVIDER es obligatoria en producción: sin proveedor los OTP de registro, login y ' +
        `recuperación nunca llegan. Usa ${WHATSAPP_PROVIDERS.join(' o ')}.`
    );
  } else if (whatsapp === DEV_OTP_PROVIDER) {
    errors.push(`WHATSAPP_PROVIDER=${DEV_OTP_PROVIDER} es solo para desarrollo y pruebas.`);
  } else if (whatsapp === 'meta_cloud_api') {
    for (const name of ['WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_OTP_TEMPLATE']) {
      if (!value(name)) errors.push(`${name} es obligatoria cuando WHATSAPP_PROVIDER=meta_cloud_api.`);
    }
  } else if (whatsapp === 'twilio_whatsapp') {
    for (const name of ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_WHATSAPP_FROM']) {
      if (!value(name)) errors.push(`${name} es obligatoria cuando WHATSAPP_PROVIDER=twilio_whatsapp.`);
    }
    if (value('TWILIO_ACCOUNT_SID') && !value('TWILIO_ACCOUNT_SID').startsWith('AC')) {
      errors.push('TWILIO_ACCOUNT_SID no tiene el formato de Twilio (debe empezar por "AC").');
    }
  } else {
    errors.push(`WHATSAPP_PROVIDER="${whatsapp}" no es un proveedor soportado (${WHATSAPP_PROVIDERS.join(', ')}).`);
  }

  if (value('EMAIL_OTP_ENABLED') !== 'false') {
    const email = value('EMAIL_PROVIDER');
    if (!email) {
      errors.push(
        'EMAIL_PROVIDER es obligatoria en producción mientras el login por correo esté activo. ' +
          'Configura sendgrid o apágalo con EMAIL_OTP_ENABLED=false.'
      );
    } else if (email === DEV_OTP_PROVIDER) {
      errors.push(`EMAIL_PROVIDER=${DEV_OTP_PROVIDER} es solo para desarrollo y pruebas.`);
    } else if (email === 'sendgrid') {
      for (const name of ['SENDGRID_API_KEY', 'EMAIL_FROM_ADDRESS']) {
        if (!value(name)) errors.push(`${name} es obligatoria cuando EMAIL_PROVIDER=sendgrid.`);
      }
    } else {
      errors.push(`EMAIL_PROVIDER="${email}" no es un proveedor soportado (${EMAIL_PROVIDERS.join(', ')}).`);
    }
  }

  return errors;
}

if (!isDev && !isTest) {
  startupErrors.push(...paymentConfigErrors(process.env));
  startupErrors.push(...otpDeliveryConfigErrors(process.env));
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
  // Igual que `isDev`: sin `NODE_ENV`, esto ya no dice 'development'. Varios
  // sitios comparan `config.nodeEnv === 'development'` directamente
  // (app.ts, sockets/index.ts) en vez de leer `isDev` — con el valor
  // literal de antes, esos sitios habrían seguido abriendo CORS/Socket.IO a
  // cualquier origen aunque `isDev` ya dijera que no.
  nodeEnv: process.env.NODE_ENV || (isTest ? 'test' : 'production'),
  isDev,
  isTest,
  localIP,

  mongodb: {
    uri: mongoUri,
  },

  // ── Caché de lecturas ─────────────────────────────────────────────
  // Con `REDIS_URL` vive en Redis y sobrevive a reinicios; sin ella, en la
  // memoria del proceso (desarrollo en Windows y tests). En ambos casos es
  // un atajo, nunca la fuente de verdad: si Redis no responde se lee de
  // Mongo como si la caché no existiera.
  cache: {
    redisUrl: isTest ? '' : (process.env.REDIS_URL || '').trim(),
    /** Separa las claves de entornos que compartan instancia de Redis. */
    keyPrefix: `zipp:${process.env.NODE_ENV || 'production'}:`,
    /** Techo de entradas del respaldo en memoria. */
    memoryMaxEntries: parseInt(process.env.CACHE_MEMORY_MAX_ENTRIES || '5000', 10),
    /** Apagado de emergencia: `CACHE_DISABLED=true` y todo va a Mongo. */
    disabled: process.env.CACHE_DISABLED === 'true',
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
    /**
     * Candidatos que trae el `$near` de Mongo antes de que Mapbox los
     * reordene por ETA real. En una zona con muchos domiciliarios
     * disponibles a la vez, es el techo real de a cuántos puede llegar a
     * ofrecerse un pedido — subirlo da margen sin mandarle la oferta a
     * cientos de personas.
     */
    candidatePool: parseInt(process.env.TRACKING_CANDIDATE_POOL || '40', 10),
  },

  // Client IDs de OAuth de Google (uno por plataforma, todos apuntan al
  // mismo proyecto de Google Cloud). verifyIdToken acepta cualquiera de
  // ellos como audiencia válida.
  google: {
    webClientId: process.env.GOOGLE_OAUTH_CLIENT_ID_WEB || '',
    iosClientId: process.env.GOOGLE_OAUTH_CLIENT_ID_IOS || '',
    androidClientId: process.env.GOOGLE_OAUTH_CLIENT_ID_ANDROID || '',
  },

  /**
   * "Sign in with Apple". El Services ID es el `client_id`/`aud` que debe
   * traer el `identityToken` para considerarse válido — se crea en
   * developer.apple.com (Certificates, Identifiers & Profiles → Identifiers
   * → Services IDs), no es el mismo ID que el de la app (`com.zipp.app`).
   *
   * No hace falta guardar la llave privada de Apple aquí: el flujo solo
   * verifica el `identityToken` que llega por `response_mode=form_post`
   * (ver `AuthService.loginWithApple`), nunca intercambia el `code` por un
   * token nuevo, así que no necesita firmar un `client_secret`.
   */
  apple: {
    servicesId: process.env.APPLE_SERVICES_ID || '',
  },

  /**
   * "Continuar con Facebook". Sin App ID y secreto el login responde 503 y la
   * app ni muestra el botón (ver mobile/lib/facebookAuth.ts).
   *
   * `redirectUri` tiene que ser **exactamente** el registrado en Meta ("URI
   * de redireccionamiento de OAuth válidos") y el que arma la app con su
   * `API_URL`: Meta rechaza el canje del código si no coinciden.
   */
  facebook: {
    appId: process.env.FACEBOOK_APP_ID || '',
    appSecret: process.env.FACEBOOK_APP_SECRET || '',
    graphVersion: process.env.FACEBOOK_GRAPH_VERSION || 'v21.0',
    redirectUri: process.env.FACEBOOK_REDIRECT_URI || `${WEB_URL}/api/v1/auth/facebook/callback`,
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
      /**
       * Tiempo máximo de cada llamada a la API de Wompi. Sin él, una petición
       * que Wompi no contesta dejaba colgados el cobro, la confirmación del
       * webhook y el barrido de cobros pendientes, que va de uno en uno.
       */
      httpTimeoutMs: parseInt(process.env.WOMPI_HTTP_TIMEOUT_MS || '15000', 10),
      /**
       * A dónde devuelve Wompi a quien paga con PSE o Bancolombia.
       *
       * La fija el servidor y no la app: https y en un dominio nuestro, que es
       * lo que la API de Transacciones espera. En el camino normal nunca se
       * carga —el WebView de la app la intercepta antes—; la página de
       * `web/pago/retorno` está para cuando el banco termina fuera de él.
       */
      returnUrl: process.env.WOMPI_RETURN_URL || `${WEB_URL}/pago/retorno`,
      /**
       * Pedir 3D Secure en los cobros con tarjeta nueva.
       *
       * Apagado por defecto a propósito: Wompi tiene que activarlo en la
       * cuenta del comercio, y encenderlo antes de que lo haga podría
       * rechazar todos los cobros con tarjeta. Se enciende con
       * `WOMPI_THREE_DS=true` cuando Wompi confirme la activación.
       */
      threeDs: process.env.WOMPI_THREE_DS === 'true',
      /**
       * Solo sandbox: qué resultado simula Wompi para el reto. En producción
       * Wompi ignora el campo y el provider ni lo envía.
       */
      threeDsSandboxType: process.env.WOMPI_THREE_DS_SANDBOX_TYPE || 'challenge_v2',
      /**
       * Solo sandbox: qué desenlace simula Wompi para el Botón Bancolombia.
       * Es la única forma de probar un rechazo de ese carril, porque la
       * pantalla del banco en sandbox no la decide quien prueba. En
       * producción Wompi lo ignora y el provider ni lo envía.
       */
      sandboxAsyncStatus: process.env.WOMPI_SANDBOX_ASYNC_STATUS || 'APPROVED',
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
    /** Segundos mínimos entre dos envíos al mismo destino (freno al bombeo de SMS/WhatsApp). */
    resendCooldownSeconds: parseInt(process.env.OTP_RESEND_COOLDOWN_SECONDS || '30', 10),

    // Sin proveedor, desarrollo y pruebas usan el buzón (`models/OtpOutbox.ts`);
    // producción no llega hasta aquí sin uno real (ver otpDeliveryConfigErrors).
    whatsapp: {
      provider: (process.env.WHATSAPP_PROVIDER || '').trim() || (isDev || isTest ? DEV_OTP_PROVIDER : ''),
      meta: {
        phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || '',
        accessToken: process.env.WHATSAPP_ACCESS_TOKEN || '',
        templateName: process.env.WHATSAPP_OTP_TEMPLATE || '',
        templateLanguage: process.env.WHATSAPP_OTP_TEMPLATE_LANG || 'es_CO',
        apiVersion: process.env.WHATSAPP_API_VERSION || 'v20.0',
        // Las plantillas de autenticación de Meta con botón "copiar código"
        // exigen repetir el código como parámetro del botón.
        templateHasCopyButton: process.env.WHATSAPP_OTP_TEMPLATE_COPY_BUTTON !== 'false',
      },
      twilio: {
        accountSid: process.env.TWILIO_ACCOUNT_SID || '',
        authToken: process.env.TWILIO_AUTH_TOKEN || '',
        from: process.env.TWILIO_WHATSAPP_FROM || '',
        contentSid: process.env.TWILIO_WHATSAPP_CONTENT_SID || '',
      },
    },
    email: {
      enabled: process.env.EMAIL_OTP_ENABLED !== 'false',
      provider: (process.env.EMAIL_PROVIDER || '').trim() || (isDev || isTest ? DEV_OTP_PROVIDER : ''),
      fromAddress: process.env.EMAIL_FROM_ADDRESS || '',
      sendgridApiKey: process.env.SENDGRID_API_KEY || '',
    },
    /** Tiempo máximo esperando al proveedor antes de dar el envío por fallido. */
    providerTimeoutMs: parseInt(process.env.OTP_PROVIDER_TIMEOUT_MS || '8000', 10),
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

  /**
   * Quién puede embeber la vista previa del constructor de Explorar
   * (`/preview/*` de la PWA) en un iframe. Solo el panel admin: el resto de
   * la PWA sigue con `X-Frame-Options: DENY`.
   */
  previewFrameAncestors: [
    (process.env.ADMIN_URL || 'http://localhost:3001').replace(/\/+$/, ''),
    ...(isDev ? ['http://localhost:3001', `http://${localIP}:3001`] : []),
  ],

  /**
   * El sitio público (`web/`), sin barra final.
   *
   * Solo lo usa `GET /negocio/:slug`: es a donde reenvía a un humano de
   * verdad después de que un rastreador (WhatsApp, Facebook…) ya leyó las
   * etiquetas `og:` de esa misma URL. El valor por defecto es el despliegue
   * actual, mismo criterio que `PROD_ORIGIN` en `mobile/constants/config.ts`.
   */
  webUrl: WEB_URL,

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

    /**
     * Geocerca del traspaso físico: "Llegué" y el código no bastan solos.
     *
     * Antes las coordenadas que mandaba el teléfono se guardaban para
     * auditoría y nunca se comparaban contra nada — un domiciliario podía
     * declarar la llegada y validar el código estando a cualquier
     * distancia real del comercio o del cliente. Estos radios son la
     * tolerancia bajo la cual SÍ se compara.
     *
     * 150 m cubre un centro comercial grande o una manzana con parqueo
     * propio sin ser tan ancho que dos negocios contiguos se confundan.
     * `maxAccuracyMeters` reutiliza el mismo criterio que ya existe para
     * filtrar los pings de seguimiento en vivo (`tracking.maxAccuracyMeters`
     * = 100 m): un fix peor que eso no se suma como tolerancia, se rechaza
     * pidiendo mejor señal, porque sumarlo volvería la geocerca inútil.
     */
    geofence: {
      pickupRadiusMeters: parseInt(process.env.ORDER_GEOFENCE_PICKUP_RADIUS_METERS || '150', 10),
      dropoffRadiusMeters: parseInt(process.env.ORDER_GEOFENCE_DROPOFF_RADIUS_METERS || '150', 10),
      maxAccuracyMeters: parseInt(process.env.ORDER_GEOFENCE_MAX_ACCURACY_METERS || '100', 10),
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
  },

  /**
   * Recorte de fondo de las fotos de producto.
   *
   * Cada foto recortada es un crédito pagado al proveedor, así que el tope
   * diario no es una cortesía: es lo que impide que un comercio que resube
   * en bucle —o una cuenta comprometida— queme el saldo de todos. Pasado el
   * tope la foto se guarda igual, con su fondo.
   *
   * El proveedor se elige por nombre para poder cambiarlo sin tocar la
   * lógica de productos (`services/imageProcessing/`).
   */
  backgroundRemoval: {
    provider: (process.env.BACKGROUND_REMOVAL_PROVIDER || 'photoroom').trim().toLowerCase(),
    dailyLimitPerBusiness: parseInt(
      process.env.BACKGROUND_REMOVAL_DAILY_LIMIT_PER_BUSINESS || '60',
      10
    ),
    photoroom: {
      apiKey: photoroomApiKey,
      apiUrl: process.env.PHOTOROOM_API_URL || 'https://sdk.photoroom.com/v1/segment',
      timeoutMs: parseInt(process.env.PHOTOROOM_TIMEOUT_MS || '30000', 10),
    },
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
      // Los paneles de admin/negocio abren varios dashboards a la vez desde
      // la misma IP y agotaban el límite de producción (antes 100) en
      // minutos, mostrando 429 como si no hubiera datos. Con millones de
      // usuarios reales, muchos comparten la misma IP pública (NAT de
      // oficina, edificio, operador móvil), así que el techo por IP tiene
      // que ser holgado: la protección fina contra abuso individual la da
      // `perUserMaxRequests`, que limita por cuenta y no penaliza a los
      // vecinos de red de alguien que se porta mal.
      maxRequests: isTest
        ? Number.MAX_SAFE_INTEGER
        : parseInt(process.env.RATE_LIMIT_MAX || (isDev ? '2000' : '10000'), 10),
      // Límite por usuario autenticado, complementario al de IP (ver
      // `perUserRateLimiter` en middlewares/security.ts). Cubre a un mismo
      // usuario golpeando la API desde varios dispositivos/pestañas a la
      // vez sin depender de qué IP use.
      perUserMaxRequests: isTest
        ? Number.MAX_SAFE_INTEGER
        : parseInt(process.env.RATE_LIMIT_PER_USER_MAX || '1000', 10),
      authMaxRequests: isTest
        ? Number.MAX_SAFE_INTEGER
        : parseInt(process.env.AUTH_RATE_LIMIT_MAX || '10', 10),
      // Flujo de entrega (evidencia, código de recogida, llamadas, efectivo):
      // un domiciliario los usa en cada entrega, y hasta ahora estaban
      // hardcodeados en 20-30/15min por IP. En una zona con muchos
      // repartidores compartiendo la misma IP de operador móvil (CGNAT), esa
      // cuenta se agota entre varios domiciliarios reales — el mismo
      // síntoma que motivó subir el límite de documentos de 100 a 2000.
      orderEvidenceMaxRequests: isTest
        ? Number.MAX_SAFE_INTEGER
        : parseInt(process.env.ORDER_EVIDENCE_RATE_LIMIT_MAX || '300', 10),
      orderCodeMaxRequests: isTest
        ? Number.MAX_SAFE_INTEGER
        : parseInt(process.env.ORDER_CODE_RATE_LIMIT_MAX || '300', 10),
      cashConfirmMaxRequests: isTest
        ? Number.MAX_SAFE_INTEGER
        : parseInt(process.env.CASH_CONFIRM_RATE_LIMIT_MAX || '300', 10),
      orderCallMaxRequests: isTest
        ? Number.MAX_SAFE_INTEGER
        : parseInt(process.env.ORDER_CALL_RATE_LIMIT_MAX || '150', 10),
      // Subidas de foto de producto y reintentos del recorte, por usuario.
      // Una carta nueva de 40 productos cabe holgada en dos ventanas; lo que
      // frena es el bucle, que con el recorte encendido cuesta créditos.
      productImageUploadMaxRequests: isTest
        ? Number.MAX_SAFE_INTEGER
        : parseInt(process.env.PRODUCT_IMAGE_UPLOAD_RATE_LIMIT_MAX || '30', 10),
    },

    // Session
    session: {
      maxActiveSessions: parseInt(process.env.MAX_ACTIVE_SESSIONS || '5', 10),
      /** Caducidad deslizante: días sin refrescar antes de cerrar la sesión. */
      sessionTTLDays: parseInt(process.env.SESSION_TTL_DAYS || '7', 10),
      /** Caducidad absoluta desde el inicio de sesión, por mucho que se refresque. */
      absoluteTTLDays: parseInt(process.env.SESSION_ABSOLUTE_TTL_DAYS || '30', 10),
    },

    // Brute force
    bruteForce: {
      maxAttemptsPerUser: parseInt(process.env.BF_MAX_USER_ATTEMPTS || '5', 10),
      maxAttemptsPerIP: parseInt(process.env.BF_MAX_IP_ATTEMPTS || '20', 10),
      lockDurationMinutes: parseInt(process.env.BF_LOCK_DURATION_MIN || '15', 10),
    },

    // 2FA
    twoFactor: {
      // Apagado por defecto bajo pruebas, igual que los limitadores de tasa
      // de arriba: cada archivo de prueba crea administradores con
      // `makeUser({ role: UserRole.ADMIN })` sin pasar por el alta de 2FA, y
      // exigirlo convertiría casi toda la suite en 403. La aplicación real
      // del guardia sí se prueba — ver
      // `src/__tests__/adminTwoFactorEnforcement.test.ts` — activando el
      // flag explícitamente dentro de ese archivo.
      requiredForAdmins: !isTest && process.env.TOTP_REQUIRED_ADMINS !== 'false',
      // Mismo guardia para las cuentas de comercio, pero al revés: apagado
      // salvo que se encienda a propósito. Encenderlo frena a cada comercio
      // en su siguiente petición hasta escanear el QR, así que se activa
      // después de avisarles, no con el despliegue.
      requiredForBusiness: !isTest && process.env.TOTP_REQUIRED_BUSINESS === 'true',
      // Opcional: con el flag encendido, el bloqueo empieza aquí y no al
      // reiniciar (para no cortar a los comercios en medio del servicio).
      requiredForBusinessFrom: parseTotpCutoff('TOTP_REQUIRED_BUSINESS_FROM') as Date | null,
      issuer: process.env.TOTP_ISSUER || 'ZIPP',
    },

    csrfSecret,
  },
};
