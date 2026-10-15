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

const DAY_PLURAL: Record<number, string> = {
  1: 'lunes', 2: 'martes', 3: 'miércoles', 4: 'jueves', 5: 'viernes', 6: 'sábados', 0: 'domingos',
};

const joinList = (items: string[]) =>
  items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} y ${items[items.length - 1]}`;

const longDate = (day: string) =>
  new Date(`${day}T00:00:00`).toLocaleDateString('es-CO', { day: 'numeric', month: 'long' });

/**
 * La promoción contada en una frase, tal como la entendería el comercio:
 * «20% de descuento con el código MARTES20, los martes, de 14:00 a 17:00,
 * hasta el 30 de octubre. Como máximo te cuesta $100.000.»
 */
export function promotionSummary(form: CodeForm | AutoForm, auto: boolean): string {
  const head = `${discountLabel(form.type, form.value)} de descuento`;
  const cap = form.type === 'percentage' && form.maxDiscountAmount > 0 ? ` (hasta ${money(form.maxDiscountAmount)} por pedido)` : '';
  const target = auto
    ? `en ${(form as AutoForm).productIds.length} producto(s), sin código`
    : (form as CodeForm).code.trim() ? `con el código ${(form as CodeForm).code.trim().toUpperCase()}` : 'con un código por definir';

  const parts = [`${head}${cap} ${target}`];
  const min = auto ? 0 : (form as CodeForm).minOrderAmount;
  if (min > 0) parts.push(`en pedidos desde ${money(min)}`);
  if (form.firstOrderOnly) parts.push('solo en el primer pedido de cada cliente');
  if (form.validDays.length > 0) {
    // Lunes primero, como se lee; el número es el del servidor (0 = domingo).
    const names = [...form.validDays].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map((d) => DAY_PLURAL[d]);
    parts.push(`los ${joinList(names)}`);
  }
  if (form.validFromTime && form.validUntilTime) parts.push(`de ${form.validFromTime} a ${form.validUntilTime}`);
  parts.push(form.validUntil ? `hasta el ${longDate(form.validUntil)}` : 'sin fecha de fin todavía');

  const cost = maxCost(form);
  const tail = cost === null ? 'No tiene techo de costo.' : `Como máximo te cuesta ${money(cost)}.`;
  return `${parts.join(', ')}. ${tail}`;
}

/**
 * Estado de una promoción, resuelto igual que lo hace el cobro.
 *
 * El backend ya manda `availability` (`couponAvailability()`, la misma función
 * que decide si un cupón aplica al cobrar); esto solo lo traduce a las cuatro
 * etiquetas que el comercio entiende: Activa, Programada, Finalizada, Agotada.
 * `isActive` desactivado manda sobre cualquier otra cosa.
 */
export interface PromotionLike {
  isActive: boolean;
  validUntil: string | Date;
  budgetLimit?: number;
  budgetSpent?: number;
  usageLimit?: number;
  usedCount?: number;
  availability?: { state: 'active' | 'scheduled' | 'exhausted' };
}

export type Tone = 'success' | 'info' | 'warning' | 'muted';

export function resolveStatus(promotion: PromotionLike): { label: string; tone: Tone } {
  if (!promotion.isActive) return { label: 'Desactivada', tone: 'muted' };

  const state = promotion.availability?.state;
  if (state === 'scheduled') return { label: 'Programada', tone: 'info' };
  if (state === 'active') return { label: 'Activa', tone: 'success' };

  // `exhausted` con isActive:true — hay que distinguir por qué: ¿ya pasó
  // la fecha, o se acabó el cupo?
  const ended = new Date(promotion.validUntil).getTime() < Date.now();
  if (ended) return { label: 'Finalizada', tone: 'muted' };

  const budgetGone = (promotion.budgetLimit ?? 0) > 0 && (promotion.budgetSpent ?? 0) >= (promotion.budgetLimit ?? 0);
  const usesGone = (promotion.usageLimit ?? 0) > 0 && (promotion.usedCount ?? 0) >= (promotion.usageLimit ?? 0);
  if (budgetGone || usesGone) return { label: 'Agotada', tone: 'warning' };

  return { label: 'Finalizada', tone: 'muted' };
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
