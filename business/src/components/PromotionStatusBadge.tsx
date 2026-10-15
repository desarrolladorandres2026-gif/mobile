/**
 * Estado de una promoción, resuelto igual que lo hace el cobro.
 *
 * El backend ya manda `availability` (`couponAvailability()`, la misma
 * función que decide si un cupón aplica al cobrar) — este componente solo
 * traduce ese estado a las cuatro etiquetas que el comercio entiende:
 * Activa, Programada, Finalizada, Agotada. `isActive` desactivado manda
 * sobre cualquier otra cosa.
 */

import { resolveStatus, type PromotionLike, type Tone } from '../lib/promotions';

const TONE_CLASSES: Record<Tone, { text: string; dot: string }> = {
  success: { text: "text-[var(--color-text-secondary)]", dot: "bg-[var(--color-success)]" },
  info: { text: "text-[var(--color-text-secondary)]", dot: "bg-[var(--color-info)]" },
  warning: { text: "text-[var(--color-text-secondary)]", dot: "bg-[var(--color-warning)]" },
  muted: { text: "text-[var(--color-text-secondary)]", dot: "bg-[var(--color-text-secondary)]" },
};

export default function PromotionStatusBadge({ promotion }: { promotion: PromotionLike }) {
  const { label, tone } = resolveStatus(promotion);
  const { text, dot } = TONE_CLASSES[tone];
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs ${text}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${dot}`} />
      {label}
    </span>
  );
}
