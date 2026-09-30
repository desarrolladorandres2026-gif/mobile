import { money } from './orderFlow';

/** Promoción del comercio tal como la manda `/coupons/business/:id`. */
export interface Coupon {
  _id: string;
  code: string;
  title: string;
  description?: string;
  type: 'percentage' | 'fixed' | 'free_delivery';
  scope?: 'product' | 'delivery' | 'service_fee';
  value: number;
  maxDiscountAmount?: number;
  minOrderAmount?: number;
  budgetLimit?: number;
  budgetSpent?: number;
  usageLimit?: number;
  usedCount?: number;
  validFrom?: string;
  validUntil: string;
  isActive: boolean;
  autoApply?: boolean;
  productIds?: string[];
  availability?: { state: 'active' | 'scheduled' | 'exhausted' };
}

export const TYPE_LABELS: Record<Coupon['type'], string> = {
  percentage: 'Porcentaje',
  fixed: 'Monto fijo',
  free_delivery: 'Envío gratis',
};

export const toDateInput = (iso?: string) => (iso ? iso.slice(0, 10) : '');

export const emptyCodeForm = {
  code: '',
  title: '',
  type: 'percentage' as Coupon['type'],
  value: 10,
  minOrderAmount: 0,
  budgetLimit: 0,
  usageLimit: 0,
  perUserLimit: 1,
  validUntil: '',
};

export const emptyAutoForm = {
  title: '',
  description: '',
  type: 'percentage' as 'percentage' | 'fixed',
  value: 20,
  maxDiscountAmount: 0,
  budgetLimit: 0,
  validFrom: new Date().toISOString().slice(0, 10),
  validUntil: '',
  productIds: [] as string[],
};

export type CodeForm = typeof emptyCodeForm;
export type AutoForm = typeof emptyAutoForm;

/** "20%", "$5.000" o "Envío gratis": el valor como lo lee el cliente. */
export const discountLabel = (type: Coupon['type'], value: number): string =>
  type === 'percentage' ? `${value}%` : type === 'fixed' ? money(value) : 'Envío gratis';

/**
 * Lo máximo que la promoción le puede costar al comercio, o `null` si no
 * hay techo que lo garantice.
 *
 * Es aritmética sobre lo que el comercio escribió, no una proyección: un
 * porcentaje sin presupuesto ni tope de usos no tiene máximo conocido, y
 * decirlo es más honesto que inventar una cifra.
 */
export function maxCost(input: {
  type: Coupon['type'];
  value: number;
  budgetLimit?: number;
  usageLimit?: number;
}): number | null {
  if ((input.budgetLimit ?? 0) > 0) return input.budgetLimit ?? 0;
  if ((input.usageLimit ?? 0) > 0 && input.type === 'fixed') return (input.usageLimit ?? 0) * input.value;
  return null;
}

export type PromotionGroup = 'active' | 'scheduled' | 'ended';

export function groupOf(coupon: Coupon): PromotionGroup {
  if (!coupon.isActive) return 'ended';
  if (coupon.availability?.state === 'active') return 'active';
  if (coupon.availability?.state === 'scheduled') return 'scheduled';
  return 'ended';
}

/** Fracción consumida (0–1) del tope que más pronto se agota, o `null` sin topes. */
export function consumption(coupon: Coupon): { ratio: number; label: string } | null {
  const budget = coupon.budgetLimit ?? 0;
  if (budget > 0) {
    const spent = coupon.budgetSpent ?? 0;
    return { ratio: Math.min(1, spent / budget), label: `${money(spent)} de ${money(budget)}` };
  }
  const limit = coupon.usageLimit ?? 0;
  if (limit > 0) {
    const used = coupon.usedCount ?? 0;
    return { ratio: Math.min(1, used / limit), label: `${used} de ${limit} usos` };
  }
  return null;
}
