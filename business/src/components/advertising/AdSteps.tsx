import { ImageOff, Pencil } from 'lucide-react';
import DateRangeField from '../DateRangeField';
import { AmountPicker, Chip, Choice, Field, inputClass, StepHeading, TemplateLogo } from '../promotion/ui';
import { money } from '../../lib/orderFlow';
import {
  AD_BUDGET_PRESETS, AD_DURATIONS, AD_TEMPLATES, CPC_PRESETS, CPM_PRESETS,
  addDays, adSummary, dayDiff, isFlyerUrl, reachOf, rateOf,
  type AdDraft, type AdTemplate,
} from '../../lib/advertising';

/**
 * Los pasos del asistente de campañas. Igual que el de promociones, no tienen
 * estado propio: editan el borrador que vive en `AdCampaignPanel`, que es
 * quien lo envía.
 */

interface StepProps {
  draft: AdDraft;
  patch: (p: Partial<AdDraft>) => void;
}

const dayEs = (day: string) =>
  day ? new Date(`${day}T00:00:00`).toLocaleDateString('es-CO', { day: 'numeric', month: 'short' }) : '';

export function AdIdeaStep({ onPick }: { onPick: (template: AdTemplate) => void }) {
  return (
    <div className="space-y-5">
      <StepHeading
        title="¿Qué quieres lograr con tu anuncio?"
        hint="Elige una idea de partida. Después ajustas lo que quieras: nada queda fijo."
      />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {AD_TEMPLATES.map((template) => (
          <Choice key={template.id} selected={false} onClick={() => onPick(template)}>
            <TemplateLogo name={template.logo} size={48} />
            <span className="text-sm font-semibold">{template.title}</span>
            <span className="text-xs text-[var(--color-text-secondary)]">{template.blurb}</span>
          </Choice>
        ))}
      </div>
    </div>
  );
}

export function AdCreativeStep({ draft, patch, onFlyerChange }: StepProps & { onFlyerChange: () => void }) {
  return (
    <div className="space-y-6">
      <StepHeading
        title="Tu anuncio"
        hint="Sale a pantalla completa cuando alguien abre la app. Zipp lo revisa antes de publicarlo."
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Nombre de la campaña" hint="Solo lo ves tú">
          <input
            value={draft.campaignName}
            onChange={(e) => patch({ campaignName: e.target.value })}
            maxLength={100}
            placeholder="Promo de apertura"
            className={inputClass}
          />
        </Field>
        <Field label="Enlace del flyer" hint="Imagen vertical, con letra grande: se ve en celular">
          <input
            value={draft.flyerUrl}
            onChange={(e) => { patch({ flyerUrl: e.target.value }); onFlyerChange(); }}
            placeholder="https://…"
            className={inputClass}
          />
        </Field>
      </div>
      <ul className="space-y-1 text-xs text-[var(--color-text-secondary)]">
        <li>Una sola idea por anuncio: el plato, el precio o la oferta.</li>
        <li>Letra grande y poco texto: en celular se lee de un vistazo.</li>
        <li>Tiene que ser de tu negocio: Zipp rechaza lo que no lo sea.</li>
      </ul>
    </div>
  );
}

export function AdWhenStep({ draft, patch }: StepProps) {
  const length = draft.startDate && draft.endDate ? dayDiff(draft.startDate, draft.endDate) : 0;
  return (
    <div className="space-y-6">
      <StepHeading
        title="¿Cuándo sale?"
        hint="Empieza desde mañana: Zipp necesita revisar el anuncio antes de publicarlo."
      />
      <div className="space-y-3">
        <p className="text-xs font-semibold text-[var(--color-text-main)]">Duración</p>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Duración rápida">
          {AD_DURATIONS.map(({ days, label }) => (
            <Chip
              key={days}
              active={length === days}
              onClick={() => patch({ endDate: addDays(draft.startDate, days) })}
            >
              {label}
            </Chip>
          ))}
        </div>
        <DateRangeField
          from={draft.startDate}
          to={draft.endDate}
          onChangeFrom={(v) => patch({ startDate: v })}
          onChangeTo={(v) => patch({ endDate: v })}
        />
        {length > 0 && (
          <p className="text-xs text-[var(--color-text-secondary)]">
            {length} {length === 1 ? 'día' : 'días'} en pantalla, o menos si llega antes al tope.
          </p>
        )}
      </div>
    </div>
  );
}

export function AdBudgetStep({ draft, patch }: StepProps) {
  const isCpm = draft.pricingModel === 'cpm';
  const reach = reachOf(draft);
  return (
    <div className="space-y-6">
      <StepHeading
        title="¿Cuánto inviertes?"
        hint="El tope es el gasto máximo real: no se gasta un peso más. Se descuenta de tu liquidación, no se cobra con tarjeta."
      />

      <div className="grid gap-3 sm:grid-cols-2">
        <Choice selected={isCpm} onClick={() => patch({ pricingModel: 'cpm' })}>
          <span className="text-sm font-semibold">Por visibilidad</span>
          <span className="text-xs text-[var(--color-text-secondary)]">Pagas por cada mil veces que sale tu anuncio (CPM).</span>
        </Choice>
        <Choice selected={!isCpm} onClick={() => patch({ pricingModel: 'cpc' })}>
          <span className="text-sm font-semibold">Por toques</span>
          <span className="text-xs text-[var(--color-text-secondary)]">Pagas solo cuando alguien toca el anuncio (CPC).</span>
        </Choice>
      </div>

      <AmountPicker
        label="Tope de gasto"
        hint="Sin tope no se compra."
        value={draft.budget}
        onChange={(budget) => patch({ budget })}
        presets={AD_BUDGET_PRESETS}
      />
      <AmountPicker
        label={isCpm ? 'Tarifa por mil impresiones' : 'Tarifa por clic'}
        hint="Más tarifa significa menos alcance con el mismo tope. Zipp revisa la tarifa al aprobar la campaña."
        value={rateOf(draft)}
        onChange={(rate) => patch(isCpm ? { cpmRate: rate } : { cpcRate: rate })}
        presets={isCpm ? CPM_PRESETS : CPC_PRESETS}
      />

      {reach ? (
        <p className="text-sm font-semibold text-[var(--color-text-main)]" aria-live="polite">
          Con {money(draft.budget)} caben hasta {reach.toLocaleString('es-CO')} {isCpm ? 'impresiones' : 'clics'}.
        </p>
      ) : (
        <p className="text-xs font-semibold text-[var(--color-warning)]">
          Pon una tarifa y un tope para ver cuánto alcance compras.
        </p>
      )}
    </div>
  );
}

export type AdJump = 'ad' | 'when' | 'budget';

function Row({ label, value, step, onJump }: { label: string; value: string; step: AdJump; onJump: (s: AdJump) => void }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-[var(--color-border)] py-3">
      <div className="min-w-0">
        <p className="text-[11px] font-semibold text-[var(--color-text-secondary)]">{label}</p>
        <p className="break-words text-sm text-[var(--color-text-main)]">{value}</p>
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

export function AdReviewStep({ draft, correcting, onJump }: { draft: AdDraft; correcting: boolean; onJump: (s: AdJump) => void }) {
  const isCpm = draft.pricingModel === 'cpm';
  return (
    <div className="space-y-5">
      <StepHeading title={correcting ? 'Corrige y reenvía' : 'Todo listo. Revísalo una vez'} />
      <p className="text-base leading-relaxed text-[var(--color-text-main)]">{adSummary(draft)}</p>
      <div>
        <Row
          label="Anuncio"
          value={`${draft.campaignName.trim() || 'Sin nombre'} · ${isFlyerUrl(draft.flyerUrl) ? 'flyer cargado' : 'sin flyer'}`}
          step="ad"
          onJump={onJump}
        />
        <Row label="Cuándo" value={`${dayEs(draft.startDate)} → ${dayEs(draft.endDate)}`} step="when" onJump={onJump} />
        <Row
          label="Inversión"
          value={`Tope ${money(draft.budget)} · ${isCpm ? `${money(draft.cpmRate)} por mil impresiones` : `${money(draft.cpcRate)} por clic`}`}
          step="budget"
          onJump={onJump}
        />
      </div>
    </div>
  );
}

/** Flyer tal como saldrá, y cuánto alcance compra el tope. */
export function AdPreview({ draft, broken, onBroken }: { draft: AdDraft; broken: boolean; onBroken: () => void }) {
  const isCpm = draft.pricingModel === 'cpm';
  const reach = reachOf(draft);
  const days = draft.startDate && draft.endDate ? dayDiff(draft.startDate, draft.endDate) : 0;
  const show = isFlyerUrl(draft.flyerUrl) && !broken;
  return (
    <div className="space-y-5">
      <div className="space-y-1.5">
        <p className="text-xs font-semibold text-[var(--color-text-main)]">Así se verá</p>
        <div className="promo-ticket flex aspect-[9/16] max-h-80 items-center justify-center">
          {show ? (
            <img src={draft.flyerUrl.trim()} alt="Vista previa del flyer" onError={onBroken} className="h-full w-full object-cover" />
          ) : (
            <p className="flex flex-col items-center gap-2 px-6 text-center text-xs text-[var(--color-text-secondary)]">
              <ImageOff className="h-5 w-5" />
              {broken ? 'Ese enlace no abre una imagen.' : 'Pega el enlace y aquí aparece tu flyer.'}
            </p>
          )}
        </div>
      </div>

      <div className="space-y-1.5">
        <p className="text-xs font-semibold text-[var(--color-text-main)]">Lo que compras</p>
        {reach ? (
          <>
            <p className="text-2xl font-semibold tabular text-[var(--color-text-main)]">
              {reach.toLocaleString('es-CO')}{' '}
              <span className="text-sm font-medium text-[var(--color-text-secondary)]">{isCpm ? 'impresiones' : 'clics'}</span>
            </p>
            <p className="text-xs text-[var(--color-text-secondary)]">
              Con {money(draft.budget)} como máximo{days > 0 ? `, del ${dayEs(draft.startDate)} al ${dayEs(draft.endDate)}` : ''}.
              Es un techo, no una promesa: si llega al tope antes de la fecha, la campaña se corta sola.
            </p>
          </>
        ) : (
          <p className="text-xs text-[var(--color-text-secondary)]">Pon una tarifa y un tope para ver cuánto alcance compras.</p>
        )}
      </div>
    </div>
  );
}
