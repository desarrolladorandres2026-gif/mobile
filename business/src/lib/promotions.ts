import { money } from './orderFlow';
import type { PreviewDraft } from '../components/PromotionSimulation';

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
  perUserLimit?: number;
  firstOrderOnly?: boolean;
  validDays?: number[];
  validFromTime?: string;
  validUntilTime?: string;
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

const today = () => new Date().toISOString().slice(0, 10);

/**
 * Lo que comparten las dos formas de promoción: cuánto, cuándo, a quién y
 * hasta dónde. Los topes y el horario son del servidor —él los valida y los
 * aplica—; el formulario solo los captura.
 */
interface SharedForm {
  title: string;
  type: 'percentage' | 'fixed';
  value: number;
  maxDiscountAmount: number;
  budgetLimit: number;
  usageLimit: number;
  firstOrderOnly: boolean;
  validFrom: string;
  validUntil: string;
  validDays: number[];
  validFromTime: string;
  validUntilTime: string;
}

export interface CodeForm extends SharedForm {
  code: string;
  minOrderAmount: number;
  perUserLimit: number;
}

export interface AutoForm extends SharedForm {
  description: string;
  productIds: string[];
}

export const emptyCodeForm: CodeForm = {
  code: '',
  title: '',
  type: 'percentage',
  value: 10,
  maxDiscountAmount: 0,
  minOrderAmount: 0,
  budgetLimit: 0,
  usageLimit: 0,
  perUserLimit: 1,
  firstOrderOnly: false,
  validFrom: today(),
  validUntil: '',
  validDays: [],
  validFromTime: '',
  validUntilTime: '',
};

export const emptyAutoForm: AutoForm = {
  title: '',
  description: '',
  type: 'percentage',
  value: 20,
  maxDiscountAmount: 0,
  budgetLimit: 0,
  usageLimit: 0,
  firstOrderOnly: false,
  validFrom: today(),
  validUntil: '',
  validDays: [],
  validFromTime: '',
  validUntilTime: '',
  productIds: [],
};

/** "20%", "$5.000" o "Envío gratis": el valor como lo lee el cliente. */
export const discountLabel = (type: Coupon['type'], value: number): string =>
  type === 'percentage' ? `${value}%` : type === 'fixed' ? money(value) : 'Envío gratis';

/**
 * Lo máximo que la promoción le puede costar al comercio, o `null` si no
 * hay techo que lo garantice.
 *
 * Es aritmética sobre lo que el comercio escribió, no una proyección. El
 * presupuesto sí es un techo real: el servidor lo gasta con lo que sale de la
 * liquidación del comercio en cada pedido y deja de aplicar la promoción
 * cuando el siguiente ya no cabe. Un tope de usos acota el coste solo cuando
 * cada uso cuesta como máximo una cifra conocida: el monto de una promoción
 * fija, o el tope de descuento de una porcentual.
 */
export function maxCost(input: {
  type: Coupon['type'];
  value: number;
  budgetLimit?: number;
  usageLimit?: number;
  maxDiscountAmount?: number;
}): number | null {
  if ((input.budgetLimit ?? 0) > 0) return input.budgetLimit ?? 0;
  const uses = input.usageLimit ?? 0;
  if (uses > 0 && input.type === 'fixed') return uses * input.value;
  if (uses > 0 && input.type === 'percentage' && (input.maxDiscountAmount ?? 0) > 0) {
    return uses * (input.maxDiscountAmount ?? 0);
  }
  return null;
}

/** La fecha `yyyy-mm-dd` del formulario como instante, al inicio del día. */
const toIso = (date: string) => new Date(`${date}T00:00:00`).toISOString();

/** La franja horaria como la espera el servidor: vacía solo se manda al editar, para poder quitarla. */
function windowPayload(form: SharedForm, editing: boolean) {
  const hasWindow = !!form.validFromTime && !!form.validUntilTime;
  return {
    validDays: form.validDays,
    ...(hasWindow
      ? { validFromTime: form.validFromTime, validUntilTime: form.validUntilTime }
      : editing
        ? { validFromTime: '', validUntilTime: '' }
        : {}),
  };
}

/**
 * Lo que se manda al crear o editar una promoción con código. Solo viaja lo
 * que el servidor lee: el resto (quién financia, el alcance, a quién va
 * dirigida) no es del comercio y el servidor lo ignora aunque llegara.
 */
export function codePayload(form: CodeForm, editing: boolean) {
  return {
    title: form.title,
    ...(editing ? {} : { code: form.code.trim().toUpperCase(), type: form.type }),
    value: form.value,
    ...(form.type === 'percentage' ? { maxDiscountAmount: form.maxDiscountAmount } : {}),
    minOrderAmount: form.minOrderAmount,
    budgetLimit: form.budgetLimit,
    usageLimit: form.usageLimit,
    firstOrderOnly: form.firstOrderOnly,
    // «Primer pedido» es una vez por persona: lo fija el servidor.
    ...(form.firstOrderOnly ? {} : { perUserLimit: form.perUserLimit }),
    validFrom: toIso(form.validFrom || today()),
    validUntil: toIso(form.validUntil),
    ...windowPayload(form, editing),
  };
}

export function autoPayload(form: AutoForm, editing: boolean) {
  return {
    title: form.title,
    description: form.description,
    ...(editing ? {} : { type: form.type, autoApply: true }),
    value: form.value,
    ...(form.type === 'percentage' ? { maxDiscountAmount: form.maxDiscountAmount } : {}),
    budgetLimit: form.budgetLimit,
    usageLimit: form.usageLimit,
    firstOrderOnly: form.firstOrderOnly,
    validFrom: toIso(form.validFrom),
    validUntil: toIso(form.validUntil),
    productIds: form.productIds,
    ...windowPayload(form, editing),
  };
}

/** El borrador que se manda a simular: lo mismo que se guardaría, sin código ni productos reales. */
export function previewDraft(form: CodeForm | AutoForm, auto: boolean): PreviewDraft {
  return {
    type: form.type,
    value: form.value,
    ...(form.type === 'percentage' && form.maxDiscountAmount > 0 ? { maxDiscountAmount: form.maxDiscountAmount } : {}),
    ...(!auto && 'minOrderAmount' in form && form.minOrderAmount > 0 ? { minOrderAmount: form.minOrderAmount } : {}),
    autoApply: auto,
    firstOrderOnly: form.firstOrderOnly,
    ...(form.budgetLimit > 0 ? { budgetLimit: form.budgetLimit } : {}),
    ...(form.usageLimit > 0 ? { usageLimit: form.usageLimit } : {}),
    ...(form.validUntil ? { validFrom: toIso(form.validFrom || today()), validUntil: toIso(form.validUntil) } : {}),
  };
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
