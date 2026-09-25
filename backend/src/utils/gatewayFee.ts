import { applyBps, assertMoney } from './money';

/**
 * Comisión estimada de la pasarela por un cobro.
 *
 * Pura y entera: `porcentaje + fijo`, más el IVA que la pasarela le suma a
 * su propia comisión. Devuelve 0 mientras la tarifa del método esté sin
 * configurar (todo en 0), que es lo que mantiene el resultado de la
 * plataforma marcado como incompleto en vez de presumir un coste inventado.
 */
export type GatewayFeeMethod = 'card' | 'pse' | 'nequi' | 'other';

export interface GatewayFeeConfig {
  gatewayCardBps?: number;
  gatewayCardFixed?: number;
  gatewayPseBps?: number;
  gatewayPseFixed?: number;
  gatewayNequiBps?: number;
  gatewayNequiFixed?: number;
  gatewayOtherBps?: number;
  gatewayOtherFixed?: number;
  gatewayFeeVatBps?: number;
}

/** Los `paymentMethodType` de Wompi que tienen tarifa propia; el resto va a `other`. */
export function gatewayFeeMethod(paymentMethodType?: string | null): GatewayFeeMethod {
  switch ((paymentMethodType ?? '').toUpperCase()) {
    case 'CARD':
      return 'card';
    case 'PSE':
      return 'pse';
    case 'NEQUI':
      return 'nequi';
    default:
      return 'other';
  }
}

export function estimateGatewayFee(
  config: GatewayFeeConfig,
  paymentMethodType: string | null | undefined,
  amount: number
): number {
  assertMoney(amount);
  const method = gatewayFeeMethod(paymentMethodType);
  const bps =
    method === 'card' ? config.gatewayCardBps
    : method === 'pse' ? config.gatewayPseBps
    : method === 'nequi' ? config.gatewayNequiBps
    : config.gatewayOtherBps;
  const fixed =
    method === 'card' ? config.gatewayCardFixed
    : method === 'pse' ? config.gatewayPseFixed
    : method === 'nequi' ? config.gatewayNequiFixed
    : config.gatewayOtherFixed;

  if (!bps && !fixed) return 0;
  const base = applyBps(amount, bps ?? 0) + (fixed ?? 0);
  return base + applyBps(base, config.gatewayFeeVatBps ?? 0);
}
