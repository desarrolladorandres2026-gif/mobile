/**
 * Rango de fechas, sin caja: dos campos planos lado a lado con su propia
 * etiqueta, validados contra su propio par (fin después de inicio) — el
 * mismo patrón visual que ya usa el resto del panel (`Field` de las páginas
 * de este dominio), sin fondo ni borde decorativo alrededor del par.
 */

const INPUT =
  'w-full px-3 py-2 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] text-sm text-[var(--color-text-main)] outline-none focus:border-[var(--color-primary)]';

export default function DateRangeField({
  from,
  to,
  onChangeFrom,
  onChangeTo,
  fromLabel = 'Empieza',
  toLabel = 'Termina',
}: {
  from: string;
  to: string;
  onChangeFrom: (value: string) => void;
  onChangeTo: (value: string) => void;
  fromLabel?: string;
  toLabel?: string;
}) {
  const invalid = !!from && !!to && new Date(to) <= new Date(from);

  return (
    <div className="grid grid-cols-2 gap-3">
      <div className="space-y-1.5">
        <label className="text-xs font-bold text-[var(--color-text-main)]">{fromLabel}</label>
        <input type="date" value={from} onChange={(e) => onChangeFrom(e.target.value)} className={INPUT} />
      </div>
      <div className="space-y-1.5">
        <label className="text-xs font-bold text-[var(--color-text-main)]">{toLabel}</label>
        <input type="date" value={to} onChange={(e) => onChangeTo(e.target.value)} className={INPUT} />
        {invalid && (
          <p className="text-[10px] font-semibold text-[var(--color-danger)]">
            Debe ser posterior a la fecha de inicio.
          </p>
        )}
      </div>
    </div>
  );
}
