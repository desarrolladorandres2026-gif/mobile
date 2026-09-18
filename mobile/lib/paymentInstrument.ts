import type { CheckoutConfig, PaymentInstrument } from '../hooks/useApi';
import type { IconName } from '../theme/icons';
import { BRAND_LABEL, type CardBrand } from './card';

/**
 * El método de pago que la persona eligió en la hoja, listo para cobrar.
 *
 * Lleva, además del instrumento, cómo pintarlo en el checkout ("Visa ····
 * 4242") para no tener que reconstruirlo desde el token.
 */
export interface SelectedInstrument {
  instrument: PaymentInstrument;
  label: string;
  detail?: string;
  icon: IconName;
  /** Correo para el comprobante, solo si la cuenta no tiene uno. */
  customerEmail?: string;
  /**
   * Hasta cuándo sirve (ms). Solo las tarjetas recién escritas lo tienen:
   * su token es de un solo uso y además caduca, así que una selección
   * olvidada en el checkout veinte minutos no puede llegar a cobrarse.
   */
  expiresAt?: number;
}

/** Cuánto se confía en un token de tarjeta antes de pedirla otra vez. */
export const CARD_TOKEN_TTL_MS = 10 * 60_000;

export function brandLabel(brand: string): string {
  return BRAND_LABEL[brand.toUpperCase() as CardBrand] ?? brand;
}

export function cardLabel(brand: string, lastFour: string): string {
  return `${brandLabel(brand)} ···· ${lastFour}`;
}

/** Nequi: se muestran solo los últimos dígitos, como en el extracto. */
export function maskPhone(phone: string): string {
  return `···· ${phone.slice(-4)}`;
}

/**
 * ¿Se puede volver a cobrar con esto después de un intento?
 *
 * Una tarjeta recién escrita **no**: Wompi consume el token en el primer
 * intento, apruebe o no. Una guardada, Nequi o PSE sí, porque no dependen
 * de nada de un solo uso.
 */
export function isReusable(selected: SelectedInstrument): boolean {
  return selected.instrument.kind !== 'card_token';
}

export function isExpiredSelection(selected: SelectedInstrument, now = Date.now()): boolean {
  return selected.expiresAt !== undefined && selected.expiresAt < now;
}

/** El cuerpo de `POST /payments/orders/:id/pay-native`. */
export function payNativeBody(
  selected: SelectedInstrument,
  config: CheckoutConfig,
  redirectUrl?: string
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    instrument: selected.instrument,
    // El token de los términos que se le mostraron, tal cual.
    acceptanceToken: config.acceptanceToken,
  };

  // El de datos personales solo viaja si se va a guardar la tarjeta: no es
  // un consentimiento que se pida "por si acaso".
  if (selected.instrument.kind === 'card_token' && selected.instrument.save) {
    body.personalDataAuthToken = config.personalDataAuthToken;
  }
  if (selected.customerEmail) body.customerEmail = selected.customerEmail;
  // Solo PSE vuelve de otra página; a los demás no les sirve de nada.
  if (redirectUrl && selected.instrument.kind === 'pse') body.redirectUrl = redirectUrl;

  return body;
}
