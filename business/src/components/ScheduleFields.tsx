import { scheduleError } from '../lib/schedule';

/**
 * Días y franja horaria de una promoción o del envío gratis.
 *
 * Es un solo componente para los dos sitios que lo necesitan (la promoción y
 * el envío gratis del perfil) porque los dos hablan con la misma regla del
 * servidor (`couponAvailability`): días de la semana con **0 = domingo**, y
 * una franja `HH:mm` que no puede cruzar la medianoche.
 *
 * Antes el perfil guardaba el índice de una lista que empezaba en lunes: al
 * marcar «L» llegaba un 0, que para el servidor es domingo, y el envío gratis
 * del lunes se encendía los domingos. El valor que viaja es ahora el número
 * del día, no la posición en pantalla.
 */

export interface ScheduleValue {
  /** 0 = domingo … 6 = sábado. Vacío: todos los días. */
  validDays: number[];
  /** `HH:mm`. Vacío en las dos: todo el día. */
  validFromTime: string;
  validUntilTime: string;
}

/** Lunes primero, como se lee; el `value` es el que entiende el servidor. */
const DAYS: Array<{ value: number; short: string; label: string }> = [
  { value: 1, short: 'L', label: 'Lunes' },
  { value: 2, short: 'M', label: 'Martes' },
  { value: 3, short: 'X', label: 'Miércoles' },
  { value: 4, short: 'J', label: 'Jueves' },
  { value: 5, short: 'V', label: 'Viernes' },
  { value: 6, short: 'S', label: 'Sábado' },
  { value: 0, short: 'D', label: 'Domingo' },
];

const TIME_INPUT =
  'px-2 py-1 rounded-md bg-[var(--color-surface)] border border-[var(--color-border)] text-xs ' +
  'text-[var(--color-text-main)] outline-none focus:border-[var(--color-primary)]';

export default function ScheduleFields({
  value,
  onChange,
  what = 'promoción',
}: {
  value: ScheduleValue;
  onChange: (next: ScheduleValue) => void;
  /** Para los textos de accesibilidad: «Envío gratis», «promoción»… */
  what?: string;
}) {
  const error = scheduleError(value);

  const toggle = (day: number) =>
    onChange({
      ...value,
      validDays: value.validDays.includes(day)
        ? value.validDays.filter((d) => d !== day)
        : [...value.validDays, day],
    });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex gap-1" role="group" aria-label={`Días en que corre la ${what}`}>
          {DAYS.map((day) => {
            const active = value.validDays.includes(day.value);
            return (
              <button
                key={day.value}
                type="button"
                title={day.label}
                aria-label={day.label}
                aria-pressed={active}
                onClick={() => toggle(day.value)}
                className={`w-7 h-7 rounded-full text-[10px] font-semibold cursor-pointer transition-colors ${
                  active
                    ? 'bg-[var(--color-primary)] hover:bg-[var(--color-primary-light)] text-[var(--zipp-obsidian)]'
                    : 'bg-[var(--color-surface)] border border-[var(--color-border)] text-[var(--color-text-secondary)]'
                }`}
              >
                {day.short}
              </button>
            );
          })}
        </div>
        <span className="text-xs text-[var(--color-text-secondary)]">Sin días marcados: todos</span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input
          type="time"
          value={value.validFromTime}
          onChange={(e) => onChange({ ...value, validFromTime: e.target.value })}
          className={TIME_INPUT}
          aria-label={`Hora de inicio de la ${what}`}
        />
        <span className="text-xs text-[var(--color-text-secondary)]">a</span>
        <input
          type="time"
          value={value.validUntilTime}
          onChange={(e) => onChange({ ...value, validUntilTime: e.target.value })}
          className={TIME_INPUT}
          aria-label={`Hora de fin de la ${what}`}
        />
        <span className="text-xs text-[var(--color-text-secondary)]">Vacío: todo el día</span>
      </div>

      {error && <p className="text-[11px] font-semibold text-[var(--color-danger)]">{error}</p>}
    </div>
  );
}
