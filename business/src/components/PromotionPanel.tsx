import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X, AlertCircle } from 'lucide-react';
import ProductMultiSelect from './ProductMultiSelect';
import DateRangeField from './DateRangeField';
import NumericInput from './NumericInput';
import ScheduleFields from './ScheduleFields';
import PromotionSimulation from './PromotionSimulation';
import { money } from '../lib/orderFlow';
import {
  discountLabel, maxCost, previewDraft,
  type AutoForm, type CodeForm,
} from '../lib/promotions';

/**
 * Pantalla completa para crear o editar una promoción. Ocupa el área de
 * contenido: bajo la cabecera (h-12) y junto a la barra lateral (w-52, fija
 * desde lg), igual que `OrderDetailPanel`.
 *
 * Va en un portal: el contenedor de la página anima con `transform`, y un
 * `fixed` dentro de un ancestro transformado se ancla a ese ancestro y no
 * a la ventana.
 *
 * Al lado del formulario hay dos cosas distintas. Arriba, cómo lo leerá el
 * cliente. Debajo, una simulación con las reglas reales del servidor (el mismo
 * motor que cobra los pedidos): cuánto paga el cliente, cuánto financias tú y
 * cuánto te queda, con avisos cuando la combinación no se podría pagar. Nada
 * de eso crea o consume nada.
 *
 * Solo se ofrece lo que el servidor acepta. Un cupón de envío gratis no es de
 * un comercio (su envío gratis se configura en el perfil), el tope de un
 * descuento solo existe en un porcentaje, y «primer pedido» fija un uso por
 * cliente: mostrar lo contrario sería prometer algo que el backend rechaza.
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

const dateEs = (value: string) => new Date(value).toLocaleDateString('es-CO', { day: 'numeric', month: 'long' });

interface Props {
  mode: 'code' | 'auto';
  editing: boolean;
  onModeChange: (mode: 'code' | 'auto') => void;
  codeForm: CodeForm;
  onCodeChange: (form: CodeForm) => void;
  autoForm: AutoForm;
  onAutoChange: (form: AutoForm) => void;
  businessId: string;
  coveredByOther: Map<string, { couponId: string; title: string; validUntil: string }>;
  saving: boolean;
  error: string;
  onSubmit: () => void;
  onClose: () => void;
}

export default function PromotionPanel({
  mode, editing, onModeChange, codeForm, onCodeChange, autoForm, onAutoChange,
  businessId, coveredByOther, saving, error, onSubmit, onClose,
}: Props) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const isCode = mode === 'code';
  const form = isCode ? codeForm : autoForm;
  const title = form.title.trim();

  // ── Vista previa ──
  const cost = maxCost({
    type: form.type,
    value: form.value,
    budgetLimit: form.budgetLimit,
    usageLimit: form.usageLimit,
    maxDiscountAmount: form.maxDiscountAmount,
  });
  const previewValue = discountLabel(form.type, form.value);
  const minOrder = isCode ? codeForm.minOrderAmount : 0;
  const until = form.validUntil ? dateEs(form.validUntil) : null;

  // Lo mínimo para que el servidor pueda simular algo con sentido.
  const simulationReady = form.value > 0 && !!form.validUntil;

  const patchCode = (patch: Partial<CodeForm>) => onCodeChange({ ...codeForm, ...patch });
  const patchAuto = (patch: Partial<AutoForm>) => onAutoChange({ ...autoForm, ...patch });

  /** Los mismos controles para las dos formas: topes, primer pedido y horario. */
  const sharedFields = (value: CodeForm | AutoForm, patch: (p: Partial<CodeForm & AutoForm>) => void) => (
    <>
      <DateRangeField
        from={value.validFrom}
        to={value.validUntil}
        onChangeFrom={(v) => patch({ validFrom: v })}
        onChangeTo={(v) => patch({ validUntil: v })}
        fromLabel="Empieza"
        toLabel="Termina"
      />

      <div className="space-y-2">
        <p className="text-xs font-semibold text-[var(--color-text-main)]">
          Días y horario <span className="font-normal text-[var(--color-text-secondary)]">(opcional)</span>
        </p>
        <ScheduleFields
          value={value}
          onChange={(next) => patch(next)}
        />
      </div>

      <label className="flex items-start gap-3 cursor-pointer">
        <input
          type="checkbox"
          checked={value.firstOrderOnly}
          onChange={(e) => patch({ firstOrderOnly: e.target.checked })}
          className="accent-[var(--color-primary)] cursor-pointer mt-0.5"
        />
        <span className="space-y-0.5">
          <span className="block text-xs font-semibold text-[var(--color-text-main)]">Solo para el primer pedido</span>
          <span className="block text-xs text-[var(--color-text-secondary)]">
            Se le da a quien nunca ha hecho un pedido en Zipp (los cancelados no cuentan) y solo una vez.
            {!isCode && ' Al ser automática, no aparece en tu carta: se aplica al pagar.'}
          </span>
        </span>
      </label>

      <div className="border-t border-[var(--color-border)] pt-5 space-y-4">
        <h3 className="text-xs font-semibold text-[var(--color-text-secondary)]">Topes</h3>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <Field
            label="Presupuesto máximo"
            hint="Lo máximo que sale de tu liquidación. Cuando el siguiente pedido ya no cabe, la promoción deja de aplicarse. Cero: sin tope."
          >
            <NumericInput
              value={value.budgetLimit}
              onValueChange={(d) => patch({ budgetLimit: Number(d) })}
              className={inputClass}
            />
          </Field>
          <Field label="Usos totales" hint="Cero: ilimitado">
            <NumericInput
              value={value.usageLimit}
              onValueChange={(d) => patch({ usageLimit: Number(d) })}
              className={inputClass}
            />
          </Field>
          {isCode && !value.firstOrderOnly && (
            <Field label="Usos por cliente" hint="Cero: ilimitado">
              <NumericInput
                value={codeForm.perUserLimit}
                onValueChange={(d) => patchCode({ perUserLimit: Number(d) })}
                className={inputClass}
              />
            </Field>
          )}
        </div>
      </div>
    </>
  );

  return createPortal(
    <div
      role="dialog"
      aria-label={editing ? 'Editar promoción' : 'Nueva promoción'}
      className="fixed bottom-0 left-0 right-0 top-12 z-30 overflow-y-auto bg-[var(--color-bg)] px-5 py-5 lg:left-52 lg:px-8 lg:py-6"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="page-title">
            {editing ? 'Editar promoción' : 'Nueva promoción'}
          </h2>
          <p className="text-xs text-[var(--color-text-secondary)] mt-1.5">
            {isCode
              ? 'El cliente escribe el código en el carrito y el descuento se aplica al pedido.'
              : 'Sin código: se aplica sola cuando el carrito trae alguno de los productos elegidos.'}
          </p>

        </div>
        <button
          type="button"
          onClick={onClose}
          className="flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-xs font-medium text-[var(--color-text-main)] hover:bg-[var(--color-surface-hover)]"
        >
          <X className="h-4 w-4" /> Volver a promociones
        </button>
      </div>

      <div className="mt-6 grid gap-x-10 gap-y-8 pb-8 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="space-y-8 min-w-0">
          {!editing && (
            <div role="tablist" aria-label="Tipo de promoción" className="flex gap-6 border-b border-[var(--color-border)]">
              {([['code', 'Con código'], ['auto', 'Automática por productos']] as const).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  role="tab"
                  aria-selected={mode === value}
                  onClick={() => onModeChange(value)}
                  className={`-mb-px pb-2.5 text-xs font-semibold border-b-2 cursor-pointer transition-colors ${
                    mode === value
                      ? 'border-[var(--color-primary)] text-[var(--color-primary)]'
                      : 'border-transparent text-[var(--color-text-secondary)] hover:text-[var(--color-text-main)]'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
          {isCode ? (
            <div className="space-y-5">
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                <Field label="Código" hint="Lo que el cliente escribe">
                  <input
                    value={codeForm.code}
                    onChange={(e) => patchCode({ code: e.target.value.toUpperCase() })}
                    maxLength={20}
                    placeholder="MARTES20"
                    disabled={editing}
                    className={inputClass}
                  />
                </Field>
                <Field label="Título" hint="Lo que ve en la lista">
                  <input
                    value={codeForm.title}
                    onChange={(e) => patchCode({ title: e.target.value })}
                    maxLength={80}
                    placeholder="20% los martes"
                    className={inputClass}
                  />
                </Field>
                <Field label="Tipo">
                  <select
                    value={codeForm.type}
                    onChange={(e) => patchCode({ type: e.target.value as CodeForm['type'] })}
                    disabled={editing}
                    className={inputClass}
                  >
                    <option value="percentage">Porcentaje</option>
                    <option value="fixed">Monto fijo</option>
                  </select>
                </Field>
                <Field
                  label={codeForm.type === 'percentage' ? 'Porcentaje' : 'Monto'}
                  hint={codeForm.type === 'percentage' ? 'Entre 1 y 90' : 'En pesos'}
                >
                  <NumericInput
                    value={codeForm.value}
                    onValueChange={(d) => patchCode({ value: Number(d) })}
                    className={inputClass}
                  />
                </Field>
                {codeForm.type === 'percentage' && (
                  <Field label="Tope del descuento" hint="En pesos. Cero: sin tope">
                    <NumericInput
                      value={codeForm.maxDiscountAmount}
                      onValueChange={(d) => patchCode({ maxDiscountAmount: Number(d) })}
                      className={inputClass}
                    />
                  </Field>
                )}
                <Field label="Pedido mínimo" hint="Cero: sin mínimo">
                  <NumericInput
                    value={codeForm.minOrderAmount}
                    onValueChange={(d) => patchCode({ minOrderAmount: Number(d) })}
                    className={inputClass}
                  />
                </Field>
              </div>

              {sharedFields(codeForm, (p) => patchCode(p))}
            </div>
          ) : (
            <div className="space-y-5">
              <Field label="Título" hint="Lo que verás en tu lista de promociones">
                <input
                  value={autoForm.title}
                  onChange={(e) => patchAuto({ title: e.target.value })}
                  maxLength={80}
                  placeholder="20% en hamburguesas"
                  className={inputClass}
                />
              </Field>
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                <Field label="Tipo">
                  <select
                    value={autoForm.type}
                    onChange={(e) => patchAuto({ type: e.target.value as AutoForm['type'] })}
                    disabled={editing}
                    className={inputClass}
                  >
                    <option value="percentage">Porcentaje</option>
                    <option value="fixed">Monto fijo</option>
                  </select>
                </Field>
                <Field label={autoForm.type === 'percentage' ? 'Porcentaje' : 'Monto'} hint={autoForm.type === 'percentage' ? 'Entre 1 y 90' : 'En pesos'}>
                  <NumericInput
                    value={autoForm.value}
                    onValueChange={(d) => patchAuto({ value: Number(d) })}
                    className={inputClass}
                  />
                </Field>
                {autoForm.type === 'percentage' && (
                  <Field label="Tope del descuento" hint="En pesos. Cero: sin tope">
                    <NumericInput
                      value={autoForm.maxDiscountAmount}
                      onValueChange={(d) => patchAuto({ maxDiscountAmount: Number(d) })}
                      className={inputClass}
                    />
                  </Field>
                )}
              </div>

              {sharedFields(autoForm, (p) => patchAuto(p))}

              <Field label="Productos en promoción" hint="Un producto solo puede estar en una promoción automática a la vez">
                <ProductMultiSelect
                  businessId={businessId}
                  selected={autoForm.productIds}
                  onChange={(ids) => patchAuto({ productIds: ids })}
                  coveredByOther={coveredByOther}
                />
              </Field>
            </div>
          )}

        </div>

        <aside className="xl:sticky xl:top-0 xl:self-start xl:border-l xl:border-[var(--color-border)] xl:pl-10">
          <div className="space-y-6">
            <div className="space-y-1.5">
              <h3 className="text-xs font-semibold text-[var(--color-text-secondary)]">
                Así lo verá el cliente
              </h3>
              <p className="text-lg font-semibold tabular text-[var(--color-text-main)]">{previewValue}</p>
              <p className="text-sm font-semibold text-[var(--color-text-main)]">{title || 'Sin título todavía'}</p>
              <p className="text-xs text-[var(--color-text-secondary)]">
                {[
                  isCode ? (codeForm.code.trim() ? `Código ${codeForm.code.trim()}` : 'Sin código todavía') : `${autoForm.productIds.length} producto(s), se aplica sola`,
                  minOrder > 0 ? `Pedido mínimo ${money(minOrder)}` : null,
                  form.firstOrderOnly ? 'Solo primer pedido' : null,
                  until ? `Hasta el ${until}` : 'Sin fecha de fin todavía',
                ].filter(Boolean).join(' · ')}
              </p>
            </div>

            <div className="space-y-1">
              <h3 className="text-xs font-semibold text-[var(--color-text-secondary)]">
                Lo máximo que te puede costar
              </h3>
              {cost !== null ? (
                <p className="text-sm font-semibold tabular text-[var(--color-text-main)]">
                  Hasta {money(cost)} de tu liquidación
                </p>
              ) : (
                <p className="text-xs font-semibold text-[var(--color-warning)]">
                  Sin techo: el costo crece con cada pedido que la use. Pon un presupuesto
                  {form.type === 'fixed' || form.maxDiscountAmount > 0 ? ' o un tope de usos' : ' o un tope del descuento y de usos'} para acotarlo.
                </p>
              )}
            </div>

            <PromotionSimulation
              businessId={businessId}
              draft={previewDraft(form, !isCode)}
              ready={simulationReady}
            />
          </div>
        </aside>
      </div>

      <div className="sticky -bottom-5 -mx-5 border-t border-[var(--color-border)] bg-[var(--color-bg)] px-5 py-3 lg:-bottom-6 lg:-mx-8 lg:px-8 space-y-3">
        {error && (
          <p className="flex items-start gap-2 text-xs font-semibold text-[var(--color-danger)]">
            <AlertCircle className="w-4 h-4 shrink-0" />
            {error}
          </p>
        )}
        <div className="flex items-center justify-end gap-3">
          <button type="button" onClick={onClose} className="px-3 py-2 text-xs font-semibold text-[var(--color-text-secondary)] hover:text-[var(--color-text-main)] cursor-pointer">
            Cancelar
          </button>
          <button
            type="button"
            onClick={onSubmit}
            disabled={saving}
            className="px-4 py-2 rounded-md bg-[var(--color-primary)] text-[var(--zipp-obsidian)] font-semibold text-xs hover:bg-[var(--color-primary-light)] transition-colors cursor-pointer disabled:opacity-60"
          >
            {saving ? 'Guardando…' : editing ? 'Guardar cambios' : 'Crear promoción'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
