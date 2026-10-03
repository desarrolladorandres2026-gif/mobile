/**
 * Estado de una promoción, resuelto igual que lo hace el cobro.
 *
 * El backend ya manda `availability` (`couponAvailability()`, la misma
 * función que decide si un cupón aplica al cobrar) — este componente solo
 * traduce ese estado a las cuatro etiquetas que el comercio entiende:
 * Activa, Programada, Finalizada, Agotada. `isActive` desactivado manda
 * sobre cualquier otra cosa.
 */

interface PromotionLike {
  isActive: boolean;
  validUntil: string | Date;
  budgetLimit?: number;
  budgetSpent?: number;
  usageLimit?: number;
  usedCount?: number;
  availability?: { state: 'active' | 'scheduled' | 'exhausted' };
}

type Tone = 'success' | 'info' | 'warning' | 'muted';

function resolve(promotion: PromotionLike): { label: string; tone: Tone } {
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

const TONE_CLASSES: Record<Tone, { text: string; dot: string }> = {
  success: { text: "text-[var(--color-text-secondary)]", dot: "bg-[var(--color-success)]" },
  info: { text: "text-[var(--color-text-secondary)]", dot: "bg-[var(--color-info)]" },
  warning: { text: "text-[var(--color-text-secondary)]", dot: "bg-[var(--color-warning)]" },
  muted: { text: "text-[var(--color-text-secondary)]", dot: "bg-[var(--color-text-secondary)]" },
};

export default function PromotionStatusBadge({ promotion }: { promotion: PromotionLike }) {
  const { label, tone } = resolve(promotion);
  const { text, dot } = TONE_CLASSES[tone];
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs ${text}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${dot}`} />
      {label}
    </span>
  );
}
