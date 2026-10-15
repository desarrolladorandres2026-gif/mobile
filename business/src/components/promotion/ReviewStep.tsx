import { Pencil } from 'lucide-react';
import { discountLabel, promotionSummary, type AutoForm, type CodeForm } from '../../lib/promotions';
import { money } from '../../lib/orderFlow';
import { StepHeading } from './ui';

/**
 * Paso 5: la promoción contada en una frase, con un «Cambiar» por sección. La
 * simulación con las reglas reales vive en la columna derecha, a la vista en
 * todos los pasos; aquí solo se confirma lo que el comercio va a firmar.
 */

const dayEs = (value: string) =>
  value ? new Date(`${value}T00:00:00`).toLocaleDateString('es-CO', { day: 'numeric', month: 'short' }) : '';

export type ReviewJump = 'amount' | 'when' | 'target';

interface Props {
  form: CodeForm | AutoForm;
  isCode: boolean;
  editing: boolean;
  onJump: (step: ReviewJump) => void;
}

function Row({ label, value, step, onJump }: { label: string; value: string; step: ReviewJump; onJump: (s: ReviewJump) => void }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-[var(--color-border)] py-3">
      <div className="min-w-0">
        <p className="text-[11px] font-semibold text-[var(--color-text-secondary)]">{label}</p>
        <p className="text-sm text-[var(--color-text-main)]">{value}</p>
      </div>
      <button
        type="button"
        onClick={() => onJump(step)}
        className="flex shrink-0 cursor-pointer items-center gap-1.5 text-xs font-semibold text-[var(--color-primary)] hover:underline"
      >
        <Pencil className="h-3.5 w-3.5" /> Cambiar
      </button>
    </div>
  );
}

export default function ReviewStep({ form, isCode, editing, onJump }: Props) {
  const code = isCode ? (form as CodeForm) : null;
  const auto = isCode ? null : (form as AutoForm);

  const hours = form.validFromTime && form.validUntilTime ? `${form.validFromTime} a ${form.validUntilTime}` : 'Todo el día';
  const days = form.validDays.length > 0 ? `${form.validDays.length} día(s) de la semana` : 'Todos los días';
  const limits = [
    form.budgetLimit > 0 ? `Presupuesto ${money(form.budgetLimit)}` : null,
    form.usageLimit > 0 ? `${form.usageLimit} usos` : null,
    code && !code.firstOrderOnly && code.perUserLimit > 0 ? `${code.perUserLimit} por cliente` : null,
  ].filter(Boolean);

  return (
    <div className="space-y-5">
      <StepHeading title={editing ? 'Revisa los cambios' : 'Todo listo. Revísalo una vez'} />
      <p className="text-base leading-relaxed text-[var(--color-text-main)]">
        {promotionSummary(form, !isCode)}
      </p>

      <div>
        <Row label="Descuento" value={`${discountLabel(form.type, form.value)}${form.type === 'percentage' && form.maxDiscountAmount > 0 ? `, tope ${money(form.maxDiscountAmount)}` : ''}`} step="amount" onJump={onJump} />
        <Row label="Cuándo" value={`${dayEs(form.validFrom) || 'Hoy'} → ${dayEs(form.validUntil) || 'sin fecha'} · ${days} · ${hours}`} step="when" onJump={onJump} />
        <Row
          label={isCode ? 'Código y título' : 'Productos y título'}
          value={`${form.title.trim() || 'Sin título'} · ${code ? code.code.trim() || 'sin código' : `${auto?.productIds.length ?? 0} producto(s)`}${form.firstOrderOnly ? ' · solo primer pedido' : ''}`}
          step="target"
          onJump={onJump}
        />
        <Row label="Topes" value={limits.length > 0 ? limits.join(' · ') : 'Sin topes'} step="target" onJump={onJump} />
      </div>
    </div>
  );
}
