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
  /** Base del IVA: `total` (porcentaje + fijo, por defecto) o solo el `fixed`. */
  gatewayFeeVatBase?: 'total' | 'fixed';
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

/** Tarifa (porcentaje en bps y fijo) que la configuración define para un método. */
function rateFor(config: GatewayFeeConfig, method: GatewayFeeMethod): { bps?: number; fixed?: number } {
  switch (method) {
    case 'card':
      return { bps: config.gatewayCardBps, fixed: config.gatewayCardFixed };
    case 'pse':
      return { bps: config.gatewayPseBps, fixed: config.gatewayPseFixed };
    case 'nequi':
      return { bps: config.gatewayNequiBps, fixed: config.gatewayNequiFixed };
    default:
      return { bps: config.gatewayOtherBps, fixed: config.gatewayOtherFixed };
  }
}

export interface GatewayFeeBreakdown {
  method: GatewayFeeMethod;
  /** Parte porcentual de la comisión. */
  percentage: number;
  /** Tarifa fija por transacción. */
  fixed: number;
  /** IVA que la pasarela suma sobre (porcentaje + fijo). */
  vat: number;
  total: number;
}

/** Mismo cálculo que `estimateGatewayFee`, pero con las partes a la vista. */
export function gatewayFeeBreakdown(
  config: GatewayFeeConfig,
  paymentMethodType: string | null | undefined,
  amount: number
): GatewayFeeBreakdown {
  assertMoney(amount);
  const method = gatewayFeeMethod(paymentMethodType);
  const total = estimateGatewayFee(config, paymentMethodType, amount);
  if (total === 0) return { method, percentage: 0, fixed: 0, vat: 0, total: 0 };
  const { bps, fixed } = rateFor(config, method);
  const percentage = applyBps(amount, bps ?? 0);
  return { method, percentage, fixed: fixed ?? 0, vat: total - percentage - (fixed ?? 0), total };
}

export function estimateGatewayFee(
  config: GatewayFeeConfig,
  paymentMethodType: string | null | undefined,
  amount: number
): number {
  assertMoney(amount);
  const method = gatewayFeeMethod(paymentMethodType);
  const { bps, fixed } = rateFor(config, method);

  if (!bps && !fixed) return 0;
  const base = applyBps(amount, bps ?? 0) + (fixed ?? 0);
  const vatBase = config.gatewayFeeVatBase === 'fixed' ? fixed ?? 0 : base;
  return base + applyBps(vatBase, config.gatewayFeeVatBps ?? 0);
}
