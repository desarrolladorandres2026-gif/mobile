import type { ReactNode } from 'react';
import NumericInput from '../NumericInput';
import {
  CouponLogo, RatingLogo, PrepTimeLogo, PackageLogo, WalletLogo, StoreLogo, DashboardLogo, DeliveryLogo,
} from '../logos';
import type { TemplateLogoKey } from '../../lib/promotionTemplates';
import { money } from '../../lib/orderFlow';

/**
 * Piezas de los asistentes de Promociones y Publicidad. Las superficies
 * (`.promo-choice`, `.promo-chip`) viven en `index.css` y son exclusivas de esas dos pantallas.
 */

export const inputClass =
  'w-full px-3 py-2 rounded-md bg-[var(--color-surface)] border border-[var(--color-border)] text-sm text-[var(--color-text-main)] outline-none focus:border-[var(--color-primary)] disabled:opacity-50';

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label className="text-xs font-semibold text-[var(--color-text-main)]">{label}</label>
      {children}
      {hint && <p className="text-xs text-[var(--color-text-secondary)]">{hint}</p>}
    </div>
  );
}

export function TemplateLogo({ name, size = 44 }: { name: TemplateLogoKey; size?: number }) {
  const Logo = {
    coupon: CouponLogo, rating: RatingLogo, prep: PrepTimeLogo,
    package: PackageLogo, wallet: WalletLogo, store: StoreLogo,
    dashboard: DashboardLogo, delivery: DeliveryLogo,
  }[name];
  return <Logo size={size} />;
}

export function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" aria-pressed={active} onClick={onClick} className="promo-chip">
      {children}
    </button>
  );
}

export function Choice({
  selected, onClick, disabled, children,
}: { selected: boolean; onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <button type="button" aria-pressed={selected} disabled={disabled} onClick={onClick} className="promo-choice">
      {children}
    </button>
  );
}

export function StepHeading({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="space-y-1">
      <h3 className="text-lg font-semibold text-[var(--color-text-main)]">{title}</h3>
      {hint && <p className="text-xs text-[var(--color-text-secondary)]">{hint}</p>}
    </div>
  );
}

/**
 * Un número con atajos: fichas con las cifras habituales y, debajo, el campo
 * para cualquier otra. `zeroLabel` es lo que significa el cero (sin tope, sin
 * mínimo…) y se ofrece como una ficha más.
 */
export function AmountPicker({
  label, hint, value, onChange, presets, zeroLabel, format = money, suffix,
}: {
  label: string;
  hint?: string;
  value: number;
  onChange: (value: number) => void;
  presets: number[];
  zeroLabel?: string;
  format?: (value: number) => string;
  suffix?: string;
}) {
  return (
    <div className="space-y-2">
      <p className="text-xs font-semibold text-[var(--color-text-main)]">{label}</p>
      <div className="flex flex-wrap gap-2" role="group" aria-label={label}>
        {zeroLabel && (
          <Chip active={value === 0} onClick={() => onChange(0)}>{zeroLabel}</Chip>
        )}
        {presets.map((preset) => (
          <Chip key={preset} active={value === preset} onClick={() => onChange(preset)}>{format(preset)}</Chip>
        ))}
      </div>
      <div className="flex items-center gap-2 max-w-[14rem]">
        <NumericInput
          value={value}
          onValueChange={(d) => onChange(Number(d))}
          className={inputClass}
          aria-label={`${label}, otro valor`}
        />
        {suffix && <span className="text-xs text-[var(--color-text-secondary)] shrink-0">{suffix}</span>}
      </div>
      {hint && <p className="text-xs text-[var(--color-text-secondary)]">{hint}</p>}
    </div>
  );
}
