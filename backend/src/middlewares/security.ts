import { Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { logAudit, AuditAction, AuditSeverity } from '../security';
import { config } from '../config';
import { verifyAccessToken } from '../utils/token';

// These are the limiters actually mounted on the auth routes. They used to
// hardcode their ceilings, which meant AUTH_RATE_LIMIT_MAX and friends
// silently did nothing. They now read the same configuration as everything
// else, and lift the ceiling under test — where counters are process-wide
// and shared by every case in a file.
const limitFor = (configured: number) =>
  config.isTest ? Number.MAX_SAFE_INTEGER : configured;

/**
 * Strict rate limiter for authentication endpoints.
 * Defaults to 10 requests per 15 minutes per IP (AUTH_RATE_LIMIT_MAX).
 */
export const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: limitFor(config.security.rateLimit.authMaxRequests),
  message: {
    success: false,
    message: 'Demasiados intentos de autenticación. Intenta en 15 minutos.',
  },
  standardHeaders: true,
  legacyHeaders: false,
  // Sin `keyGenerator` propio: el de express-rate-limit usa `req.ip`, que
  // con `trust proxy` es la IP que vio nginx. El que había aquí leía el
  // primer valor de `X-Forwarded-For`, que escribe el cliente.
});

/**
 * OTP rate limiter - 3 requests per 5 minutes
 */
export const otpRateLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: limitFor(3),
  message: {
    success: false,
    message: 'Demasiadas solicitudes de OTP. Intenta en 5 minutos.',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Refresh de tokens — 60 por 15 minutos por IP.
 *
 * Antes solo lo frenaba el límite global. Un cliente sano refresca una vez
 * cada 15 minutos por dispositivo; 60 deja sitio a una casa entera detrás de
 * la misma IP y frena a quien prueba refresh tokens robados a ráfagas.
 */
export const refreshRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: limitFor(60),
  message: {
    success: false,
    message: 'Demasiadas renovaciones de sesión. Intenta en unos minutos.',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Sensitive operations rate limiter - 5 per hour
 */
export const sensitiveRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: limitFor(5),
  message: {
    success: false,
    message: 'Demasiadas operaciones sensibles. Intenta más tarde.',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// ── Payments ─────────────────────────────────────────────────────────
// The payment routes used to sit behind nothing but the global 100/15min
// limiter, sharing one bucket with every other API call. Each of the three
// has a different shape of legitimate traffic, so each gets its own.

/**
 * Starting a charge — 10 per 15 minutes per IP.
 *
 * A customer needs a handful of attempts (a declined card, a retry with
 * another method), never dozens. Each call mints a reference and signs a
 * fresh checkout link, so it is the expensive one to leave open.
 */
export const paymentInitiateRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: limitFor(10),
  message: {
    success: false,
    message: 'Demasiados intentos de pago. Espera unos minutos antes de reintentar.',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Polling a payment's status — 150 per 5 minutes per IP.
 *
 * Deliberately generous: the app polls every 3 s while a payment is pending
 * (see usePaymentStatus), which is 100 calls in five minutes for a single
 * honest customer waiting on a PSE confirmation. The ceiling exists because
 * each call can trigger an outbound request to the gateway's API, so an
 * unbounded poll is a way to spend someone else's rate budget.
 */
export const paymentStatusRateLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: limitFor(150),
  message: {
    success: false,
    message: 'Demasiadas consultas de estado. Espera un momento.',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * The gateway callback — 300 per minute per IP.
 *
 * High on purpose. This endpoint is unauthenticated by necessity and the
 * gateway retries hard after any failure, so a tight limit here would drop
 * exactly the deliveries that matter most. It is a ceiling against a flood
 * of forged payloads, not a throttle on Wompi: every real event still has
 * to pass signature verification before anything is read.
 */
export const paymentWebhookRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: limitFor(300),
  message: { success: false, message: 'Demasiadas notificaciones.' },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Confirmación de efectivo — 300 por 15 minutos por IP (CASH_CONFIRM_RATE_LIMIT_MAX).
 *
 * Es una acción rara y cara: un domiciliario la ejecuta una vez por
 * pedido entregado, y un turno intenso no pasa de una decena. El techo por
 * IP es holgado porque cuenta a TODOS los domiciliarios de esa IP
 * compartida, no solo a uno — deja sitio de sobra para eso y para los
 * reintentos de una red mala, y sigue sin dejar pasar a alguien recorriendo
 * pedidos ajenos a ver cuál cuela, que de todos modos chocaría antes con la
 * comprobación de pertenencia.
 */
export const cashConfirmRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: limitFor(config.security.rateLimit.cashConfirmMaxRequests),
  message: {
    success: false,
    message: 'Demasiadas confirmaciones de efectivo. Espera un momento.',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// ── Flujo de entrega ─────────────────────────────────────────────────
// Estos limitadores son la red por IP. El control fino vive donde debe:
// los intentos de código se cuentan por pedido en la base de datos, y los
// mensajes por usuario y pedido en el servicio de chat. Un limitador por
// IP no puede sustituirlos —media ciudad sale por la misma NAT móvil—
// pero sí frena a quien golpea la API desde una sola máquina.

/**
 * Validación de códigos — 300 por 15 minutos por IP (ORDER_CODE_RATE_LIMIT_MAX).
 *
 * Generoso a propósito: un domiciliario se equivoca tecleando y el
 * castigo de verdad (bloqueo temporal del código) ya lo aplica el
 * servicio tras unos pocos fallos sobre ese pedido concreto. El techo por
 * IP subió de 30 a 300 porque muchos domiciliarios reales pueden compartir
 * la misma IP de operador móvil (CGNAT) en una zona concurrida, y 30 se
 * agotaba entre varios sin que ninguno estuviera abusando.
 */
export const orderCodeRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: limitFor(config.security.rateLimit.orderCodeMaxRequests),
  message: {
    success: false,
    message: 'Demasiados intentos de validación. Espera unos minutos.',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

/** Mensajes del chat — 90 por minuto por IP. */
export const orderChatRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: limitFor(90),
  message: { success: false, message: 'Estás enviando mensajes demasiado rápido.' },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Subida de evidencias — 300 por 15 minutos por IP (ORDER_EVIDENCE_RATE_LIMIT_MAX).
 *
 * Cada subida cuesta una imagen en Cloudinary, así que el techo protege
 * también la factura, no solo el servidor. Subido de 30 a 300 por la misma
 * razón que el de códigos: por IP compartida entre varios domiciliarios.
 */
export const orderEvidenceRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: limitFor(config.security.rateLimit.orderEvidenceMaxRequests),
  message: { success: false, message: 'Demasiadas subidas. Espera unos minutos.' },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Crear/actualizar calificaciones — 20 por 15 minutos por IP.
 *
 * Cubre las cinco vías de calificación (cliente↔comercio, cliente↔domicilia-
 * rio, comercio↔domiciliario): cada pedido solo admite una calificación por
 * relación, así que 20 en 15 minutos ya es más que cualquier repartidor
 * activo puede generar entregando de verdad — sirve para frenar un script,
 * no a alguien calificando pedidos reales.
 */
export const reviewCreateRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: limitFor(20),
  message: { success: false, message: 'Demasiadas calificaciones seguidas. Espera unos minutos.' },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Geocodificación inversa — 60 por 5 minutos por IP.
 *
 * Mapbox cobra por petición de geocodificación, así que el techo protege
 * la factura igual que el de las evidencias. El caché del servicio absorbe
 * al usuario normal —que rara vez pasa de una docena de puntos mientras
 * ajusta el pin— y este límite frena a quien quiera barrer coordenadas
 * para construirse un callejero a costa de la cuota de Zipp.
 */
export const geocodeRateLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: limitFor(60),
  message: { success: false, message: 'Demasiadas consultas de ubicación. Espera un momento.' },
  standardHeaders: true,
  legacyHeaders: false,
});

/** Apertura de llamadas — 150 por 15 minutos por IP (ORDER_CALL_RATE_LIMIT_MAX). Subido de 20 por IP compartida entre domiciliarios. */
export const orderCallRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: limitFor(config.security.rateLimit.orderCallMaxRequests),
  message: { success: false, message: 'Demasiadas llamadas. Espera unos minutos.' },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Límite por usuario autenticado, complementario al límite global por IP.
 *
 * El límite por IP (`globalLimiter` en app.ts) tiene que ser holgado porque
 * miles de usuarios reales pueden compartir una misma IP pública (NAT de
 * oficina, edificio, operador móvil): apretarlo ahí castiga a los vecinos
 * de red de quien abusa. Este limitador cuenta por cuenta (`sub` del JWT),
 * así que sí aísla a un usuario individual golpeando la API sin tocar a
 * nadie más. Se salta por completo si la petición no trae un Bearer token
 * — esas ya quedan cubiertas por el límite de IP y por los limitadores
 * específicos de cada endpoint público (login, OTP, etc.).
 */
export const perUserRateLimiter = rateLimit({
  windowMs: config.security.rateLimit.windowMs,
  max: limitFor(config.security.rateLimit.perUserMaxRequests),
  message: {
    success: false,
    message: 'Demasiadas peticiones desde tu cuenta. Intenta más tarde.',
  },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => !req.headers.authorization?.startsWith('Bearer '),
  keyGenerator: (req) => {
    const token = req.headers.authorization!.split(' ')[1];
    try {
      return `user:${verifyAccessToken(token).id}`;
    } catch {
      // Token inválido/expirado: `authenticate` lo va a rechazar con 401
      // más adelante en la cadena; aquí basta con no reventar el limitador.
      return `anon:${req.ip}`;
    }
  },
});

/**
 * Security headers middleware (supplements helmet)
 */
export const securityHeaders = (_req: Request, res: Response, next: NextFunction) => {
  // Prevent MIME type sniffing
  res.setHeader('X-Content-Type-Options', 'nosniff');

  // Prevent clickjacking
  res.setHeader('X-Frame-Options', 'DENY');

  // XSS Protection
  res.setHeader('X-XSS-Protection', '1; mode=block');

  // Referrer Policy
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  // Permissions Policy
  res.setHeader(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(self), payment=(self)'
  );

  // Strict Transport Security (HSTS) - in production only
  if (process.env.NODE_ENV === 'production') {
    res.setHeader(
      'Strict-Transport-Security',
      'max-age=31536000; includeSubDomains; preload'
    );
  }

  next();
};

/**
 * Request sanitization middleware
 * Strips dangerous characters from inputs to prevent NoSQL injection
 */
export const sanitizeRequest = (req: Request, _res: Response, next: NextFunction) => {
  const sanitize = (obj: any): any => {
    if (typeof obj === 'string') {
      // Remove $ and . at the start of keys (NoSQL injection prevention)
      return obj;
    }
    if (Array.isArray(obj)) {
      return obj.map(sanitize);
    }
    if (obj && typeof obj === 'object') {
      const sanitized: any = {};
      for (const [key, value] of Object.entries(obj)) {
        // Block keys that start with $ (MongoDB operators)
        if (key.startsWith('$')) continue;
        // Block keys containing dots (nested property access)
        if (key.includes('.') && key !== '...') continue;
        sanitized[key] = sanitize(value);
      }
      return sanitized;
    }
    return obj;
  };

  if (req.body) req.body = sanitize(req.body);
  if (req.query) req.query = sanitize(req.query);
  if (req.params) req.params = sanitize(req.params);

  next();
};

/**
 * Audit trail middleware - logs all mutating requests
 */
export const auditMiddleware = async (req: Request, _res: Response, next: NextFunction) => {
  // Only audit mutating operations
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    const user = (req as any).user;
    if (user) {
      // Don't await - fire and forget to not slow down requests
      logAudit(req, {
        action: AuditAction.SETTINGS_CHANGED,
        entity: req.baseUrl + req.path,
        severity: AuditSeverity.LOW,
        description: `${req.method} ${req.originalUrl}`,
        metadata: {
          method: req.method,
          contentLength: req.headers['content-length'],
        },
      }).catch(() => {});
    }
  }
  next();
};

/**
 * Request ID middleware - adds unique ID to each request for tracing
 */
export const requestId = (req: Request, res: Response, next: NextFunction) => {
  const id = req.headers['x-request-id'] as string ||
    `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  (req as any).requestId = id;
  res.setHeader('X-Request-ID', id);
  next();
};
