const IPV4 = /^[0-9]{1,3}(\.[0-9]{1,3}){3}(\/([0-9]|[12][0-9]|3[0-2]))?$/;
const IPV6 = /^[0-9a-fA-F:]+(\/([0-9]{1,2}|1[01][0-9]|12[0-8]))?$/;
const MAX_PROXY_HOPS = 10;

/**
 * `TRUST_PROXY`: qué proxies pueden decir cuál es la IP del cliente (cabecera `X-Forwarded-For`). `true` confía en todas las
 * cabeceras y cualquiera puede falsificar su IP (y saltarse los límites por IP): solo se admite fuera de producción. En producción,
 * un número (saltos de proxy de confianza delante de la aplicación) o una lista de direcciones o rangos CIDR de esos proxies.
 */
export function parseTrustProxy(raw) {
  const value = String(raw ?? '').trim();
  if (!value || value === 'false' || value === '0') return false;
  if (value === 'true') return true;
  if (/^-?[0-9]+$/.test(value)) {
    const hops = Number(value);
    if (hops < 0 || hops > MAX_PROXY_HOPS) throw new Error(`TRUST_PROXY: los saltos de proxy van de 1 a ${MAX_PROXY_HOPS}`);
    return hops;
  }
  const list = value.split(',').map((x) => x.trim()).filter(Boolean);
  for (const entry of list) {
    const octets = entry.split('/')[0].split('.');
    const valid = IPV4.test(entry) ? octets.every((o) => Number(o) <= 255) : entry.includes(':') && IPV6.test(entry);
    if (!valid) throw new Error(`TRUST_PROXY: «${entry}» no es un número de saltos ni una dirección o rango CIDR`);
  }
  return list;
}

/**
 * Configuración desde variables de entorno. En producción todo lo sensible debe venir de aquí,
 * nunca del código, y lo imprescindible se exige al arrancar: es mejor no iniciar que iniciar mal.
 */
export function loadConfig(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const origins = (env.ALLOWED_ORIGINS ?? '').split(',').map((o) => o.trim()).filter(Boolean);

  if (production) {
    const missing = [
      ['ALLOWED_ORIGINS', origins.length],
      ['MONGODB_URI', env.MONGODB_URI],
      ['APP_BASE_URL', env.APP_BASE_URL],
      ['MFA_ENCRYPTION_KEY', env.MFA_ENCRYPTION_KEY],
      ['SMTP_URL', env.SMTP_URL],
      ['MAIL_FROM', env.MAIL_FROM],
    ]
      .filter(([, value]) => !value)
      .map(([name]) => name);
    if (missing.length) throw new Error(`faltan variables de entorno obligatorias en producción: ${missing.join(', ')}`);
  }

  const trustProxy = parseTrustProxy(env.TRUST_PROXY);
  if (production && trustProxy === true) {
    throw new Error('TRUST_PROXY=true no se permite en producción: usa el número de saltos de proxy (p. ej. 1) o la lista de direcciones o rangos CIDR de tu balanceador');
  }

  // El simulador no tiene validez ante ninguna autoridad: en producción no puede usarse. Sin proveedor real configurado,
  // la facturación queda deshabilitada (la aplicación arranca igual y la interfaz lo explica).
  const invoicingProvider = env.INVOICING_PROVIDER ?? (production ? null : 'sandbox');
  if (production && invoicingProvider === 'sandbox') {
    throw new Error('INVOICING_PROVIDER=sandbox no se permite en producción: sus documentos no tienen validez ante la autoridad tributaria');
  }

  return {
    production,
    invoicingProvider,
    port: Number(env.PORT ?? 3000),
    mongoUri: env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017/lulubiz',
    dbName: env.MONGODB_DB ?? 'lulubiz',
    allowedOrigins: origins.length ? origins : ['http://localhost:3100'],
    appBaseUrl: env.APP_BASE_URL ?? 'http://localhost:3100',
    // Clave AES-256 en base64 (32 bytes) para cifrar secretos de verificación en dos pasos.
    mfaEncryptionKey: env.MFA_ENCRYPTION_KEY ?? null,
    smtpUrl: env.SMTP_URL ?? null,
    mailFrom: env.MAIL_FROM ?? null,
    errorWebhookUrl: env.ERROR_WEBHOOK_URL ?? null,
    // Sin token configurado, /metrics queda deshabilitado (404).
    metricsToken: env.METRICS_TOKEN ?? null,
    // Solo en desarrollo: crea los índices al arrancar. En producción los crea `npm run db:setup`.
    ensureIndexesOnStart: !production && env.ENSURE_INDEXES !== 'false',
    cookieName: 'lulubiz_session',
    cookieSecure: production,
    trustProxy,
    rateLimit: {
      global: { max: 300, timeWindow: '1 minute' },
      login: { max: 10, timeWindow: '1 minute' },
      register: { max: 5, timeWindow: '1 hour' },
      passwordReset: { max: 5, timeWindow: '1 hour' },
      mfa: { max: 10, timeWindow: '1 minute' },
      token: { max: 20, timeWindow: '1 hour' },
    },
  };
}
