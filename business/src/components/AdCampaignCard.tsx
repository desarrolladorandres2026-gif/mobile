import { useState } from 'react';
import { ImageOff } from 'lucide-react';
import { money } from '../lib/orderFlow';
import {
  capOf, isCpmOf, servedOf, spentOf, stateLine,
  type Campaign, type Invoice, type Phase, type StateTone,
} from '../lib/advertising';

/**
 * Una campaña de la lista, como tarjeta: el flyer tal como sale, en qué punto
 * está, cuánto lleva gastado de su tope y lo que ha logrado. Usa las mismas
 * superficies que las tarjetas de promociones (`.promo-card`).
 */

interface Props {
  campaign: Campaign;
  phase: Phase;
  now: number;
  index: number;
  invoice?: Invoice;
  seesBilling: boolean;
  onCorrect: () => void;
}

const dateEs = (value: string) => new Date(value).toLocaleDateString('es-CO', { day: 'numeric', month: 'short' });

const DOT: Record<StateTone, string> = {
  danger: 'bg-[var(--color-danger)]',
  warning: 'bg-[var(--color-warning)]',
  info: 'bg-[var(--color-primary)]',
  success: 'bg-[var(--color-success)]',
  muted: 'bg-[var(--color-text-secondary)]',
};

function Thumb({ url }: { url: string }) {
  const [broken, setBroken] = useState(false);
  return (
    <div className="flex aspect-[9/16] w-16 shrink-0 items-center justify-center overflow-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-bg-alt)]">
      {url && !broken ? (
        <img src={url} alt="" onError={() => setBroken(true)} className="h-full w-full object-cover" />
      ) : (
        <ImageOff className="h-4 w-4 text-[var(--color-text-secondary)]" />
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] text-[var(--color-text-secondary)]">{label}</dt>
      <dd className="text-sm font-semibold tabular text-[var(--color-text-main)]">{value}</dd>
    </div>
  );
}

export default function AdCampaignCard({ campaign: c, phase, now, index, invoice, seesBilling, onCorrect }: Props) {
  const state = stateLine(c, phase, now);
  const cap = capOf(c);
  const served = servedOf(c);
  const ratio = cap > 0 ? Math.min(1, served / cap) : 0;
  const ctr = c.impressionCount > 0 ? (c.clickCount / c.impressionCount) * 100 : 0;
  const perClick = c.clickCount > 0 ? Math.round(spentOf(c) / c.clickCount) : 0;
  const n = (value: number) => value.toLocaleString('es-CO');

  return (
    <article
      className={`promo-card ${phase === 'closed' ? 'opacity-80' : ''}`}
      data-tone={state.tone}
      style={{ animationDelay: `${Math.min(index, 8) * 40}ms` }}
    >
      <div className="flex gap-3">
        <Thumb url={c.flyerUrl} />
        <div className="min-w-0 flex-1 space-y-1">
          <h3 className="truncate text-sm font-semibold text-[var(--color-text-main)]">{c.campaignName}</h3>
          <p className="flex items-center gap-1.5 text-xs text-[var(--color-text-secondary)]">
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT[state.tone]}`} />
            {state.text}
          </p>
          <p className="text-xs text-[var(--color-text-secondary)]">
            {dateEs(c.startDate)} → {dateEs(c.endDate)}
          </p>
          <p className="text-xs text-[var(--color-text-secondary)]">
            {isCpmOf(c) ? `${money(c.cpmRate)} por mil impresiones` : `${money(c.cpcRate)} por clic`}
          </p>
        </div>
      </div>

      {phase === 'attention' ? (
        <div className="space-y-2">
          {c.rejectionReason ? <p className="text-xs text-[var(--color-danger)]">{c.rejectionReason}</p> : null}
          <button
            type="button"
            onClick={onCorrect}
            className="cursor-pointer text-xs font-semibold text-[var(--color-primary)] hover:underline"
          >
            Corregir y reenviar
          </button>
        </div>
      ) : (
        <>
          <div className="space-y-1.5">
            <p className="text-xs tabular text-[var(--color-text-secondary)]">
              <span className="text-lg font-semibold text-[var(--color-text-main)]">{money(spentOf(c))}</span>{' '}
              de {money(c.budget)}
            </p>
            {cap > 0 ? (
              <div
                className="h-1 w-full overflow-hidden rounded-full bg-[var(--color-border)]"
                role="progressbar"
                aria-valuenow={Math.round(ratio * 100)}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <div
                  className={`h-full rounded-full transition-all ${ratio >= 0.9 ? 'bg-[var(--color-danger)]' : 'bg-[var(--color-primary)]'}`}
                  style={{ width: `${ratio * 100}%` }}
                />
              </div>
            ) : null}
          </div>

          <dl className="grid grid-cols-3 gap-3 border-t border-[var(--color-border)] pt-3">
            <Stat label="Vistas" value={n(c.impressionCount)} />
            <Stat label="Clics" value={n(c.clickCount)} />
            <Stat label="Clics / 100 vistas" value={c.impressionCount > 0 ? ctr.toFixed(1).replace('.', ',') : '—'} />
          </dl>
          {perClick > 0 ? (
            <p className="text-xs text-[var(--color-text-secondary)]">Cada clic te ha costado {money(perClick)}.</p>
          ) : null}
          <p className="text-xs text-[var(--color-text-secondary)]">
            {c.placement === 'explore' ? 'Sale en Explorar' : 'Sale al abrir la app'}
            {cap > 0 ? ` · tope de ${n(cap)} ${isCpmOf(c) ? 'impresiones' : 'clics'}` : ''}
          </p>
        </>
      )}

      {phase === 'closed' && seesBilling ? (
        <p className="border-t border-[var(--color-border)] pt-2.5 text-xs text-[var(--color-text-secondary)]">
          {invoice
            ? `Facturado ${money(invoice.amount)} · ${invoice.settledAt ? 'ya descontado de tu liquidación' : 'pendiente de descontar'}`
            : 'Aún sin facturar: se cobra al cerrar la campaña.'}
        </p>
      ) : null}
    </article>
  );
}
