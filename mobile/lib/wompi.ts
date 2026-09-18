import { detectBrand, onlyDigits, type CardBrand } from './card';

/**
 * Tokenización de tarjetas contra Wompi, **directamente desde el teléfono**.
 *
 * Es el único código de la app que habla con Wompi, y existe para que el
 * número de tarjeta no pase nunca por el servidor de Zipp: sale de aquí
 * hacia Wompi y vuelve un `tok_...`, que es lo único que viaja al backend.
 *
 * No usa `services/api.ts` a propósito. Esa instancia añade el token de
 * sesión de Zipp a cada petición, y mandarle a un tercero la credencial de
 * nuestro usuario no tiene ningún sentido. Aquí la única credencial es la
 * llave **pública** del comercio, que está pensada para viajar al cliente.
 *
 * Nada de lo que entra en `tokenizeCard` se guarda, se registra ni se
 * reenvía. Si algún día hace falta depurar esto, no se añaden `console.log`
 * con el cuerpo: se registra el código de estado y nada más.
 */

export interface CardInput {
  number: string;
  cvc: string;
  /** Dos dígitos. */
  expMonth: string;
  /** Dos dígitos. */
  expYear: string;
  holder: string;
}

export interface TokenizedCard {
  token: string;
  brand: string;
  lastFour: string;
  expMonth: string;
  expYear: string;
}

/** Error con un texto que se le puede mostrar a la persona tal cual. */
export class CardTokenizationError extends Error {
  constructor(message: string, readonly field?: 'number' | 'cvc' | 'expiry' | 'holder') {
    super(message);
    this.name = 'CardTokenizationError';
  }
}

/**
 * Mismo criterio que el backend: el entorno sale del prefijo de la llave,
 * no de un indicador aparte. Así es imposible tokenizar en producción con
 * una llave de pruebas por un flag desactualizado.
 */
function apiBase(publicKey: string): string {
  return publicKey.startsWith('pub_prod_')
    ? 'https://production.wompi.co/v1'
    : 'https://sandbox.wompi.co/v1';
}

/** Traduce los mensajes de validación de Wompi a uno que se entienda. */
function friendlyError(messages: Record<string, unknown> | undefined): CardTokenizationError {
  const keys = Object.keys(messages ?? {});
  if (keys.includes('number')) {
    return new CardTokenizationError('Wompi no reconoce ese número de tarjeta', 'number');
  }
  if (keys.includes('cvc')) {
    return new CardTokenizationError('El código de seguridad no es válido', 'cvc');
  }
  if (keys.includes('exp_month') || keys.includes('exp_year')) {
    return new CardTokenizationError('Revisa la fecha de vencimiento', 'expiry');
  }
  if (keys.includes('card_holder')) {
    return new CardTokenizationError('Revisa el nombre del titular', 'holder');
  }
  return new CardTokenizationError('No pudimos validar la tarjeta. Revisa los datos e intenta de nuevo.');
}

export async function tokenizeCard(publicKey: string, card: CardInput): Promise<TokenizedCard> {
  let res: Response;
  try {
    res = await fetch(`${apiBase(publicKey)}/tokens/cards`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${publicKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        number: onlyDigits(card.number),
        cvc: onlyDigits(card.cvc),
        exp_month: card.expMonth,
        exp_year: card.expYear,
        card_holder: card.holder.trim(),
      }),
    });
  } catch {
    throw new CardTokenizationError('Sin conexión. Revisa tu internet e intenta de nuevo.');
  }

  const payload = (await res.json().catch(() => null)) as {
    data?: {
      id?: string;
      brand?: string;
      last_four?: string;
      exp_month?: string;
      exp_year?: string;
    };
    error?: { type?: string; messages?: Record<string, unknown> };
  } | null;

  if (!res.ok) throw friendlyError(payload?.error?.messages);

  const data = payload?.data;
  if (!data?.id || !data.id.startsWith('tok_')) {
    throw new CardTokenizationError('No pudimos validar la tarjeta. Intenta de nuevo.');
  }

  const fallbackBrand: CardBrand = detectBrand(card.number);
  return {
    token: data.id,
    brand: (data.brand || fallbackBrand).toUpperCase(),
    lastFour: data.last_four || onlyDigits(card.number).slice(-4),
    expMonth: data.exp_month || card.expMonth,
    expYear: data.exp_year || card.expYear,
  };
}
