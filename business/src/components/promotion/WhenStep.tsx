import DateRangeField from '../DateRangeField';
import ScheduleFields from '../ScheduleFields';
import type { AutoForm, CodeForm } from '../../lib/promotions';
import { QUICK_RANGES, SHIFTS, localDay, rangeDates } from '../../lib/promotionTemplates';
import { Chip, StepHeading } from './ui';

/**
 * Paso 3: cuándo corre. Atajos de vigencia desde hoy y franjas habituales;
 * los días y las horas exactas siguen siendo `ScheduleFields`, que ya conoce
 * la convención del servidor (0 = domingo, sin cruzar la medianoche).
 */

interface Props {
  form: CodeForm | AutoForm;
  patch: (p: Partial<CodeForm & AutoForm>) => void;
}

const daysBetween = (from: string, to: string) =>
  Math.round((new Date(`${to}T00:00:00`).getTime() - new Date(`${from}T00:00:00`).getTime()) / 86_400_000);

export default function WhenStep({ form, patch }: Props) {
  const startsToday = form.validFrom === localDay(0);

  return (
    <div className="space-y-7">
      <StepHeading title="¿Cuándo corre?" hint="Una promoción con fecha de fin se siente urgente: es la que más se usa." />

      <div className="space-y-3">
        <p className="text-xs font-semibold text-[var(--color-text-main)]">Desde hoy, durante</p>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Duración rápida">
          {QUICK_RANGES.map(({ days, label }) => (
            <Chip
              key={days}
              active={startsToday && !!form.validUntil && daysBetween(form.validFrom, form.validUntil) === days}
              onClick={() => patch(rangeDates(days))}
            >
              {label}
            </Chip>
          ))}
        </div>
        <DateRangeField
          from={form.validFrom}
          to={form.validUntil}
          onChangeFrom={(v) => patch({ validFrom: v })}
          onChangeTo={(v) => patch({ validUntil: v })}
          fromLabel="Empieza"
          toLabel="Termina"
        />
      </div>

      <div className="space-y-3">
        <p className="text-xs font-semibold text-[var(--color-text-main)]">
          Días y horario <span className="font-normal text-[var(--color-text-secondary)]">(opcional)</span>
        </p>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Franjas habituales">
          {SHIFTS.map((shift) => (
            <Chip
              key={shift.label}
              active={form.validFromTime === shift.from && form.validUntilTime === shift.until}
              onClick={() => patch({ validFromTime: shift.from, validUntilTime: shift.until })}
            >
              {shift.label}
            </Chip>
          ))}
        </div>
        <ScheduleFields value={form} onChange={(next) => patch(next)} />
      </div>
    </div>
  );
}
