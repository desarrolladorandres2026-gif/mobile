import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, AlertCircle } from 'lucide-react';
import api from '../services/api';
import { apiMessage } from '../lib/apiError';
import {
  AdBudgetStep, AdCreativeStep, AdIdeaStep, AdPreview, AdReviewStep, AdWhenStep, type AdJump,
} from './advertising/AdSteps';
import { adProblem, applyAdTemplate, type AdDraft, type AdStep, type AdTemplate } from '../lib/advertising';

/**
 * Pantalla completa para pedir una campaña de publicidad, como asistente de
 * cinco pasos: idea, anuncio, cuándo, inversión y revisión. Ocupa el área de
 * contenido, igual que `PromotionPanel`: bajo la cabecera (h-12) y junto a la
 * barra lateral (w-52, fija desde lg). Va en un portal por la misma razón —
 * el contenedor de la página anima con `transform`.
 *
 * A la derecha, lo que el comercio está comprando: el flyer tal como saldrá
 * y cuánto alcance compra su tope. Es la única cifra que convierte «cien mil
 * pesos» en una decisión (cincuenta mil impresiones suena a mucho y doscientos
 * clics a poco, y el mismo dinero compra las dos cosas según la tarifa).
 *
 * El botón principal nunca se apaga: si falta algo, el error dice qué y lleva
 * al paso donde está. Lo que viaja al servidor es lo mismo de siempre; el
 * servidor valida y un administrador revisa antes de que salga nada.
 */

interface Props {
  businessId: string;
  initial: AdDraft;
  /** Viene de una campaña rechazada: se dice, para que no parezca la misma. */
  correcting: boolean;
  /** `'idea'` al empezar de cero; `'ad'` si la idea ya se eligió (plantilla o corrección). */
  initialStep: AdStep;
  onClose: () => void;
  onCreated: () => void;
}

const STEPS: AdStep[] = ['idea', 'ad', 'when', 'budget', 'review'];
const LABELS: Record<AdStep, string> = {
  idea: 'Idea', ad: 'Anuncio', when: 'Cuándo', budget: 'Inversión', review: 'Listo',
};

export default function AdCampaignPanel({ businessId, initial, correcting, initialStep, onClose, onCreated }: Props) {
  const [form, setForm] = useState<AdDraft>(initial);
  const [step, setStep] = useState<AdStep>(initialStep);
  const [maxIdx, setMaxIdx] = useState(STEPS.indexOf(initialStep));
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [flyerBroken, setFlyerBroken] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const patch = (p: Partial<AdDraft>) => setForm((f) => ({ ...f, ...p }));
  const idx = STEPS.indexOf(step);
  const isLast = step === 'review';

  const move = (to: AdStep) => {
    setError('');
    setStep(to);
    setMaxIdx((m) => Math.max(m, STEPS.indexOf(to)));
    scroller.current?.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const next = () => {
    const problem = adProblem(step, form);
    if (problem) { setError(problem); return; }
    move(STEPS[idx + 1]);
  };

  const pickTemplate = (template: AdTemplate) => {
    setForm((f) => ({ ...applyAdTemplate(template), flyerUrl: f.flyerUrl }));
    move('ad');
  };

  const submit = async () => {
    for (const s of ['ad', 'when', 'budget'] as const) {
      const problem = adProblem(s, form);
      if (problem) { move(s); setError(problem); return; }
    }
    setError('');
    setSaving(true);
    const isCpm = form.pricingModel === 'cpm';
    try {
      await api.post(`/advertisements/business/${businessId}`, {
        campaignName: form.campaignName.trim(),
        flyerUrl: form.flyerUrl.trim(),
        startDate: form.startDate,
        endDate: form.endDate,
        pricingModel: form.pricingModel,
        cpmRate: isCpm ? Number(form.cpmRate) : 0,
        cpcRate: isCpm ? 0 : Number(form.cpcRate),
        budget: Number(form.budget),
      });
      onCreated();
    } catch (err) {
      setError(apiMessage(err, 'No pudimos enviar la campaña.'));
    } finally {
      setSaving(false);
    }
  };

  const showAside = step !== 'idea';

  return createPortal(
    <div
      ref={scroller}
      role="dialog"
      aria-label="Nueva campaña"
      className="fixed bottom-0 left-0 right-0 top-12 z-30 overflow-y-auto bg-[var(--color-bg)] px-5 py-5 lg:left-52 lg:px-8 lg:py-6"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="page-title">{correcting ? 'Corregir y reenviar' : 'Nueva campaña'}</h2>
          <p className="mt-1.5 text-xs text-[var(--color-text-secondary)]">
            {correcting
              ? 'Se envía como una campaña nueva a revisión; la rechazada se queda en tu historial.'
              : 'Tu anuncio sale a pantalla completa. Zipp lo revisa antes de publicarlo.'}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-xs font-medium text-[var(--color-text-main)] hover:bg-[var(--color-surface-hover)]"
        >
          <X className="h-4 w-4" /> Volver a publicidad
        </button>
      </div>

      <ol className="mt-6 flex flex-wrap gap-x-6 gap-y-2" aria-label="Pasos">
        {STEPS.map((s, i) => {
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
                    current ? 'bg-[var(--color-primary)] text-[var(--zipp-obsidian)]' : 'border border-[var(--color-border)]'
                  }`}
                >
                  {i + 1}
                </span>
                {LABELS[s]}
              </button>
            </li>
          );
        })}
      </ol>

      <div className={`mt-6 grid gap-x-10 gap-y-8 pb-8 ${showAside ? 'xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]' : ''}`}>
        <div key={step} className="promo-step min-w-0">
          {step === 'idea' && <AdIdeaStep onPick={pickTemplate} />}
          {step === 'ad' && <AdCreativeStep draft={form} patch={patch} onFlyerChange={() => setFlyerBroken(false)} />}
          {step === 'when' && <AdWhenStep draft={form} patch={patch} />}
          {step === 'budget' && <AdBudgetStep draft={form} patch={patch} />}
          {step === 'review' && <AdReviewStep draft={form} correcting={correcting} onJump={(s: AdJump) => move(s)} />}
        </div>

        {showAside && (
          <aside className="min-w-0 xl:sticky xl:top-0 xl:self-start xl:border-l xl:border-[var(--color-border)] xl:pl-10">
            <AdPreview draft={form} broken={flyerBroken} onBroken={() => setFlyerBroken(true)} />
          </aside>
        )}
      </div>

      <div className="sticky -bottom-5 -mx-5 space-y-3 border-t border-[var(--color-border)] bg-[var(--color-bg)] px-5 py-3 lg:-bottom-6 lg:-mx-8 lg:px-8">
        {error && (
          <p className="flex items-start gap-2 text-xs font-semibold text-[var(--color-danger)]" role="alert">
            <AlertCircle className="h-4 w-4 shrink-0" /> {error}
          </p>
        )}
        <div className="flex flex-wrap items-center justify-end gap-3">
          {isLast && (
            <p className="mr-auto text-xs text-[var(--color-text-secondary)]">
              Al cerrarse, el gasto se descuenta de tu liquidación. No se cobra con tarjeta.
            </p>
          )}
          <button type="button" onClick={onClose} className="cursor-pointer px-3 py-2 text-xs font-semibold text-[var(--color-text-secondary)] hover:text-[var(--color-text-main)]">
            Cancelar
          </button>
          {idx > 0 && (
            <button
              type="button"
              onClick={() => move(STEPS[idx - 1])}
              className="cursor-pointer rounded-md border border-[var(--color-border)] px-3 py-2 text-xs font-semibold text-[var(--color-text-main)] hover:bg-[var(--color-surface-hover)]"
            >
              Atrás
            </button>
          )}
          {step !== 'idea' && (
            <button
              type="button"
              onClick={isLast ? submit : next}
              disabled={saving}
              className="cursor-pointer rounded-md bg-[var(--color-primary)] px-4 py-2 text-xs font-semibold text-[var(--zipp-obsidian)] transition-colors hover:bg-[var(--color-primary-light)] disabled:opacity-60"
            >
              {isLast ? (saving ? 'Enviando…' : 'Enviar a revisión') : 'Siguiente'}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
