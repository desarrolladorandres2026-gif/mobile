import { useCallback, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, Plus } from 'lucide-react';
import api from '../services/api';
import { qk } from '../lib/queryKeys';
import { usePermissions } from '../hooks/usePermissions';
import { useAuthStore } from '../stores/authStore';
import { money } from '../lib/orderFlow';
import AdCampaignPanel from '../components/AdCampaignPanel';
import AdCampaignCard from '../components/AdCampaignCard';
import { Choice, TemplateLogo } from '../components/promotion/ui';
import {
  applyAdTemplate, emptyDraft, isCpmOf, phaseOf, spentOf, templatesFor,
  type AdDraft, type AdOffer, type AdStep, type Campaign, type Invoice, type Phase,
} from '../lib/advertising';

/**
 * Publicidad que compra el propio comercio.
 *
 * Antes había que llamar a alguien de ZIPP, acordar un precio y esperar a
 * que un administrador creara la campaña a mano. Eso funciona con cinco
 * anunciantes y deja de funcionar en cuanto alguien quiere anunciarse un
 * martes por la noche.
 *
 * Dos cosas se dicen en voz alta y en varios sitios, porque son las que
 * producen sorpresas: **el tope es el gasto máximo real** —se convierte en
 * un número de impresiones o de clics y ahí se corta solo— y **se descuenta
 * de la liquidación**, no se cobra con tarjeta.
 *
 * La página es una sola lista agrupada por lo que el comercio tiene que
 * hacer con cada campaña (corregir, esperar, mirar, archivar) y no por tipo
 * de dato: la factura de una campaña cerrada vive en su propia tarjeta. Las
 * tarjetas son la misma excepción al estilo plano que las de promociones: ver
 * el comentario de `.promo-card` en `index.css`.
 */

const GROUPS: Array<{ key: Phase; title: string }> = [
  { key: 'attention', title: 'Necesitan atención' },
  { key: 'review', title: 'En revisión' },
  { key: 'active', title: 'Activas y programadas' },
  { key: 'closed', title: 'Cerradas' },
];

export default function Advertising() {
  const selectedBusiness = useAuthStore((s) => s.selectedBusiness);
  const businessId = selectedBusiness?._id;
  // Las facturas y la deuda de publicidad son dinero del negocio: el
  // administrador compra campañas, pero esto lo ve quien ve liquidaciones.
  const { access } = usePermissions(businessId);
  const seesBilling = !access || access.permissions.includes('settlements:view');

  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<AdDraft | null>(null);
  const [correcting, setCorrecting] = useState(false);
  const [initialStep, setInitialStep] = useState<AdStep>('idea');
  const [showClosed, setShowClosed] = useState(false);

  const adsQuery = useQuery({
    queryKey: [...qk.advertising(businessId), seesBilling],
    enabled: !!businessId && !!access,
    queryFn: async () => {
      const [list, billing] = await Promise.all([
        api.get(`/advertisements/business/${businessId}`),
        seesBilling
          ? api.get(`/advertisements/business/${businessId}/invoices`)
          : Promise.resolve({ data: { data: { invoices: [], outstanding: 0 } } }),
      ]);
      return {
        campaigns: (list.data.data ?? []) as Campaign[],
        invoices: (billing.data.data.invoices ?? []) as Invoice[],
        outstanding: (billing.data.data.outstanding ?? 0) as number,
      };
    },
  });
  // Lo que ZIPP ofrece hoy (modalidades, rangos, duración). Si no hay oferta,
  // comprar se explica en vez de abrir un asistente que el servidor rechazaría.
  const offerQuery = useQuery({
    queryKey: [...qk.advertising(businessId), 'offer'],
    enabled: !!businessId,
    queryFn: async () => (await api.get(`/advertisements/business/${businessId}/offer`)).data.data as AdOffer,
  });
  const offer = offerQuery.data;
  const [blocked, setBlocked] = useState<string[] | null>(null);

  const campaigns = useMemo(() => adsQuery.data?.campaigns ?? [], [adsQuery.data]);
  const invoices = useMemo(() => adsQuery.data?.invoices ?? [], [adsQuery.data]);
  const outstanding = adsQuery.data?.outstanding ?? 0;
  const loading = !!businessId && adsQuery.isPending;

  const invoiceOf = useMemo(() => new Map(invoices.map((i) => [i.campaignId, i])), [invoices]);

  // «Ahora» es el momento de la última lectura: derivarlo de ahí mantiene el
  // render puro y las fases coherentes con los datos que se están pintando.
  const now = adsQuery.dataUpdatedAt;

  const { grouped, activeSpent, activeServed } = useMemo(() => {
    const g: Record<Phase, Campaign[]> = { attention: [], review: [], active: [], closed: [] };
    for (const c of campaigns) g[phaseOf(c, now)].push(c);
    const running = g.active.filter((c) => c.isActive !== false);
    return {
      grouped: g,
      activeSpent: running.reduce((n, c) => n + spentOf(c), 0),
      activeServed: running.reduce((n, c) => n + c.impressionCount, 0),
    };
  }, [campaigns, now]);

  const load = useCallback(
    () => queryClient.invalidateQueries({ queryKey: qk.advertising(businessId) }),
    [queryClient, businessId]
  );

  /** Sin oferta no se abre el asistente: se dice por qué y qué esperar. */
  const usableOffer = (): AdOffer | null => {
    if (offer?.available) { setBlocked(null); return offer; }
    setBlocked(offer?.reasons?.length ? offer.reasons : ['No pudimos consultar la oferta de publicidad. Inténtalo de nuevo en un momento.']);
    if (!offer) void offerQuery.refetch();
    return null;
  };

  const startCreate = (templateId?: string) => {
    const current = usableOffer();
    if (!current) return;
    const template = templatesFor(current).find((t) => t.id === templateId);
    setCorrecting(false);
    setDraft(template ? applyAdTemplate(template, current) : emptyDraft(current));
    // Con la idea ya elegida desde el estado vacío, el asistente salta al anuncio.
    setInitialStep(template ? 'ad' : 'idea');
  };
  const startCorrect = (c: Campaign) => {
    const current = usableOffer();
    if (!current) return;
    const base = emptyDraft(current);
    // La modalidad de la campaña rechazada puede ya no estar disponible: se
    // conserva solo si sigue habilitada; las cifras fuera de rango las marca
    // el paso de inversión, no se corrigen en silencio.
    const model = isCpmOf(c) ? 'cpm' : 'cpc';
    setCorrecting(true);
    setInitialStep('ad');
    setDraft({
      ...base,
      campaignName: c.campaignName,
      flyerUrl: c.flyerUrl,
      pricingModel: current.models[model]?.enabled ? model : base.pricingModel,
      cpmRate: c.cpmRate || base.cpmRate,
      cpcRate: c.cpcRate || base.cpcRate,
      budget: c.budget || base.budget,
    });
  };

  const rowButton = 'text-xs font-semibold text-[var(--color-primary)] hover:underline cursor-pointer';

  return (
    <div className="space-y-6">
      <div className="page-header">
        <div>
          <h1 className="page-title">Publicidad</h1>
          <p className="page-subtitle">
            Tu anuncio en la app de Zipp. Lo pagas tú y se descuenta de tu liquidación
          </p>
        </div>
        <button
          type="button"
          onClick={() => startCreate()}
          className="flex h-8 cursor-pointer items-center gap-1.5 rounded-md bg-[var(--color-primary)] px-3 text-xs font-semibold text-[var(--zipp-obsidian)] hover:bg-[var(--color-primary-light)]"
        >
          <Plus className="h-4 w-4" />
          Nueva campaña
        </button>
      </div>

      {blocked ? (
        <div role="status" className="flex items-start gap-2 border-l-2 border-[var(--color-warning)] py-0.5 pl-3">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-warning)]" />
          <div className="space-y-0.5">
            <p className="text-xs font-semibold text-[var(--color-text-main)]">Todavía no puedes comprar publicidad</p>
            {blocked.map((reason) => (
              <p key={reason} className="text-xs text-[var(--color-text-secondary)]">{reason}</p>
            ))}
          </div>
        </div>
      ) : null}

      {adsQuery.isError ? (
        <div role="alert" className="flex items-start gap-2 border-l-2 border-[var(--color-danger)] py-0.5 pl-3">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-danger)]" />
          <p className="text-xs font-semibold text-[var(--color-danger)]">No pudimos cargar tus campañas.</p>
          <button
            type="button"
            onClick={() => void adsQuery.refetch()}
            className="ml-2 cursor-pointer text-xs font-bold text-[var(--color-danger)] underline"
          >
            Reintentar
          </button>
        </div>
      ) : null}

      {!loading && campaigns.length > 0 ? (
        <dl className="flex flex-wrap gap-x-10 gap-y-3">
          <div>
            <dt className="text-[11px] text-[var(--color-text-secondary)]">Gastado en campañas en curso</dt>
            <dd className="text-lg font-semibold tabular text-[var(--color-text-main)]">{money(activeSpent)}</dd>
          </div>
          <div>
            <dt className="text-[11px] text-[var(--color-text-secondary)]">Veces que te vieron</dt>
            <dd className="text-lg font-semibold tabular text-[var(--color-text-main)]">
              {activeServed.toLocaleString('es-CO')}
            </dd>
          </div>
          {seesBilling ? (
            <div>
              <dt className="text-[11px] text-[var(--color-text-secondary)]">Por descontar de tu liquidación</dt>
              <dd className={`text-lg font-semibold tabular ${outstanding > 0 ? 'text-[var(--color-warning)]' : 'text-[var(--color-text-main)]'}`}>
                {money(outstanding)}
              </dd>
            </div>
          ) : null}
        </dl>
      ) : null}

      {loading ? (
        <p className="py-2 text-xs text-[var(--color-text-secondary)]">Cargando campañas…</p>
      ) : adsQuery.isError && campaigns.length === 0 ? null : campaigns.length === 0 ? (
        <div className="space-y-5 py-8">
          <div className="space-y-1">
            <p className="text-lg font-semibold text-[var(--color-text-main)]">Todavía no te has anunciado</p>
            <p className="text-xs text-[var(--color-text-secondary)]">
              Tu anuncio aparece a pantalla completa cuando alguien abre la app. Pones un tope y no se
              gasta un peso más. Elige una idea para empezar.
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {(offer ? templatesFor(offer) : []).map((template) => (
              <Choice key={template.id} selected={false} onClick={() => startCreate(template.id)}>
                <TemplateLogo name={template.logo} size={48} />
                <span className="text-sm font-semibold">{template.title}</span>
                <span className="text-xs text-[var(--color-text-secondary)]">{template.blurb}</span>
              </Choice>
            ))}
          </div>
        </div>
      ) : (
        GROUPS.map(({ key, title }) => {
          const list = grouped[key];
          if (list.length === 0) return null;
          const collapsed = key === 'closed' && !showClosed;
          return (
            <section key={key} className="space-y-3">
              <div className="flex items-baseline justify-between border-b border-[var(--color-border)] pb-1.5">
                <h2 className="text-[13px] font-semibold text-[var(--color-text-main)]">
                  {title} · {list.length}
                </h2>
                {key === 'closed' ? (
                  <button type="button" onClick={() => setShowClosed((v) => !v)} className={rowButton}>
                    {showClosed ? 'Ocultar' : 'Mostrar'}
                  </button>
                ) : null}
              </div>

              {collapsed ? null : (
                <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                  {list.map((c, i) => (
                    <AdCampaignCard
                      key={c._id}
                      campaign={c}
                      phase={key}
                      now={now}
                      index={i}
                      invoice={invoiceOf.get(c._id)}
                      seesBilling={seesBilling}
                      onCorrect={() => startCorrect(c)}
                    />
                  ))}
                </div>
              )}
            </section>
          );
        })
      )}

      {!seesBilling && campaigns.length > 0 ? (
        <p className="text-xs text-[var(--color-text-secondary)]">
          Lo facturado por publicidad lo ve el propietario junto a sus liquidaciones.
        </p>
      ) : null}

      {draft && businessId && offer ? (
        <AdCampaignPanel
          businessId={businessId}
          offer={offer}
          initial={draft}
          correcting={correcting}
          initialStep={initialStep}
          onClose={() => setDraft(null)}
          onCreated={() => { setDraft(null); void load(); }}
        />
      ) : null}
    </div>
  );
}
