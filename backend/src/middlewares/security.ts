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

/**
 * Reporte de crashes — 30 por hora, propio y no el de `sensitiveRateLimiter`.
 *
 * Compartir el cupo con cambiar contraseña, apagar el 2FA o cerrar todas las
 * sesiones significaba que un teléfono —o un PC con Zipp Negocios— que
 * entrara en bucle de crash podía agotarle a la misma persona, en la misma
 * hora, el cupo para esas operaciones de verdad sensibles. 30 alcanza para
 * reportar sin convertirse en el canal por el que alguien agota el cupo de
 * otra cosa a propósito.
 */
export const crashReportRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: limitFor(30),
  message: {
    success: false,
    message: 'Demasiados reportes. Intenta más tarde.',
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
 * Código de un solo uso de DaviPlata — 10 por 15 minutos, por cuenta.
 *
 * Nada que ver con el limitador de consultas: aquí cada llamada le pide a la
 * pasarela que mande un SMS o comprueba un código de seis dígitos. Wompi ya
 * corta a dos intentos por sesión, pero nada le impide a alguien abrir
 * sesiones nuevas; esto es lo que hace que barrer el espacio de códigos
 * cueste tiempo en vez de nada.
 *
 * Por cuenta y no por IP: en datos móviles cientos de personas salen por la
 * misma IP del operador, y un límite por IP de 10 dejaría a desconocidos
 * sin poder pagar por culpa de otros. Va detrás de `authenticate`, así que
 * `req.user` siempre existe; la IP queda solo como red de seguridad.
 */
export const paymentOtpRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: limitFor(10),
  message: {
    success: false,
    message: 'Demasiados intentos con el código. Espera unos minutos.',
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const userId = (req as { user?: { _id?: { toString(): string } } }).user?._id?.toString();
    return userId ? `otp:${userId}` : `otp-anon:${req.ip}`;
  },
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
/** Abrir casos de soporte: 5 por hora por IP. Un reclamo nace con prioridad alta; sin tope, una cuenta hunde la cola real. */
export const pqrsCreateRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: limitFor(5),
  message: { success: false, message: 'Has abierto muchos casos seguidos. Espera un rato antes de abrir otro.' },
  standardHeaders: true,
  legacyHeaders: false,
});

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
 * Subidas de foto de producto y reintentos del recorte de fondo.
 *
 * Por cuenta y no por IP: va detrás de `authenticate`, y un comercio en la
 * red de un centro comercial no debería agotarle el cupo al de al lado.
 * Con el recorte encendido cada subida puede costar un crédito, así que lo
 * que frena aquí es el bucle —un script, una cuenta comprometida—; el
 * gasto diario lo acota además el tope por comercio del orquestador.
 */
export const productImageUploadRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: limitFor(config.security.rateLimit.productImageUploadMaxRequests),
  message: {
    success: false,
    message: 'Demasiadas fotos seguidas. Espera unos minutos antes de subir otra.',
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.user ? `user:${req.user._id}` : `anon:${req.ip}`),
});

/**
 * Subida de documentos del comercio (cédula, RUT, certificado bancario).
 *
 * Por cuenta y no por IP, igual que las fotos de producto: va detrás de
 * `authenticate`. Cada subida es un archivo sensible que queda en el
 * almacén privado, así que lo que frena es el bucle (un script, una cuenta
 * comprometida llenando el almacén), no el uso normal: un comercio sube
 * cinco o seis papeles en toda su vida.
 */
export const businessDocumentUploadRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: limitFor(30),
  message: {
    success: false,
    message: 'Demasiados documentos seguidos. Espera un rato antes de subir otro.',
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.user ? `user:${req.user._id}` : `anon:${req.ip}`),
});

/**
 * Ver, bajar o exportar los papeles de un domiciliario (cédula, antecedentes,
 * licencia). Por cuenta admin: una sesión comprometida que recorre todos los
 * expedientes es la fuga que hay que hacer lenta y ruidosa. El PDF completo
 * cuesta bajar todos los anexos, así que también protege al servidor.
 */
export const driverDossierPdfRateLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: limitFor(5),
  message: { success: false, message: 'Ya generaste varios expedientes seguidos. Espera unos minutos.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.user ? `user:${req.user._id}` : `anon:${req.ip}`),
});

export const driverDossierFileRateLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: limitFor(120),
  message: {
    success: false,
    message: 'Demasiadas consultas de documentos seguidas. Espera unos minutos.',
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.user ? `user:${req.user._id}` : `anon:${req.ip}`),
});

/**
 * Cambios de datos fiscales y de la cuenta de pago del comercio, y lecturas
 * del número de cuenta completo.
 *
 * Es la ruta que más le interesa a quien quiere desviar dinero: un tope bajo
 * por cuenta hace inviable probar cuentas en bucle, y ningún uso legítimo se
 * acerca a 20 cambios por hora.
 */
export const businessFiscalRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: limitFor(20),
  message: {
    success: false,
    message: 'Demasiados cambios seguidos en los datos fiscales o bancarios. Intenta más tarde.',
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.user ? `user:${req.user._id}` : `anon:${req.ip}`),
});

/**
 * Lectura del número de cuenta completo (comercio o liquidación).
 *
 * Aparte del limitador fiscal general (20/h compartido con verificar y
 * cambiar la cuenta): revelar es lo que más le sirve a quien tiene una sesión
 * de finanzas robada, y ningún uso legítimo se acerca a 10 lecturas por hora
 * (una por transferencia). Al alcanzar el tope queda una alerta HIGH en la
 * auditoría, porque es una señal, no solo un 429.
 */
export const payoutAccountRevealRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: limitFor(10),
  message: {
    success: false,
    message: 'Demasiadas consultas del número de cuenta. Intenta más tarde.',
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.user ? `user:${req.user._id}` : `anon:${req.ip}`),
  handler: (req, res, _next, options) => {
    void logAudit(req, {
      action: AuditAction.SUSPICIOUS_ACTIVITY,
      entity: 'finance',
      severity: AuditSeverity.HIGH,
      description: 'Tope de consultas del número de cuenta de pago alcanzado',
      metadata: { limit: options.limit },
    });
    res.status(options.statusCode).json(options.message);
  },
});

/**
 * Restablecer el 2FA de otra cuenta (`POST /admin/users/:id/reset-2fa`).
 *
 * Por actor y detrás del permiso, no por IP: el limitador sensible general
 * cuenta por IP y lo comparte todo el que esté en el mismo Wi-Fi, así que un
 * día de onboarding en la oficina dejaba sin cupo al Super Administrador, y
 * cualquier admin sin el permiso se lo gastaba con respuestas 403. Llegar al
 * tope es una señal (resets en serie), y queda en la auditoría.
 */
export const twoFactorResetRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: limitFor(10),
  message: {
    success: false,
    message: 'Demasiados restablecimientos de verificación en dos pasos. Intenta más tarde.',
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.user ? `user:${req.user._id}` : `anon:${req.ip}`),
  handler: (req, res, _next, options) => {
    void logAudit(req, {
      action: AuditAction.SUSPICIOUS_ACTIVITY,
      entity: 'user',
      severity: AuditSeverity.HIGH,
      description: 'Tope de restablecimientos de 2FA alcanzado',
      metadata: { limit: options.limit },
    });
    res.status(options.statusCode).json(options.message);
  },
});

/**
 * Generar el QR del 2FA (`POST /auth/2fa/setup`). Por usuario: recargar la
 * pantalla de activación cinco veces ya no deja al comercio una hora fuera
 * del panel por compartir contador con toda su IP. Como la activación pide
 * la contraseña en cuentas de panel, este tope también frena adivinarla.
 */
export const twoFactorSetupRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: limitFor(10),
  message: {
    success: false,
    message: 'Demasiados intentos de activar la verificación en dos pasos. Intenta más tarde.',
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.user ? `user:${req.user._id}` : `anon:${req.ip}`),
});

/**
 * Acciones del centro de seguridad de comercios (cerrar sesiones, exportar
 * el historial) — 30 por hora por admin. Por cuenta y no por IP, igual que
 * el reset de 2FA: la oficina comparte IP. Cerrar sesiones en serie es
 * justo lo que haría una cuenta admin robada, así que el tope queda en la
 * auditoría.
 */
export const securityCenterActionRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: limitFor(30),
  message: {
    success: false,
    message: 'Demasiadas acciones de seguridad seguidas. Espera un momento antes de continuar.',
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.user ? `user:${req.user._id}` : `anon:${req.ip}`),
  handler: (req, res, _next, options) => {
    void logAudit(req, {
      action: AuditAction.SUSPICIOUS_ACTIVITY,
      entity: 'business',
      severity: AuditSeverity.HIGH,
      description: 'Tope de acciones del centro de seguridad de comercios alcanzado',
      metadata: { limit: options.limit },
    });
    res.status(options.statusCode).json(options.message);
  },
});

/**
 * Deja que el panel admin —y solo él— embeba la vista previa de Explorar.
 *
 * El resto de la PWA sigue sin poder ir dentro de un iframe (clickjacking):
 * esto se monta únicamente sobre `/preview`. Se quita `X-Frame-Options`
 * porque no admite una lista de orígenes, y se reescribe `frame-ancestors`
 * de la CSP que ya puso helmet con los orígenes del panel.
 */
export function allowAdminFraming(req: Request, res: Response, next: NextFunction) {
  res.removeHeader('X-Frame-Options');
  const csp = String(res.getHeader('Content-Security-Policy') ?? '');
  const directives = csp
    .split(';')
    .map((d) => d.trim())
    .filter((d) => d && !d.startsWith('frame-ancestors'));
  directives.push(`frame-ancestors ${config.previewFrameAncestors.join(' ')}`);
  res.setHeader('Content-Security-Policy', directives.join('; '));
  next();
}

/**
 * Vista previa del constructor de Explorar — 60 por minuto por cuenta.
 *
 * Cada una resuelve el layout entero contra el catálogo y no pasa por la
 * caché. El panel la pide con retardo mientras se edita (una cada ~600 ms
 * como mucho); esto frena el bucle, no el uso normal.
 */
export const exploreLayoutPreviewRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: limitFor(60),
  message: {
    success: false,
    message: 'Demasiadas vistas previas seguidas. Espera unos segundos.',
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.user ? `user:${req.user._id}` : `anon:${req.ip}`),
});

/**
 * Búsqueda global del panel admin — 60 por minuto por cuenta.
 *
 * El panel busca con espera de 300 ms al teclear; un uso normal no se acerca.
 * Lo que frena es enumerar la base (teléfonos, correos) con un script o una
 * sesión robada. Al alcanzar el tope queda una alerta HIGH en la auditoría,
 * porque es una señal, no solo un 429.
 */
// Limitación conocida: el contador es del store en memoria por defecto de express-rate-limit (se reinicia con PM2 y no se comparte); ningún otro limitador del repo usa store compartido.
export const createAdminSearchRateLimiter = (max: number = limitFor(60)) =>
  rateLimit({
    windowMs: 60 * 1000,
    max,
    message: {
      success: false,
      message: 'Demasiadas búsquedas seguidas. Espera un minuto antes de volver a buscar.',
    },
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => (req.user ? `user:${req.user._id}` : `anon:${req.ip}`),
    handler: (req, res, _next, options) => {
      void logAudit(req, {
        action: AuditAction.SUSPICIOUS_ACTIVITY,
        entity: 'admin_search',
        severity: AuditSeverity.HIGH,
        description: 'Tope de búsquedas del panel admin alcanzado',
        metadata: { limit: options.limit },
        // `originalUrl` traería `?q=` con el teléfono o correo buscado.
        pathOverride: '/api/v1/admin/search',
      });
      res.status(options.statusCode).json(options.message);
    },
  });

export const adminSearchRateLimiter = createAdminSearchRateLimiter();

/**
 * Reenviar aviso de un pedido desde el panel admin — 3 por pedido cada 10 min.
 *
 * La clave es SOLO el pedido: con clave usuario+pedido, tres admins podían
 * mandar nueve avisos al mismo cliente. Solo hay plantillas fijas, así que
 * esto frena el spam de push, no el phishing. Ha de montarse en una ruta con
 * `:id` (o `:orderId`) para que `req.params` ya exista.
 */
export const createOrderNotifyRateLimiter = (max: number = limitFor(3)) =>
  rateLimit({
    windowMs: 10 * 60 * 1000,
    max,
    message: {
      success: false,
      message: 'Ya se reenviaron varios avisos de este pedido. Espera unos minutos.',
    },
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => `order:${req.params?.id ?? req.params?.orderId ?? `anon:${req.ip}`}`,
  });

export const orderNotifyRateLimiter = createOrderNotifyRateLimiter();

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
        description: `${req.method} ${req.originalUrl.split('?')[0]}`,
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
