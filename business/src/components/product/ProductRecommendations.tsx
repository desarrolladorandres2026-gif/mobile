import { AlertTriangle, CircleCheck, Info } from 'lucide-react';
import type { CheckTone, ProductCheck } from '../../lib/productChecks';

const TONE: Record<CheckTone, { icon: typeof Info; className: string }> = {
  warning: { icon: AlertTriangle, className: 'text-[var(--color-warning)]' },
  info: { icon: Info, className: 'text-[var(--color-text-secondary)]' },
  ok: { icon: CircleCheck, className: 'text-[var(--color-success)]' },
};

/** Lista plana de avisos: un icono de tono y una frase, sin cajas. */
export default function ProductRecommendations({ checks }: { checks: ProductCheck[] }) {
  if (checks.length === 0) return null;

  return (
    <ul className="space-y-2" aria-live="polite">
      {checks.map((check) => {
        const { icon: Icon, className } = TONE[check.tone];
        return (
          <li key={check.id} className="flex items-start gap-2 text-xs leading-relaxed text-[var(--color-text-main)]">
            <Icon className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${className}`} aria-hidden />
            {check.text}
          </li>
        );
      })}
    </ul>
  );
}
