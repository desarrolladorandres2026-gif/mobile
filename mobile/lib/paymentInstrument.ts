import type { CheckoutConfig, PaymentInstrument } from '../hooks/useApi';
import type { IconName } from '../theme/icons';
import { BRAND_LABEL, type CardBrand } from './card';
import { browserInfo } from './browserInfo';

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

/**
 * El cuerpo de `POST /payments/orders/:id/pay-native`.
 *
 * No lleva dirección de regreso: la de PSE la fija el servidor. `info` se
 * inyecta solo para poder probar esto sin pantalla.
 */
export function payNativeBody(
  selected: SelectedInstrument,
  config: CheckoutConfig,
  info: () => Record<string, string> = browserInfo
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
  // 3D Secure solo aplica a una tarjeta recién escrita, y solo si el
  // comercio lo tiene encendido: sin eso, mandar el navegador es ruido.
  if (config.threeDs && selected.instrument.kind === 'card_token') body.browserInfo = info();

  return body;
}

// ── Cuotas ──

/** Las que se ofrecen. Wompi admite hasta 36; estas son las habituales. */
export const INSTALLMENT_OPTIONS = [1, 2, 3, 6, 12, 24, 36] as const;

/** ¿Este método admite cuotas? Solo las tarjetas, nueva o guardada. */
export function acceptsInstallments(selected: SelectedInstrument | null): boolean {
  const kind = selected?.instrument.kind;
  return kind === 'card_token' || kind === 'saved_card';
}

export function installmentsOf(selected: SelectedInstrument | null): number {
  if (!selected) return 1;
  const { instrument } = selected;
  if (instrument.kind === 'card_token' || instrument.kind === 'saved_card') {
    return instrument.installments ?? 1;
  }
  return 1;
}

/**
 * La misma selección con otras cuotas. Nequi y PSE no tienen cuotas: se
 * devuelven tal cual, para que un toque en la fila equivocada no invente
 * un campo que el backend rechazaría.
 */
export function withInstallments(selected: SelectedInstrument, installments: number): SelectedInstrument {
  const { instrument } = selected;
  if (instrument.kind === 'card_token' || instrument.kind === 'saved_card') {
    return { ...selected, instrument: { ...instrument, installments } };
  }
  return selected;
}
