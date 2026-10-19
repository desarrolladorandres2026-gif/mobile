import { applyBps, assertMoney } from './money';

/**
 * Todo lo que ZIPP sabe del costo de Wompi vive aquí y en `PlatformPricingConfig`
 * (M-005 / M-006). Ningún cálculo de pasarela se escribe en otro sitio.
 *
 * Importante: NINGUNA tarifa viene inventada. Todas nacen en 0 y las llena el
 * dueño con su contrato; mientras `gatewayContractRef` esté vacío, lo que sale de
 * aquí es una ESTIMACIÓN con tarifas sin respaldo documental y los informes lo
 * dicen (`gatewayFeeReadiness`).
 */

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
  /** Costo fijo que cobra la pasarela por un reembolso o una anulación (antes de IVA). */
  gatewayRefundFixed?: number;
  /** Costo fijo que cobra la pasarela por un contracargo (antes de IVA). */
  gatewayChargebackFixed?: number;
  /**
   * Qué parte de la comisión original devuelve la pasarela al reembolsar, en bps.
   * `null`/ausente = sin definir: no se asume nada (ni se devuelve ni se retiene).
   */
  gatewayFeeRefundBps?: number | null;
  /** Referencia del contrato o documento que respalda las tarifas. Vacío = sin verificar. */
  gatewayContractRef?: string;
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

// ── Lo que se guarda con cada cobro (vigencia) ──────────────────────────────

/**
 * La comisión tal como se calculó al capturar un cobro, guardada en el propio
 * `Payment` (`metadata.gatewayFee`). Cambiar las tarifas después no toca los
 * cobros históricos: los informes leen esto y solo estiman los cobros anteriores
 * a que existiera.
 */
export interface GatewayFeeSnapshot extends GatewayFeeBreakdown {
  /** Versión de `PlatformPricingConfig` con la que se calculó. */
  configVersion: number;
  /** Siempre una estimación: el valor real lo fija el extracto de Wompi. */
  estimated: true;
  /** El contrato respaldaba las tarifas cuando se calculó. */
  contractVerified: boolean;
}

export function gatewayFeeSnapshot(
  config: GatewayFeeConfig & { version?: number },
  paymentMethodType: string | null | undefined,
  amount: number
): GatewayFeeSnapshot {
  return {
    ...gatewayFeeBreakdown(config, paymentMethodType, amount),
    configVersion: config.version ?? 0,
    estimated: true,
    contractVerified: !!config.gatewayContractRef?.trim(),
  };
}

/**
 * La comisión de UN cobro: la guardada al capturarlo si existe; si no (cobros
 * anteriores a este registro), la estimación con la configuración vigente,
 * marcada como tal. Es la única forma de leer la comisión de un `Payment`.
 */
export function paymentGatewayFee(
  payment: { amount: number; paymentMethodType?: string | null; metadata?: Record<string, any> | null },
  config: GatewayFeeConfig
): { total: number; source: 'snapshot' | 'estimate' } {
  const stored = payment.metadata?.gatewayFee?.total;
  if (typeof stored === 'number' && Number.isInteger(stored) && stored >= 0) {
    return { total: stored, source: 'snapshot' };
  }
  return { total: estimateGatewayFee(config, payment.paymentMethodType, payment.amount), source: 'estimate' };
}

/**
 * Costo de una operación sobre un cobro ya hecho: reembolso/anulación o
 * contracargo. Fijo por operación, más el IVA que la pasarela le suma a su
 * comisión (`gatewayFeeVatBps`). 0 mientras el costo no esté configurado.
 */
export function gatewayOperationFee(
  config: GatewayFeeConfig,
  operation: 'refund' | 'chargeback'
): { base: number; vat: number; total: number } {
  const base = (operation === 'chargeback' ? config.gatewayChargebackFixed : config.gatewayRefundFixed) ?? 0;
  const vat = applyBps(base, config.gatewayFeeVatBps ?? 0);
  return { base, vat, total: base + vat };
}

/**
 * Cuánto de la comisión original devuelve la pasarela cuando se reembolsa
 * `refundedAmount` de un cobro de `paymentAmount`.
 *
 * Proporcional a lo reembolsado y acotado a lo que todavía no se ha devuelto.
 * Con la política sin definir (`gatewayFeeRefundBps` null) devuelve 0: no se
 * asume que la pasarela devuelva nada.
 */
export function gatewayFeeReturned(
  config: GatewayFeeConfig,
  originalFee: number,
  refundedAmount: number,
  paymentAmount: number,
  alreadyReturned = 0
): number {
  const bps = config.gatewayFeeRefundBps;
  if (bps == null || bps <= 0 || originalFee <= 0 || paymentAmount <= 0 || refundedAmount <= 0) return 0;
  const share = Math.floor((originalFee * Math.min(refundedAmount, paymentAmount)) / paymentAmount);
  const returned = applyBps(share, bps);
  return Math.max(0, Math.min(returned, originalFee - alreadyReturned));
}

// ── Qué falta para dar las tarifas por buenas ───────────────────────────────

export interface GatewayFeeReadiness {
  /** Hay una referencia contractual escrita: las tarifas tienen respaldo. */
  verified: boolean;
  contractRef: string;
  /** Métodos de pago sin tarifa (porcentaje y fijo en 0). Con un cobro por ese método, la comisión sale en 0. */
  methodsWithoutTariff: GatewayFeeMethod[];
  /**
   * Datos que valen 0 o «sin definir» y que solo el contrato dice si son
   * correctos. Un 0 puede ser verdad (la tarifa incluye el IVA) o un olvido.
   */
  toConfirm: Array<{ code: string; label: string }>;
  /** Sin tarifa pendiente y con respaldo: los números del libro dejan de ser provisionales. */
  complete: boolean;
}

export function gatewayFeeReadiness(config: GatewayFeeConfig): GatewayFeeReadiness {
  const methods: GatewayFeeMethod[] = ['card', 'pse', 'nequi', 'other'];
  const methodsWithoutTariff = methods.filter((m) => {
    const { bps, fixed } = rateFor(config, m);
    return !bps && !fixed;
  });

  const toConfirm: GatewayFeeReadiness['toConfirm'] = [];
  if (!config.gatewayFeeVatBps) {
    toConfirm.push({ code: 'vat', label: 'IVA sobre la comisión: en 0. Confirmar con el contrato si Wompi lo cobra aparte o ya viene incluido.' });
  }
  if (config.gatewayFeeRefundBps == null) {
    toConfirm.push({ code: 'refund_fee_policy', label: 'Si Wompi devuelve su comisión al reembolsar: sin definir. Mientras tanto no se asume que la devuelva.' });
  }
  if (!config.gatewayRefundFixed) {
    toConfirm.push({ code: 'refund_cost', label: 'Costo por reembolso o anulación: en 0. Confirmar si el contrato lo cobra.' });
  }
  if (!config.gatewayChargebackFixed) {
    toConfirm.push({ code: 'chargeback_cost', label: 'Costo por contracargo: en 0. Confirmar si el contrato lo cobra.' });
  }
  toConfirm.push({
    code: 'declined_voided',
    label: 'Transacciones rechazadas o anuladas sin cobro: se asume que no cuestan. Confirmar con el contrato; ZIPP no registra costos por intentos rechazados.',
  });

  const contractRef = config.gatewayContractRef?.trim() ?? '';
  const verified = contractRef.length > 0;
  return {
    verified,
    contractRef,
    methodsWithoutTariff,
    toConfirm,
    complete: verified && methodsWithoutTariff.length === 0,
  };
}
