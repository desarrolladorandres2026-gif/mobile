import { useRef, useState } from 'react';
import { ImageOff, Pencil, Upload } from 'lucide-react';
import api from '../../services/api';
import { apiMessage } from '../../lib/apiError';
import DateRangeField from '../DateRangeField';
import { AmountPicker, Chip, Choice, Field, inputClass, StepHeading, TemplateLogo } from '../promotion/ui';
import { money } from '../../lib/orderFlow';
import {
  addDays, adSummary, budgetPresets, dayDiff, durationsFor, isFlyerUrl, offeredModels, ratePresets, reachOf, rateOf,
  templatesFor, type AdDraft, type AdOffer, type AdTemplate,
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

export function AdIdeaStep({ onPick, offer }: { onPick: (template: AdTemplate) => void; offer: AdOffer }) {
  return (
    <div className="space-y-5">
      <StepHeading
        title="¿Qué quieres lograr con tu anuncio?"
        hint="Elige una idea de partida. Después ajustas lo que quieras: nada queda fijo."
      />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {templatesFor(offer).map((template) => (
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

export function AdCreativeStep({ draft, patch, onFlyerChange, businessId }: StepProps & { onFlyerChange: () => void; businessId: string }) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [uploadError, setUploadError] = useState('');

  // El flyer se sube a Zipp, no se enlaza: así lo que se revisa es lo que sale
  // en la app, y nadie fuera de Zipp ve quién lo abre.
  const upload = async (file: File | undefined) => {
    if (fileInput.current) fileInput.current.value = '';
    if (!file) return;
    try {
      setBusy(true);
      setUploadError('');
      const form = new FormData();
      form.append('flyer', file, file.name);
      // `Content-Type` explícito en `undefined`: ver BusinessImageField.
      const { data } = await api.post(`/advertisements/business/${businessId}/flyer`, form, {
        headers: { 'Content-Type': undefined },
      });
      patch({ flyerUrl: data.data?.url ?? '' });
      onFlyerChange();
    } catch (err) {
      setUploadError(apiMessage(err, 'No se pudo subir el flyer.'));
    } finally {
      setBusy(false);
    }
  };

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
        <Field label="Flyer" hint="Imagen vertical, con letra grande: se ve en celular. JPG, PNG o WEBP">
          <input
            ref={fileInput}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="hidden"
            onChange={(e) => upload(e.target.files?.[0])}
          />
          <button
            type="button"
            onClick={() => fileInput.current?.click()}
            disabled={busy}
            className="inline-flex h-9 cursor-pointer items-center gap-2 text-sm font-semibold text-[var(--color-primary)] disabled:opacity-60"
          >
            <Upload className="h-4 w-4" />
            {busy ? 'Subiendo…' : isFlyerUrl(draft.flyerUrl) ? 'Cambiar imagen' : 'Subir imagen'}
          </button>
          {uploadError && <p className="text-xs font-semibold text-[var(--color-danger)]">{uploadError}</p>}
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

export function AdWhenStep({ draft, patch, offer }: StepProps & { offer: AdOffer }) {
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
          {durationsFor(offer).map(({ days, label }) => (
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
        <p className="text-xs text-[var(--color-text-secondary)]">
          Una campaña dura entre {offer.durationDays.min} y {offer.durationDays.max} días. No se renueva sola.
        </p>
      </div>
    </div>
  );
}

export function AdBudgetStep({ draft, patch, offer }: StepProps & { offer: AdOffer }) {
  const isCpm = draft.pricingModel === 'cpm';
  const reach = reachOf(draft);
  const models = offeredModels(offer);
  const range = offer.models[draft.pricingModel];
  return (
    <div className="space-y-6">
      <StepHeading
        title="¿Cuánto inviertes?"
        hint="El tope es el gasto máximo real: no se gasta un peso más. Se descuenta de tu liquidación, no se cobra con tarjeta."
      />

      {/* Solo lo que ZIPP habilitó. Con una sola modalidad no hay nada que elegir. */}
      {models.length > 1 ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {models.includes('cpm') ? (
            <Choice selected={isCpm} onClick={() => patch({ pricingModel: 'cpm' })}>
              <span className="text-sm font-semibold">Por visibilidad</span>
              <span className="text-xs text-[var(--color-text-secondary)]">Pagas por cada mil veces que sale tu anuncio (CPM).</span>
            </Choice>
          ) : null}
          {models.includes('cpc') ? (
            <Choice selected={!isCpm} onClick={() => patch({ pricingModel: 'cpc' })}>
              <span className="text-sm font-semibold">Por toques</span>
              <span className="text-xs text-[var(--color-text-secondary)]">Pagas solo cuando alguien toca el anuncio (CPC).</span>
            </Choice>
          ) : null}
        </div>
      ) : (
        <p className="text-sm text-[var(--color-text-main)]">
          {isCpm ? 'Pagas por cada mil veces que sale tu anuncio.' : 'Pagas solo cuando alguien toca el anuncio. Los toques repetidos o sospechosos no se cobran.'}
        </p>
      )}

      <AmountPicker
        label="Tope de gasto"
        hint={`Entre ${money(offer.budget.min)} y ${money(offer.budget.max)}. Sin tope no se compra.`}
        value={draft.budget}
        onChange={(budget) => patch({ budget })}
        presets={budgetPresets(offer)}
      />
      <AmountPicker
        label={isCpm ? 'Tarifa por mil impresiones' : 'Tarifa por clic'}
        hint={range ? `Entre ${money(range.minRate)} y ${money(range.maxRate)}. Más tarifa significa menos alcance con el mismo tope.` : 'Elige cómo pagar.'}
        value={rateOf(draft)}
        onChange={(rate) => patch(isCpm ? { cpmRate: rate } : { cpcRate: rate })}
        presets={range ? ratePresets(offer, draft.pricingModel) : []}
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
