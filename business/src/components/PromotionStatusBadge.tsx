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

const TONE_CLASSES: Record<Tone, string> = {
  success: 'bg-[var(--color-success-bg)] text-[var(--color-success)]',
  info: 'bg-[var(--color-info-bg)] text-[var(--color-info)]',
  warning: 'bg-[var(--color-warning-bg)] text-[var(--color-warning)]',
  muted: 'bg-[var(--color-bg-alt)] text-[var(--color-text-muted)] border border-[var(--color-border)]',
};

export default function PromotionStatusBadge({ promotion }: { promotion: PromotionLike }) {
  const { label, tone } = resolve(promotion);
  return (
    <span
      className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-md ${TONE_CLASSES[tone]}`}
    >
      {label}
    </span>
  );
}
