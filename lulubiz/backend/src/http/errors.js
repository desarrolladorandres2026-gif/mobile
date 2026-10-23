/**
 * Traduce los errores de dominio a respuestas HTTP. Lo que no se reconoce se responde como 500
 * con un mensaje genérico: el detalle va al registro, nunca al cliente.
 */
const BY_CODE = {
  INVALID_CREDENTIALS: 401,
  INVALID_SESSION: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION: 400,
  DUPLICATE: 409,
  EMAIL_TAKEN: 409,
  ALREADY_MEMBER: 409,
  LAST_OWNER: 409,
  IMMUTABLE: 422,
  ALREADY_CLOSED: 409,
  NOT_CLOSED: 409,
  EXPIRED_TOKEN: 400,
  MFA_REQUIRED: 401,
  INVALID_MFA: 401,
  EMAIL_NOT_VERIFIED: 403,
  LOGIN_REQUIRED: 401,
  MFA_ALREADY: 409,
  NOT_CONFIGURED: 501,
  SETTINGS_INCOMPLETE: 409,
  NO_RESOLUTION: 409,
  INVALID_STATE: 409,
  OVER_CREDIT: 409,
  OVER_PAYMENT: 409,
  INSUFFICIENT_STOCK: 409,
  ITEM_IN_USE: 409,
  STOCK_CONFLICT: 409,
  NO_SHIFT: 409,
  RANGE_TOO_LARGE: 400,
  SHIFT_CLOSED: 409,
  SHIFT_OPEN: 409,
  ALREADY_MATCHED: 409,
  RECONCILED: 409,
  NOT_BALANCED: 422,
  EXPORT_RUNNING: 429,
};

const BY_NAME = {
  MoneyError: 400,
  PasswordError: 400,
  TenantError: 400,
  LedgerValidationError: 422,
  LedgerImbalanceError: 422,
  JournalNotFoundError: 404,
  JournalAlreadyReversedError: 409,
  PeriodClosedError: 409,
  BusyError: 503,
  BSONError: 400,
};

export function statusFor(err) {
  if (err?.validation) return 400;
  if (err?.statusCode && err.statusCode < 500) return err.statusCode;
  if (err?.code && BY_CODE[err.code]) return BY_CODE[err.code];
  if (err?.name && BY_NAME[err.name]) return BY_NAME[err.name];
  return 500;
}

export function errorHandler(err, request, reply) {
  const status = statusFor(err);
  // Solo el 500 es un fallo inesperado. Un 501 (no configurado) o un 503 (ocupado) son respuestas deliberadas y de dominio:
  // se devuelven con su mensaje y no se reportan como errores del servidor.
  if (status === 500) {
    request.log.error({ err }, 'error no controlado');
    // Sin esperar la respuesta del destino: reportar no debe retrasar ni romper la petición.
    Promise.resolve(
      request.server.reporter?.report(err, {
        requestId: request.id,
        method: request.method,
        route: request.routeOptions?.url,
        status,
        tenantId: request.ctx?.tenantId,
        userId: request.ctx?.userId,
      }),
    ).catch(() => {});
    return reply.status(500).send({ error: 'INTERNAL', message: 'error interno' });
  }
  // Servicio ocupado, no roto: el cliente debe reintentar poco después.
  if (status === 503) reply.header('retry-after', '2');
  return reply.status(status).send({
    error: err.validation ? 'VALIDATION' : err.code ?? err.name ?? 'ERROR',
    message: err.message,
  });
}
