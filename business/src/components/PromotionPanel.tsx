import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, AlertCircle } from 'lucide-react';
import PromotionSimulation from './PromotionSimulation';
import TemplateStep from './promotion/TemplateStep';
import AmountStep from './promotion/AmountStep';
import WhenStep from './promotion/WhenStep';
import TargetStep from './promotion/TargetStep';
import ReviewStep, { type ReviewJump } from './promotion/ReviewStep';
import CouponTicket from './promotion/CouponTicket';
import { money } from '../lib/orderFlow';
import { scheduleError } from '../lib/schedule';
import { applyTemplate, type PromotionTemplate } from '../lib/promotionTemplates';
import { maxCost, previewDraft, type AutoForm, type CodeForm } from '../lib/promotions';

/**
 * Pantalla completa para crear o editar una promoción, como asistente de cinco
 * pasos: idea, descuento, cuándo, a quién y revisión. Ocupa el área de
 * contenido: bajo la cabecera (h-12) y junto a la barra lateral (w-52, fija
 * desde lg), igual que `OrderDetailPanel`.
 *
 * Va en un portal: el contenedor de la página anima con `transform`, y un
 * `fixed` dentro de un ancestro transformado se ancla a ese ancestro y no
 * a la ventana.
 *
 * El estado no es del asistente: los formularios (`codeForm` / `autoForm`)
 * siguen viviendo en la página, que es quien los envía. Aquí solo se editan,
 * así que crear, editar y enviar siguen siendo los mismos de siempre.
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
 *
 * El botón principal nunca se apaga: si falta algo, el error dice qué y lleva
 * al paso donde está.
 */

export type WizardStep = 'idea' | 'amount' | 'when' | 'target' | 'review';

type Mode = 'code' | 'auto';
type Shared = CodeForm | AutoForm;
type Patch = Partial<CodeForm & AutoForm>;

interface Props {
  mode: Mode;
  editing: boolean;
  initialStep: WizardStep;
  onModeChange: (mode: Mode) => void;
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

const CREATE_STEPS: WizardStep[] = ['idea', 'amount', 'when', 'target', 'review'];
const EDIT_STEPS: WizardStep[] = ['amount', 'when', 'target', 'review'];

/** Lo que dice el servidor de cada paso, para validar antes de avanzar. */
function problem(step: WizardStep, form: Shared, isCode: boolean): string {
  if (step === 'amount') {
    if (!(form.value > 0)) return 'Pon cuánto descuentas.';
    if (form.type === 'percentage' && form.value > 90) return 'El porcentaje máximo es 90.';
  }
  if (step === 'when') {
    if (!form.validFrom || !form.validUntil) return 'Elige desde y hasta cuándo corre la promoción.';
    if (new Date(form.validUntil) <= new Date(form.validFrom)) return 'La promoción tiene que terminar después de empezar.';
    return scheduleError(form);
  }
  if (step === 'target') {
    if (form.title.trim().length < 3) return 'Ponle un título de al menos 3 letras.';
    if (isCode && (form as CodeForm).code.trim().length < 3) return 'El código necesita al menos 3 caracteres.';
    if (!isCode && (form as AutoForm).productIds.length === 0) return 'Elige al menos un producto para la promoción.';
  }
  return '';
}

/** Lo que comparten las dos formas, para no perderlo al cambiar de una a otra. */
const sharedOf = (f: Shared): Patch => ({
  title: f.title, type: f.type, value: f.value, maxDiscountAmount: f.maxDiscountAmount,
  budgetLimit: f.budgetLimit, usageLimit: f.usageLimit, firstOrderOnly: f.firstOrderOnly,
  validFrom: f.validFrom, validUntil: f.validUntil, validDays: f.validDays,
  validFromTime: f.validFromTime, validUntilTime: f.validUntilTime,
});

export default function PromotionPanel({
  mode, editing, initialStep, onModeChange, codeForm, onCodeChange, autoForm, onAutoChange,
  businessId, coveredByOther, saving, error, onSubmit, onClose,
}: Props) {
  const steps = editing ? EDIT_STEPS : CREATE_STEPS;
  const [step, setStep] = useState<WizardStep>(editing && initialStep === 'idea' ? 'review' : initialStep);
  const [maxIdx, setMaxIdx] = useState(editing ? steps.length - 1 : Math.max(0, steps.indexOf(initialStep)));
  const [localError, setLocalError] = useState('');
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const isCode = mode === 'code';
  const form: Shared = isCode ? codeForm : autoForm;
  const idx = steps.indexOf(step);

  const patchCode = (patch: Patch) => onCodeChange({ ...codeForm, ...patch } as CodeForm);
  const patchAuto = (patch: Patch) => onAutoChange({ ...autoForm, ...patch } as AutoForm);
  const patch = isCode ? patchCode : patchAuto;

  const move = (to: WizardStep) => {
    setLocalError('');
    setStep(to);
    setMaxIdx((m) => Math.max(m, steps.indexOf(to)));
    scroller.current?.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const next = () => {
    const msg = problem(step, form, isCode);
    if (msg) { setLocalError(msg); return; }
    move(steps[idx + 1]);
  };

  const submit = () => {
    for (const s of ['amount', 'when', 'target'] as const) {
      const msg = problem(s, form, isCode);
      if (msg) { move(s); setLocalError(msg); return; }
    }
    setLocalError('');
    onSubmit();
  };

  const pickTemplate = (template: PromotionTemplate) => {
    const applied = applyTemplate(template, { productIds: autoForm.productIds });
    onModeChange(applied.mode);
    onCodeChange(applied.codeForm);
    onAutoChange(applied.autoForm);
    move('amount');
  };

  const switchMode = (to: Mode) => {
    if (to === mode) return;
    if (to === 'code') onCodeChange({ ...codeForm, ...sharedOf(form) } as CodeForm);
    else onAutoChange({ ...autoForm, ...sharedOf(form) } as AutoForm);
    onModeChange(to);
  };

  // ── Vista previa ──
  const cost = maxCost(form);
  const simulationReady = form.value > 0 && !!form.validUntil;
  const showAside = step !== 'idea';
  const shown = localError || error;

  const labels: Record<WizardStep, string> = {
    idea: 'Idea', amount: 'Descuento', when: 'Cuándo', target: isCode ? 'Código' : 'Productos', review: 'Listo',
  };
  const isLast = idx === steps.length - 1;

  return createPortal(
    <div
      ref={scroller}
      role="dialog"
      aria-label={editing ? 'Editar promoción' : 'Nueva promoción'}
      className="fixed bottom-0 left-0 right-0 top-12 z-30 overflow-y-auto bg-[var(--color-bg)] px-5 py-5 lg:left-52 lg:px-8 lg:py-6"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="page-title">{editing ? 'Editar promoción' : 'Nueva promoción'}</h2>
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

      <ol className="mt-6 flex flex-wrap gap-x-6 gap-y-2" aria-label="Pasos">
        {steps.map((s, i) => {
          const current = s === step;
          const reachable = i <= maxIdx;
          return (
            <li key={s}>
              <button
                type="button"
                disabled={!reachable}
                aria-current={current ? 'step' : undefined}
                onClick={() => move(s)}
                className={`flex items-center gap-2 text-xs font-semibold ${reachable ? 'cursor-pointer' : 'cursor-default opacity-50'} ${
                  current ? 'text-[var(--color-primary)]' : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-main)]'
                }`}
              >
                <span
                  className={`flex h-5 w-5 items-center justify-center rounded-full text-[10px] ${
                    current
                      ? 'bg-[var(--color-primary)] text-[var(--zipp-obsidian)]'
                      : 'border border-[var(--color-border)]'
                  }`}
                >
                  {i + 1}
                </span>
                {labels[s]}
              </button>
            </li>
          );
        })}
      </ol>

      <div className={`mt-6 grid gap-x-10 gap-y-8 pb-8 ${showAside ? 'xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]' : ''}`}>
        <div key={step} className="promo-step min-w-0">
          {step === 'idea' && <TemplateStep onPick={pickTemplate} />}
          {step === 'amount' && <AmountStep form={form} patch={patch} editing={editing} />}
          {step === 'when' && <WhenStep form={form} patch={patch} />}
          {step === 'target' && (
            <TargetStep
              form={form}
              patch={patch}
              isCode={isCode}
              editing={editing}
              businessId={businessId}
              coveredByOther={coveredByOther}
              onSwitchMode={editing ? undefined : switchMode}
            />
          )}
          {step === 'review' && (
            <ReviewStep form={form} isCode={isCode} editing={editing} onJump={(s: ReviewJump) => move(s)} />
          )}
        </div>

        {showAside && (
          <aside className="xl:sticky xl:top-0 xl:self-start xl:border-l xl:border-[var(--color-border)] xl:pl-10">
            <div className="space-y-6">
              <CouponTicket form={form} isCode={isCode} />

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
        )}
      </div>

      <div className="sticky -bottom-5 -mx-5 border-t border-[var(--color-border)] bg-[var(--color-bg)] px-5 py-3 lg:-bottom-6 lg:-mx-8 lg:px-8 space-y-3">
        {shown && (
          <p className="flex items-start gap-2 text-xs font-semibold text-[var(--color-danger)]" role="alert">
            <AlertCircle className="w-4 h-4 shrink-0" />
            {shown}
          </p>
        )}
        <div className="flex items-center justify-end gap-3">
          <button type="button" onClick={onClose} className="px-3 py-2 text-xs font-semibold text-[var(--color-text-secondary)] hover:text-[var(--color-text-main)] cursor-pointer">
            Cancelar
          </button>
          {idx > 0 && (
            <button
              type="button"
              onClick={() => move(steps[idx - 1])}
              className="px-3 py-2 rounded-md border border-[var(--color-border)] text-xs font-semibold text-[var(--color-text-main)] hover:bg-[var(--color-surface-hover)] cursor-pointer"
            >
              Atrás
            </button>
          )}
          {step !== 'idea' && (
            <button
              type="button"
              onClick={isLast ? submit : next}
              disabled={saving}
              className="px-4 py-2 rounded-md bg-[var(--color-primary)] text-[var(--zipp-obsidian)] font-semibold text-xs hover:bg-[var(--color-primary-light)] transition-colors cursor-pointer disabled:opacity-60"
            >
              {isLast ? (saving ? 'Guardando…' : editing ? 'Guardar cambios' : 'Crear promoción') : 'Siguiente'}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
