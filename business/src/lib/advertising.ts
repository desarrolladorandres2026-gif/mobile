import { money } from './orderFlow';
import { localDay, type TemplateLogoKey } from './promotionTemplates';

export type PricingModel = 'cpm' | 'cpc';

export interface AdDraft {
  campaignName: string;
  flyerUrl: string;
  startDate: string;
  endDate: string;
  pricingModel: PricingModel;
  cpmRate: number;
  cpcRate: number;
  budget: number;
}

// ── Lo que ZIPP ofrece hoy (`GET /advertisements/business/:id/offer`) ──
//
// Las tarifas, los topes y la duración ya no viven en el panel (auditoría
// 2026-10-17): los configura ZIPP en Tarifas y Monetización y el servidor los
// vuelve a exigir al comprar y al aprobar. Aquí solo se leen para guiar.

export interface AdModelOffer {
  enabled: boolean;
  minRate: number;
  maxRate: number;
}

export interface AdOffer {
  available: boolean;
  /** Por qué no se puede comprar todavía, en frases para el comercio. */
  reasons: string[];
  billingEnabled: boolean;
  models: Record<PricingModel, AdModelOffer>;
  budget: { min: number; max: number };
  durationDays: { min: number; max: number };
  placements: Array<'splash' | 'explore'>;
  autoRenew: false;
  configVersion: number;
}

const MODELS: PricingModel[] = ['cpc', 'cpm'];

/** Las modalidades que se pueden comprar, CPC primero. */
export const offeredModels = (offer: AdOffer): PricingModel[] => MODELS.filter((m) => offer.models[m]?.enabled);

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

/** Duración por defecto dentro de lo permitido: dos semanas si caben. */
const defaultDays = (offer: AdOffer, wanted = 14) => clamp(wanted, Math.max(1, offer.durationDays.min), Math.max(1, offer.durationDays.max));

/** Borrador inicial: la tarifa mínima, el presupuesto mínimo y desde mañana. */
export const emptyDraft = (offer: AdOffer): AdDraft => {
  const model = offeredModels(offer)[0] ?? 'cpc';
  return {
    campaignName: '',
    flyerUrl: '',
    startDate: localDay(1),
    endDate: localDay(1 + defaultDays(offer)),
    pricingModel: model,
    cpmRate: offer.models.cpm?.minRate ?? 0,
    cpcRate: offer.models.cpc?.minRate ?? 0,
    budget: offer.budget.min,
  };
};

/**
 * Ideas de campaña listas para ajustar: nombre, modalidad y duración. Ya no
 * traen tarifas ni presupuestos: esos salen de la oferta de ZIPP.
 */
export interface AdTemplate {
  id: string;
  title: string;
  blurb: string;
  logo: TemplateLogoKey;
  patch: Partial<Pick<AdDraft, 'campaignName' | 'pricingModel'>>;
  /** Días que dura, contados desde que empieza (se ajusta a lo permitido). */
  days: number;
  /** Cuántos días desde hoy empieza; `'weekend'` es el próximo viernes. */
  start: number | 'weekend';
}

export const AD_TEMPLATES: AdTemplate[] = [
  {
    id: 'visits',
    title: 'Que entren a mi tienda',
    blurb: 'Pagas solo cuando alguien toca el anuncio.',
    logo: 'store',
    patch: { campaignName: 'Visitas a mi tienda', pricingModel: 'cpc' },
    days: 14,
    start: 1,
  },
  {
    id: 'seen',
    title: 'Que más gente me vea',
    blurb: 'Pagas por cada mil veces que tu anuncio sale en pantalla.',
    logo: 'rating',
    patch: { campaignName: 'Más visibilidad', pricingModel: 'cpm' },
    days: 14,
    start: 1,
  },
  {
    id: 'launch',
    title: 'Lanzamiento',
    blurb: 'Un mes de presencia para que el barrio sepa que abriste o que tienes algo nuevo.',
    logo: 'package',
    patch: { campaignName: 'Lanzamiento' },
    days: 30,
    start: 1,
  },
  {
    id: 'weekend',
    title: 'Solo el fin de semana',
    blurb: 'De viernes a domingo, cuando más se pide a domicilio.',
    logo: 'delivery',
    patch: { campaignName: 'Fin de semana' },
    days: 3,
    start: 'weekend',
  },
  {
    id: 'scratch',
    title: 'Desde cero',
    blurb: 'Tú decides todo, paso a paso.',
    logo: 'dashboard',
    patch: {},
    days: 14,
    start: 1,
  },
];

/** Solo las ideas que se pueden comprar con la oferta de hoy (CPM apagado → sin «Que más gente me vea»). */
export const templatesFor = (offer: AdOffer): AdTemplate[] =>
  AD_TEMPLATES.filter((t) => !t.patch.pricingModel || offer.models[t.patch.pricingModel]?.enabled);

/** Días desde hoy hasta el próximo viernes, nunca antes de mañana. */
export const daysToNextFriday = (from: Date = new Date()): number => ((5 - from.getDay() + 7) % 7) || 7;

export function applyAdTemplate(template: AdTemplate, offer: AdOffer, from: Date = new Date()): AdDraft {
  const start = template.start === 'weekend' ? daysToNextFriday(from) : template.start;
  const base = emptyDraft(offer);
  const model = template.patch.pricingModel && offer.models[template.patch.pricingModel]?.enabled
    ? template.patch.pricingModel
    : base.pricingModel;
  return {
    ...base,
    ...template.patch,
    pricingModel: model,
    startDate: localDay(start, from),
    endDate: localDay(start + defaultDays(offer, template.days), from),
  };
}

/** Atajos de duración a partir de la fecha de inicio elegida (solo los permitidos). */
export const AD_DURATIONS = [
  { days: 7, label: '1 semana' },
  { days: 14, label: '2 semanas' },
  { days: 30, label: '1 mes' },
] as const;

export const durationsFor = (offer: AdOffer) =>
  AD_DURATIONS.filter((d) => d.days >= offer.durationDays.min && d.days <= offer.durationDays.max);

export const dayDiff = (from: string, to: string) =>
  Math.round((new Date(`${to}T00:00:00`).getTime() - new Date(`${from}T00:00:00`).getTime()) / 86_400_000);

export const addDays = (day: string, days: number) => {
  const [y, m, d] = day.split('-').map(Number);
  return localDay(days, new Date(y, m - 1, d));
};

const unique = (values: number[]) => [...new Set(values.filter((v) => v > 0))].sort((a, b) => a - b);

/** Atajos de tarifa: mínimo, punto medio (redondeado a $50) y máximo de la oferta. */
export function ratePresets(offer: AdOffer, model: PricingModel): number[] {
  const { minRate, maxRate } = offer.models[model];
  return unique([minRate, Math.round((minRate + maxRate) / 2 / 50) * 50, maxRate]).filter((v) => v >= minRate && v <= maxRate);
}

/** Atajos de tope: el mínimo, su doble, su quíntuple y el máximo, sin salirse del rango. */
export function budgetPresets(offer: AdOffer): number[] {
  const { min, max } = offer.budget;
  return unique([min, min * 2, min * 5, max]).filter((v) => v >= min && v <= max);
}

/** Tarifa vigente del borrador, según cómo se cobre. */
export const rateOf = (d: AdDraft) => (d.pricingModel === 'cpm' ? d.cpmRate : d.cpcRate);

/**
 * Cuántas impresiones o clics caben en el tope. Es la misma cuenta que hace el
 * servidor (`capsFor`): el dinero se traduce una vez a un número de eventos y
 * ahí se corta. Es un techo comprado, no una promesa de que se alcance.
 */
export function reachOf(d: AdDraft): number | null {
  const rate = rateOf(d);
  if (!d.budget || !rate) return null;
  const reach = d.pricingModel === 'cpm' ? Math.floor((d.budget * 1000) / rate) : Math.floor(d.budget / rate);
  return reach > 0 ? reach : null;
}

export type AdStep = 'idea' | 'ad' | 'when' | 'budget' | 'review';

/**
 * Un flyer subido a Zipp (Cloudinary). Un enlace externo ya no se acepta: el
 * servidor lo rechaza en la compra (auditoría 2026-10-17), así que aquí se
 * pide subirlo antes de llegar a ese 400.
 */
export const isFlyerUrl = (value: string) => {
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' && url.hostname === 'res.cloudinary.com';
  } catch {
    return false;
  }
};

/**
 * Lo que falta en un paso, en el orden en que la pantalla lo pide; vacío si
 * está bien. Los rangos son los de la oferta: el servidor los vuelve a exigir.
 */
export function adProblem(step: AdStep, d: AdDraft, offer: AdOffer): string {
  if (step === 'ad') {
    if (d.campaignName.trim().length < 3) return 'Ponle un nombre de al menos 3 letras a la campaña.';
    if (!isFlyerUrl(d.flyerUrl)) return 'Sube la imagen del flyer.';
  }
  if (step === 'when') {
    if (!d.startDate || !d.endDate) return 'Elige cuándo empieza y cuándo termina.';
    const days = dayDiff(d.startDate, d.endDate);
    if (days <= 0) return 'La campaña tiene que terminar después de empezar.';
    if (days < offer.durationDays.min) return `La campaña dura al menos ${offer.durationDays.min} días.`;
    if (days > offer.durationDays.max) return `La campaña dura como máximo ${offer.durationDays.max} días.`;
  }
  if (step === 'budget') {
    const model = offer.models[d.pricingModel];
    if (!model?.enabled) return 'Esa forma de cobro todavía no está disponible. Elige otra.';
    const rate = rateOf(d);
    if (!rate) return `Pon la tarifa ${d.pricingModel === 'cpm' ? 'por mil impresiones' : 'por clic'}.`;
    if (rate < model.minRate || rate > model.maxRate) {
      return `La tarifa va de ${money(model.minRate)} a ${money(model.maxRate)}.`;
    }
    if (!d.budget) return 'Pon un tope de gasto: sin él estarías firmando un gasto abierto.';
    if (d.budget < offer.budget.min || d.budget > offer.budget.max) {
      return `El tope va de ${money(offer.budget.min)} a ${money(offer.budget.max)}.`;
    }
    if (!reachOf(d)) return 'Con esa tarifa el tope no alcanza para nada.';
  }
  return '';
}

const longDate = (day: string) =>
  new Date(`${day}T00:00:00`).toLocaleDateString('es-CO', { day: 'numeric', month: 'long' });

/** La campaña contada en una frase, con lo que cuesta como máximo. */
export function adSummary(d: AdDraft): string {
  const reach = reachOf(d);
  const how = d.pricingModel === 'cpm'
    ? `${money(d.cpmRate)} por cada mil impresiones`
    : `${money(d.cpcRate)} por cada clic`;
  const cap = reach
    ? `con ese tope caben hasta ${reach.toLocaleString('es-CO')} ${d.pricingModel === 'cpm' ? 'impresiones' : 'clics'}`
    : 'falta la tarifa para saber cuánto alcanza';
  return (
    `Tu flyer sale a pantalla completa al abrir la app, del ${longDate(d.startDate)} al ${longDate(d.endDate)}, ` +
    `una vez que Zipp lo apruebe. Pagas ${how}, nunca más de ${money(d.budget)}: ${cap}. ` +
    `Lo gastado se descuenta de tu liquidación al cerrar la campaña.`
  );
}

// ── Campañas ya enviadas, tal como las manda `/advertisements/business/:id` ──

export interface Campaign {
  _id: string;
  campaignName: string;
  flyerUrl: string;
  startDate: string;
  endDate: string;
  pricingModel: string;
  cpmRate: number;
  cpcRate: number;
  budget: number;
  maxImpressions: number;
  maxClicks: number;
  impressionCount: number;
  clickCount: number;
  placement?: 'splash' | 'explore';
  isActive?: boolean;
  cancelledAt?: string | null;
  approvalStatus: 'pending' | 'approved' | 'rejected';
  rejectionReason?: string;
}

export interface Invoice {
  _id: string;
  campaignId: string;
  campaignName: string;
  impressions: number;
  clicks: number;
  amount: number;
  settledAt?: string | null;
  createdAt: string;
}

/** Lo que el comercio tiene que hacer con cada campaña: corregir, esperar, mirar, archivar. */
export type Phase = 'attention' | 'review' | 'active' | 'closed';

export const isCpmOf = (c: Campaign) => c.pricingModel === 'cpm';
export const servedOf = (c: Campaign) => (isCpmOf(c) ? c.impressionCount : c.clickCount);
export const capOf = (c: Campaign) => (isCpmOf(c) ? c.maxImpressions : c.maxClicks);
export const spentOf = (c: Campaign) =>
  isCpmOf(c) ? Math.round((c.impressionCount * c.cpmRate) / 1000) : c.clickCount * c.cpcRate;

export function phaseOf(c: Campaign, now: number): Phase {
  if (c.approvalStatus === 'rejected') return 'attention';
  if (c.approvalStatus === 'pending') return 'review';
  const cap = capOf(c);
  if (c.cancelledAt || new Date(c.endDate).getTime() < now || (cap > 0 && servedOf(c) >= cap)) return 'closed';
  return 'active';
}

export type StateTone = 'danger' | 'warning' | 'info' | 'success' | 'muted';

const stateDay = (value: string) =>
  new Date(value).toLocaleDateString('es-CO', { day: 'numeric', month: 'short' });

/** Una línea que dice en qué punto está, para quien solo mira la lista. */
export function stateLine(c: Campaign, phase: Phase, now: number): { text: string; tone: StateTone } {
  if (phase === 'attention') return { text: 'Rechazada', tone: 'danger' };
  if (phase === 'review') return { text: 'En revisión de Zipp', tone: 'warning' };
  if (phase === 'active') {
    if (c.isActive === false) return { text: 'Pausada por Zipp', tone: 'warning' };
    if (new Date(c.startDate).getTime() > now) return { text: `Empieza el ${stateDay(c.startDate)}`, tone: 'info' };
    return { text: `En curso · termina el ${stateDay(c.endDate)}`, tone: 'success' };
  }
  const cap = capOf(c);
  if (c.cancelledAt) return { text: 'Cancelada', tone: 'muted' };
  if (cap > 0 && servedOf(c) >= cap) return { text: 'Llegó a su tope', tone: 'muted' };
  return { text: `Terminó el ${stateDay(c.endDate)}`, tone: 'muted' };
}
