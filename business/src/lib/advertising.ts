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

/** Mañana hasta dentro de dos semanas: una campaña que empieza hoy no alcanza a revisarse. */
export const emptyDraft = (): AdDraft => ({
  campaignName: '',
  flyerUrl: '',
  startDate: localDay(1),
  endDate: localDay(15),
  pricingModel: 'cpm',
  cpmRate: 2000,
  cpcRate: 500,
  budget: 100000,
});

/**
 * Ideas de campaña listas para ajustar. Son datos, como las de promociones: el
 * servidor sigue validando y revisando todo. Las tarifas y los topes son
 * sugerencias de arranque, no una tabla de precios de Zipp; el tope manda,
 * porque es lo único que acota el gasto.
 */
export interface AdTemplate {
  id: string;
  title: string;
  blurb: string;
  logo: TemplateLogoKey;
  patch: Partial<AdDraft>;
  /** Días que dura, contados desde que empieza. */
  days: number;
  /** Cuántos días desde hoy empieza; `'weekend'` es el próximo viernes. */
  start: number | 'weekend';
}

export const AD_TEMPLATES: AdTemplate[] = [
  {
    id: 'seen',
    title: 'Que más gente me vea',
    blurb: 'Pagas por cada mil veces que tu anuncio sale en pantalla.',
    logo: 'rating',
    patch: { campaignName: 'Más visibilidad', pricingModel: 'cpm', cpmRate: 2000, budget: 100000 },
    days: 14,
    start: 1,
  },
  {
    id: 'visits',
    title: 'Que entren a mi tienda',
    blurb: 'Pagas solo cuando alguien toca el anuncio.',
    logo: 'store',
    patch: { campaignName: 'Visitas a mi tienda', pricingModel: 'cpc', cpcRate: 500, budget: 100000 },
    days: 14,
    start: 1,
  },
  {
    id: 'launch',
    title: 'Lanzamiento',
    blurb: 'Un mes de presencia para que el barrio sepa que abriste o que tienes algo nuevo.',
    logo: 'package',
    patch: { campaignName: 'Lanzamiento', pricingModel: 'cpm', cpmRate: 3000, budget: 200000 },
    days: 30,
    start: 1,
  },
  {
    id: 'weekend',
    title: 'Solo el fin de semana',
    blurb: 'De viernes a domingo, cuando más se pide a domicilio.',
    logo: 'delivery',
    patch: { campaignName: 'Fin de semana', pricingModel: 'cpm', cpmRate: 2500, budget: 100000 },
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

/** Días desde hoy hasta el próximo viernes, nunca antes de mañana. */
export const daysToNextFriday = (from: Date = new Date()): number => ((5 - from.getDay() + 7) % 7) || 7;

export function applyAdTemplate(template: AdTemplate, from: Date = new Date()): AdDraft {
  const start = template.start === 'weekend' ? daysToNextFriday(from) : template.start;
  return {
    ...emptyDraft(),
    ...template.patch,
    startDate: localDay(start, from),
    endDate: localDay(start + template.days, from),
  };
}

/** Atajos de duración a partir de la fecha de inicio elegida. */
export const AD_DURATIONS = [
  { days: 7, label: '1 semana' },
  { days: 14, label: '2 semanas' },
  { days: 30, label: '1 mes' },
] as const;

export const dayDiff = (from: string, to: string) =>
  Math.round((new Date(`${to}T00:00:00`).getTime() - new Date(`${from}T00:00:00`).getTime()) / 86_400_000);

export const addDays = (day: string, days: number) => {
  const [y, m, d] = day.split('-').map(Number);
  return localDay(days, new Date(y, m - 1, d));
};

export const AD_BUDGET_PRESETS = [50000, 100000, 200000, 500000];
export const CPM_PRESETS = [1500, 2000, 3000, 5000];
export const CPC_PRESETS = [300, 500, 800, 1200];

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

const HTTP_URL = /^https?:\/\/.+/i;
export const isFlyerUrl = (value: string) => HTTP_URL.test(value.trim());

/** Lo que falta en un paso, en el orden en que la pantalla lo pide; vacío si está bien. */
export function adProblem(step: AdStep, d: AdDraft): string {
  if (step === 'ad') {
    if (d.campaignName.trim().length < 3) return 'Ponle un nombre de al menos 3 letras a la campaña.';
    if (!isFlyerUrl(d.flyerUrl)) return 'Pega el enlace del flyer (empieza con https://).';
  }
  if (step === 'when') {
    if (!d.startDate || !d.endDate) return 'Elige cuándo empieza y cuándo termina.';
    if (dayDiff(d.startDate, d.endDate) <= 0) return 'La campaña tiene que terminar después de empezar.';
  }
  if (step === 'budget') {
    if (!rateOf(d)) return `Pon la tarifa ${d.pricingModel === 'cpm' ? 'por mil impresiones' : 'por clic'}.`;
    if (!d.budget) return 'Pon un tope de gasto: sin él estarías firmando un gasto abierto.';
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
