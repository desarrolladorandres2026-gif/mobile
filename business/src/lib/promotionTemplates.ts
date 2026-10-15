import {
  emptyAutoForm, emptyCodeForm,
  type AutoForm, type CodeForm,
} from './promotions';

/**
 * Ideas de promoción listas para ajustar.
 *
 * Son datos, no lógica: cada plantilla es un parche sobre el formulario vacío
 * y el servidor sigue siendo quien valida. Solo se ofrece lo que el motor de
 * cupones sabe cobrar —porcentaje o monto fijo, con código o automática—:
 * un «2x1» o un combo aquí sería prometer algo que el backend rechaza.
 *
 * Toda plantilla nace con un techo de gasto (presupuesto o usos). Una
 * promoción que arranca «sin tope» es una sorpresa a fin de mes; quitarlo es
 * una decisión del comercio, no el valor por defecto.
 */

export type TemplateLogoKey = 'coupon' | 'rating' | 'prep' | 'package' | 'wallet' | 'store' | 'dashboard' | 'delivery';

export interface PromotionTemplate {
  id: string;
  title: string;
  blurb: string;
  logo: TemplateLogoKey;
  mode: 'code' | 'auto';
  /** Días de vigencia desde hoy; `null` deja la fecha de fin vacía para que la elija el comercio. */
  days: number | null;
  patch: Partial<CodeForm & AutoForm>;
}

export const TEMPLATES: PromotionTemplate[] = [
  {
    id: 'weekday',
    title: 'Un día de la semana',
    blurb: 'Llena el día más flojo con un código fácil de recordar.',
    logo: 'coupon',
    mode: 'code',
    days: 30,
    patch: {
      title: '20% los martes',
      code: 'MARTES20',
      type: 'percentage',
      value: 20,
      maxDiscountAmount: 8000,
      budgetLimit: 100000,
      validDays: [2],
    },
  },
  {
    id: 'star',
    title: 'Producto estrella',
    blurb: 'Sin código: el descuento se aplica solo cuando piden ese producto.',
    logo: 'rating',
    mode: 'auto',
    days: 15,
    patch: {
      title: '20% en mi producto estrella',
      type: 'percentage',
      value: 20,
      maxDiscountAmount: 8000,
      budgetLimit: 100000,
    },
  },
  {
    id: 'happy-hour',
    title: 'Hora feliz',
    blurb: 'Descuento solo en la franja de la tarde, cuando hay cocina libre.',
    logo: 'prep',
    mode: 'code',
    days: 30,
    patch: {
      title: 'Hora feliz 15%',
      code: 'HORAFELIZ',
      type: 'percentage',
      value: 15,
      maxDiscountAmount: 6000,
      budgetLimit: 100000,
      validFromTime: '14:00',
      validUntilTime: '17:00',
    },
  },
  {
    id: 'first-order',
    title: 'Primer pedido',
    blurb: 'Para quien nunca ha pedido en Zipp: una razón para probarte.',
    logo: 'package',
    mode: 'code',
    days: 30,
    patch: {
      title: 'Primer pedido 15%',
      code: 'BIENVENIDO15',
      type: 'percentage',
      value: 15,
      maxDiscountAmount: 6000,
      budgetLimit: 100000,
      firstOrderOnly: true,
    },
  },
  {
    id: 'welcome',
    title: 'Regalo en pesos',
    blurb: 'Un monto fijo, con pedido mínimo para que siempre te quede margen.',
    logo: 'wallet',
    mode: 'code',
    days: 30,
    patch: {
      title: '$3.000 de regalo',
      code: 'REGALO3000',
      type: 'fixed',
      value: 3000,
      minOrderAmount: 15000,
      usageLimit: 50,
    },
  },
  {
    id: 'scratch',
    title: 'Desde cero',
    blurb: 'Tú decides todo, paso a paso.',
    logo: 'store',
    mode: 'code',
    days: null,
    patch: {},
  },
];

/** `yyyy-mm-dd` en hora local: `toISOString` daría el día de mañana pasadas las 7 p. m. en Colombia. */
export function localDay(offsetDays = 0, from: Date = new Date()): string {
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() + offsetDays);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Las dos formas de la plantilla, listas para entregar al formulario. Conserva los productos ya elegidos. */
export function applyTemplate(
  template: PromotionTemplate,
  keep: { productIds: string[] },
): { mode: 'code' | 'auto'; codeForm: CodeForm; autoForm: AutoForm } {
  const dates = {
    validFrom: localDay(0),
    validUntil: template.days === null ? '' : localDay(template.days),
  };
  return {
    mode: template.mode,
    codeForm: { ...emptyCodeForm, ...template.patch, ...dates },
    autoForm: { ...emptyAutoForm, ...template.patch, ...dates, productIds: keep.productIds },
  };
}

/** Atajos de vigencia: desde hoy, durante N días. */
export const QUICK_RANGES = [
  { days: 7, label: '7 días' },
  { days: 15, label: '15 días' },
  { days: 30, label: '30 días' },
  { days: 90, label: '3 meses' },
] as const;

export const rangeDates = (days: number) => ({ validFrom: localDay(0), validUntil: localDay(days) });

/** Franjas habituales de un restaurante; vacías es todo el día. */
export const SHIFTS = [
  { label: 'Todo el día', from: '', until: '' },
  { label: 'Desayuno · 6 a 10', from: '06:00', until: '10:00' },
  { label: 'Almuerzo · 11 a 14', from: '11:00', until: '14:00' },
  { label: 'Tarde · 14 a 17', from: '14:00', until: '17:00' },
  { label: 'Cena · 18 a 22', from: '18:00', until: '22:00' },
] as const;

const STOP_WORDS = new Set(['LOS', 'LAS', 'DEL', 'UNA', 'UNOS', 'UNAS', 'CON', 'POR', 'PARA', 'MIS', 'TUS', 'SUS']);

/**
 * Un código corto y legible a partir del título: la palabra más larga más el
 * porcentaje («20% los martes» → MARTES20). Entre 3 y 20 letras y números, que
 * es lo que acepta el servidor.
 */
export function suggestCode(title: string, type: 'percentage' | 'fixed', value: number): string {
  const words = title
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .split(/[^A-Z]+/)
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w));
  const base = words.sort((a, b) => b.length - a.length)[0] ?? 'ZIPP';
  const suffix = type === 'percentage' && value > 0 ? String(value) : '';
  return (base.slice(0, 20 - suffix.length) + suffix).slice(0, 20);
}
