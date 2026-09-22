/**
 * Lo que lee el cliente cuando Wompi no aprueba o no crea un cobro.
 *
 * El `status_message` de Wompi y el detalle de sus 422 salían tal cual hacia
 * la app. Son textos pensados para el comercio, no para quien paga: a veces
 * técnicos, a veces en inglés, a veces con el nombre de Wompi, que mucha
 * gente no conoce y que leído en un rechazo hace pensar que el dinero fue a
 * otra empresa. Aquí se traducen a una lista corta de motivos propios.
 *
 * Vive junto al adaptador y no en las pantallas porque es conocimiento de
 * *esta* pasarela: el día que cambie, el catálogo cambia con ella y la app
 * no se entera.
 *
 * Las reglas miran palabras sueltas, no frases exactas, porque Wompi no
 * publica un catálogo cerrado de mensajes y cada emisor redacta el suyo. Lo
 * que no encaja cae en un genérico y deja rastro en el registro, para ir
 * ampliando la lista con casos reales.
 */

/** Sin tildes y en minúsculas, para que "límite" y "limite" sean lo mismo. */
function normalize(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

const GENERIC_DECLINE = 'Intenta con otro medio de pago o comunícate con tu banco.';

/**
 * En orden: la primera que encaja gana.
 *
 * La de fraude va primero y a propósito devuelve el genérico. Decirle a
 * quien prueba tarjetas robadas que lo frenó el antifraude —y no, digamos,
 * la falta de saldo— es darle la pista que necesita para ajustar el ataque.
 */
const DECLINE_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/fraud|riesgo|risk|sospech/, GENERIC_DECLINE],
  [/fondos|saldo insuficiente|insufficient/, 'Tu tarjeta o cuenta no tiene saldo suficiente.'],
  [/tarjeta.{0,15}(vencid|venci|expirad|caducad)|expired card|card expired/, 'La tarjeta está vencida.'],
  [/cuotas|installment/, 'Tu tarjeta no admite ese número de cuotas.'],
  [/limite|cupo|monto maximo|excede|exceed/, 'El pago supera el cupo o el límite de tu tarjeta o cuenta.'],
  [/3ds|3d secure|autenticacion|authentication/, 'No se completó la verificación de seguridad de tu banco.'],
  [
    /(cancelad|rechazad|declinad)[ao]s? por (el )?(usuario|cliente)|usuario (cancelo|rechazo)|cancell?ed by (the )?user/,
    'El pago se canceló desde tu app del banco o billetera.',
  ],
  [/expir|venci|tiempo|timeout|timed out/, 'Se acabó el tiempo para aprobar el pago.'],
  [/cvv|cvc|codigo de seguridad|datos invalidos|invalid card/, 'Algún dato de la tarjeta no coincide. Revísalo e intenta de nuevo.'],
  [/restringid|bloquead|no permitid|not permitted|restricted|blocked/, 'Tu banco no permite esta compra con este medio de pago.'],
];

function matchDecline(message: string): string | undefined {
  const text = normalize(message);
  return DECLINE_RULES.find(([pattern]) => pattern.test(text))?.[1];
}

/**
 * El motivo que ve el cliente para una transacción que terminó sin aprobarse.
 *
 * Solo hay motivo en los estados finales que no son aprobación: un
 * `PENDING` o un `APPROVED` no tienen nada que explicar, y devolver texto
 * ahí haría que la app pintara un rechazo que no existe.
 */
export function customerDeclineReason(rawStatus: string, statusMessage: unknown): string | undefined {
  if (rawStatus === 'VOIDED') return 'El pago fue anulado.';
  if (rawStatus !== 'DECLINED' && rawStatus !== 'ERROR') return undefined;

  const raw = typeof statusMessage === 'string' ? statusMessage.trim() : '';
  const matched = raw ? matchDecline(raw) : undefined;
  if (matched) return matched;

  if (raw) {
    console.warn('[PAYMENTS] Motivo de rechazo sin traducir', { rawStatus, statusMessage: raw.slice(0, 200) });
  }
  return rawStatus === 'ERROR'
    ? 'Hubo un problema procesando el pago. Intenta de nuevo en unos minutos.'
    : GENERIC_DECLINE;
}

/**
 * Campos de un 422 de Wompi que la persona puede corregir, con qué decirle.
 *
 * Se busca el nombre del campo en el detalle serializado y no se recorre su
 * estructura: Wompi anida los errores de validación de formas distintas
 * según el medio de pago, y lo único estable es el nombre del campo.
 */
const FIELD_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/phone_number/, 'Revisa el número de celular.'],
  [/legal_id/, 'Revisa el número de documento.'],
  [/customer_email|email/, 'Revisa tu correo electrónico.'],
  [/financial_institution/, 'Elige de nuevo tu banco.'],
  [/installments/, 'Tu tarjeta no admite ese número de cuotas.'],
  // Antes que la de `token`: también se llama así, y no es la tarjeta.
  [/acceptance_token|accept_personal_auth/, 'No pudimos iniciar el pago. Cierra esta pantalla e intenta de nuevo.'],
  [/token/, 'Vuelve a escribir los datos de la tarjeta.'],
];

/**
 * El mensaje para el cliente cuando Wompi no acepta crear la transacción.
 *
 * Un 5xx es Wompi caído, no un "no": se dice como tal para que la persona
 * reintente en vez de cambiar de tarjeta sin necesidad.
 */
export function customerCreationMessage(httpStatus: number, reason: unknown, messages: unknown): string {
  if (httpStatus >= 500) {
    return 'El servicio de pagos no respondió. Intenta de nuevo en unos minutos.';
  }

  if (typeof reason === 'string' && reason.trim()) {
    const matched = matchDecline(reason);
    if (matched && matched !== GENERIC_DECLINE) return matched;
  }

  if (messages && typeof messages === 'object') {
    const detail = JSON.stringify(messages);
    const field = FIELD_RULES.find(([pattern]) => pattern.test(detail))?.[1];
    if (field) return field;
  }

  return 'No pudimos iniciar el pago. Revisa los datos o usa otro medio de pago.';
}
