import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X, AlertCircle } from 'lucide-react';
import ProductMultiSelect from './ProductMultiSelect';
import DateRangeField from './DateRangeField';
import NumericInput from './NumericInput';
import { money } from '../lib/orderFlow';
import {
  discountLabel, maxCost,
  type AutoForm, type CodeForm, type Coupon,
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
 * Al final del formulario hay una vista previa en texto —lo que verá el
 * cliente y lo máximo que puede costarte— que se recalcula con cada tecla.
 * Es la pieza que faltaba: antes el comercio creaba la promoción a ciegas y
 * el costo aparecía en la liquidación.
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
    usageLimit: isCode ? codeForm.usageLimit : 0,
  });
  const previewValue = discountLabel(form.type, form.value);
  const minOrder = isCode ? codeForm.minOrderAmount : 0;
  const until = form.validUntil ? dateEs(form.validUntil) : null;

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
                    onChange={(e) => onCodeChange({ ...codeForm, code: e.target.value.toUpperCase() })}
                    maxLength={20}
                    placeholder="MARTES20"
                    disabled={editing}
                    className={inputClass}
                  />
                </Field>
                <Field label="Título" hint="Lo que ve en la lista">
                  <input
                    value={codeForm.title}
                    onChange={(e) => onCodeChange({ ...codeForm, title: e.target.value })}
                    maxLength={80}
                    placeholder="20% los martes"
                    className={inputClass}
                  />
                </Field>
                <Field label="Tipo">
                  <select
                    value={codeForm.type}
                    onChange={(e) => onCodeChange({ ...codeForm, type: e.target.value as Coupon['type'] })}
                    disabled={editing}
                    className={inputClass}
                  >
                    <option value="percentage">Porcentaje</option>
                    <option value="fixed">Monto fijo</option>
                    <option value="free_delivery">Envío gratis</option>
                  </select>
                </Field>
                {codeForm.type !== 'free_delivery' && (
                  <Field label={codeForm.type === 'percentage' ? 'Porcentaje' : 'Monto'} hint={codeForm.type === 'percentage' ? 'Entre 1 y 100' : 'En pesos'}>
                    <NumericInput
                      value={codeForm.value}
                      onValueChange={(d) => onCodeChange({ ...codeForm, value: Number(d) })}
                      className={inputClass}
                    />
                  </Field>
                )}
                <Field label="Pedido mínimo" hint="Cero: sin mínimo">
                  <NumericInput
                    value={codeForm.minOrderAmount}
                    onValueChange={(d) => onCodeChange({ ...codeForm, minOrderAmount: Number(d) })}
                    className={inputClass}
                  />
                </Field>
                <Field label="Válida hasta">
                  <input
                    type="date"
                    value={codeForm.validUntil}
                    onChange={(e) => onCodeChange({ ...codeForm, validUntil: e.target.value })}
                    className={inputClass}
                  />
                </Field>
              </div>

              <div className="border-t border-[var(--color-border)] pt-5 space-y-4">
                <h3 className="text-xs font-semibold text-[var(--color-text-secondary)]">Topes</h3>
                <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                  <Field label="Presupuesto máximo" hint="Cero: sin tope">
                    <NumericInput
                      value={codeForm.budgetLimit}
                      onValueChange={(d) => onCodeChange({ ...codeForm, budgetLimit: Number(d) })}
                      className={inputClass}
                    />
                  </Field>
                  <Field label="Usos totales" hint="Cero: ilimitado">
                    <NumericInput
                      value={codeForm.usageLimit}
                      onValueChange={(d) => onCodeChange({ ...codeForm, usageLimit: Number(d) })}
                      className={inputClass}
                    />
                  </Field>
                </div>
                {codeForm.budgetLimit > 0 && codeForm.usageLimit === 0 && (
                  <p className="text-xs font-semibold text-[var(--color-warning)]">
                    El presupuesto máximo solo frena de verdad si además pones un tope de usos: es el
                    que sí controla cuántas veces se cobra sin código.
                  </p>
                )}
              </div>
            </div>
          ) : (
            <div className="space-y-5">
              <Field label="Título" hint="Lo que verás en tu lista de promociones">
                <input
                  value={autoForm.title}
                  onChange={(e) => onAutoChange({ ...autoForm, title: e.target.value })}
                  maxLength={80}
                  placeholder="20% en hamburguesas"
                  className={inputClass}
                />
              </Field>
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                <Field label="Tipo">
                  <select
                    value={autoForm.type}
                    onChange={(e) => onAutoChange({ ...autoForm, type: e.target.value as 'percentage' | 'fixed' })}
                    className={inputClass}
                  >
                    <option value="percentage">Porcentaje</option>
                    <option value="fixed">Monto fijo</option>
                  </select>
                </Field>
                <Field label={autoForm.type === 'percentage' ? 'Porcentaje' : 'Monto'}>
                  <NumericInput
                    value={autoForm.value}
                    onValueChange={(d) => onAutoChange({ ...autoForm, value: Number(d) })}
                    className={inputClass}
                  />
                </Field>
                {autoForm.type === 'percentage' && (
                  <Field label="Tope del descuento" hint="En pesos. Cero: sin tope">
                    <NumericInput
                      value={autoForm.maxDiscountAmount}
                      onValueChange={(d) => onAutoChange({ ...autoForm, maxDiscountAmount: Number(d) })}
                      className={inputClass}
                    />
                  </Field>
                )}
                <Field label="Presupuesto máximo" hint="Cero: sin tope">
                  <NumericInput
                    value={autoForm.budgetLimit}
                    onValueChange={(d) => onAutoChange({ ...autoForm, budgetLimit: Number(d) })}
                    className={inputClass}
                  />
                </Field>
              </div>

              <DateRangeField
                from={autoForm.validFrom}
                to={autoForm.validUntil}
                onChangeFrom={(v) => onAutoChange({ ...autoForm, validFrom: v })}
                onChangeTo={(v) => onAutoChange({ ...autoForm, validUntil: v })}
              />

              <Field label="Productos en promoción" hint="Un producto solo puede estar en una promoción automática a la vez">
                <ProductMultiSelect
                  businessId={businessId}
                  selected={autoForm.productIds}
                  onChange={(ids) => onAutoChange({ ...autoForm, productIds: ids })}
                  coveredByOther={coveredByOther}
                />
              </Field>
            </div>
          )}

        </div>

        <aside className="xl:sticky xl:top-0 xl:self-start xl:border-l xl:border-[var(--color-border)] xl:pl-10">
          {/* ── Vista previa ── */}
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
                  until ? `Hasta el ${until}` : 'Sin fecha de fin todavía',
                ].filter(Boolean).join(' · ')}
              </p>
            </div>

            <div className="space-y-1">
              <h3 className="text-xs font-semibold text-[var(--color-text-secondary)]">
                Lo que te puede costar
              </h3>
              {cost !== null ? (
                <p className="text-sm font-semibold tabular text-[var(--color-text-main)]">
                  Hasta {money(cost)} de tu liquidación
                </p>
              ) : (
                <p className="text-xs font-semibold text-[var(--color-warning)]">
                  Sin techo: el costo crece con cada pedido que la use. Pon un presupuesto
                  {isCode ? ' o un tope de usos' : ''} para acotarlo.
                </p>
              )}
            </div>
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
