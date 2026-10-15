import { money } from '../../lib/orderFlow';
import type { AutoForm, CodeForm } from '../../lib/promotions';
import { AmountPicker, Chip, Choice, StepHeading } from './ui';

/**
 * Paso 2: cuánto descuentas. El tipo es una elección entre dos tarjetas, no un
 * `<select>`, y cada tipo trae sus atajos. El tope del descuento solo existe en
 * un porcentaje: en un monto fijo el tope ya es el monto.
 */

interface Props {
  form: CodeForm | AutoForm;
  patch: (p: Partial<CodeForm & AutoForm>) => void;
  editing: boolean;
}

const PERCENT_PRESETS = [10, 15, 20, 25, 30];
const FIXED_PRESETS = [2000, 3000, 5000, 8000];
const CAP_PRESETS = [3000, 5000, 8000, 12000];

export default function AmountStep({ form, patch, editing }: Props) {
  const isPercent = form.type === 'percentage';

  return (
    <div className="space-y-6">
      <StepHeading title="¿Cuánto descuentas?" hint="Esto sale de tu liquidación, así que tú pones el límite." />

      <div className="grid gap-3 sm:grid-cols-2">
        <Choice
          selected={isPercent}
          disabled={editing && !isPercent}
          onClick={() => patch({ type: 'percentage', value: 20 })}
        >
          <span className="text-2xl font-semibold tabular">%</span>
          <span className="text-sm font-semibold">Porcentaje del pedido</span>
          <span className="text-xs text-[var(--color-text-secondary)]">Crece con el pedido. Ej.: 20% de 30.000 son 6.000.</span>
        </Choice>
        <Choice
          selected={!isPercent}
          disabled={editing && isPercent}
          onClick={() => patch({ type: 'fixed', value: 3000, maxDiscountAmount: 0 })}
        >
          <span className="text-2xl font-semibold tabular">$</span>
          <span className="text-sm font-semibold">Monto fijo</span>
          <span className="text-xs text-[var(--color-text-secondary)]">Los mismos pesos en cada pedido. Ej.: $3.000 menos.</span>
        </Choice>
      </div>
      {editing && (
        <p className="text-xs text-[var(--color-text-secondary)]">
          El tipo no se puede cambiar al editar: los pedidos que ya la usaron se calcularon con él.
        </p>
      )}

      {isPercent ? (
        <div className="space-y-3">
          <div className="flex items-end justify-between gap-4">
            <p className="text-xs font-semibold text-[var(--color-text-main)]">Porcentaje</p>
            <p className="text-4xl font-semibold tabular text-[var(--color-text-main)]" aria-live="polite">{form.value}%</p>
          </div>
          <input
            type="range"
            min={5}
            max={90}
            step={5}
            value={Math.min(90, Math.max(5, form.value))}
            onChange={(e) => patch({ value: Number(e.target.value) })}
            aria-label="Porcentaje de descuento"
            className="w-full cursor-pointer accent-[var(--color-primary)]"
          />
          <div className="flex flex-wrap gap-2" role="group" aria-label="Porcentajes habituales">
            {PERCENT_PRESETS.map((p) => (
              <Chip key={p} active={form.value === p} onClick={() => patch({ value: p })}>{p}%</Chip>
            ))}
          </div>
          <p className="text-xs text-[var(--color-text-secondary)]">Entre 1 y 90. Un descuento muy alto se come tu margen.</p>
        </div>
      ) : (
        <AmountPicker
          label="Pesos de descuento por pedido"
          value={form.value}
          onChange={(value) => patch({ value })}
          presets={FIXED_PRESETS}
        />
      )}

      {isPercent && (
        <AmountPicker
          label="Tope del descuento por pedido"
          hint={
            form.maxDiscountAmount > 0
              ? `Aunque el pedido sea enorme, nunca descuentas más de ${money(form.maxDiscountAmount)}.`
              : 'Sin tope: en un pedido grande el descuento también crece.'
          }
          value={form.maxDiscountAmount}
          onChange={(maxDiscountAmount) => patch({ maxDiscountAmount })}
          presets={CAP_PRESETS}
          zeroLabel="Sin tope"
        />
      )}
    </div>
  );
}
