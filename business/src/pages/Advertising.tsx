import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertCircle, Megaphone, Plus, X, Clock, CheckCircle2, XCircle } from 'lucide-react';
import api from '../services/api';
import { useAuthStore } from '../stores/authStore';
import { apiMessage } from '../lib/apiError';

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
 */

type PricingModel = 'cpm' | 'cpc';

interface Campaign {
  _id: string;
  campaignName: string;
  flyerUrl: string;
  startDate: string;
  endDate: string;
  pricingModel: string;
  cpmRate: number;
  cpcRate: number;
  budget: number;
  maxImpressions: number;
  maxClicks: number;
  impressionCount: number;
  clickCount: number;
  approvalStatus: 'pending' | 'approved' | 'rejected';
  rejectionReason?: string;
}

interface Invoice {
  _id: string;
  campaignName: string;
  impressions: number;
  clicks: number;
  amount: number;
  settledAt?: string | null;
  createdAt: string;
}

const money = (value: number) => `$${(value ?? 0).toLocaleString('es-CO')}`;

const STATUS: Record<Campaign['approvalStatus'], { label: string; icon: typeof Clock; cls: string }> = {
  pending: {
    label: 'En revisión',
    icon: Clock,
    cls: 'bg-[var(--color-warning-bg)] text-[var(--color-warning)]',
  },
  approved: {
    label: 'Aprobada',
    icon: CheckCircle2,
    cls: 'bg-[var(--color-success-bg)] text-[var(--color-success)]',
  },
  rejected: {
    label: 'Rechazada',
    icon: XCircle,
    cls: 'bg-[var(--color-danger-bg)] text-[var(--color-danger)]',
  },
};

const emptyForm = {
  campaignName: '',
  flyerUrl: '',
  startDate: '',
  endDate: '',
  pricingModel: 'cpm' as PricingModel,
  cpmRate: 2000,
  cpcRate: 500,
  budget: 100000,
};

export default function Advertising() {
  const selectedBusiness = useAuthStore((s) => s.selectedBusiness);
  const businessId = selectedBusiness?._id;

  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [outstanding, setOutstanding] = useState(0);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!businessId) return;
    try {
      setLoading(true);
      const [list, billing] = await Promise.all([
        api.get(`/advertisements/business/${businessId}`),
        api.get(`/advertisements/business/${businessId}/invoices`),
      ]);
      setCampaigns(list.data.data ?? []);
      setInvoices(billing.data.data.invoices ?? []);
      setOutstanding(billing.data.data.outstanding ?? 0);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [businessId]);

  useEffect(() => {
    load();
  }, [load]);

  /**
   * Cuánto alcance compra ese dinero.
   *
   * Se calcula mientras escribe y no al enviar, porque es la única cifra que
   * convierte "cien mil pesos" en una decisión: cincuenta mil impresiones
   * suena a mucho y doscientos clics suena a poco, y el mismo presupuesto
   * compra las dos cosas según la tarifa.
   */
  const reach = useMemo(() => {
    if (!form.budget) return null;
    if (form.pricingModel === 'cpm' && form.cpmRate > 0) {
      return `${Math.floor((form.budget * 1000) / form.cpmRate).toLocaleString('es-CO')} impresiones`;
    }
    if (form.pricingModel === 'cpc' && form.cpcRate > 0) {
      return `${Math.floor(form.budget / form.cpcRate).toLocaleString('es-CO')} clics`;
    }
    return null;
  }, [form]);

  const submit = async () => {
    setError('');
    setSaving(true);
    try {
      await api.post(`/advertisements/business/${businessId}`, {
        campaignName: form.campaignName.trim(),
        flyerUrl: form.flyerUrl.trim(),
        startDate: form.startDate,
        endDate: form.endDate,
        pricingModel: form.pricingModel,
        cpmRate: form.pricingModel === 'cpm' ? Number(form.cpmRate) : 0,
        cpcRate: form.pricingModel === 'cpc' ? Number(form.cpcRate) : 0,
        budget: Number(form.budget),
      });
      setCreating(false);
      setForm(emptyForm);
      await load();
    } catch (err) {
      setError(apiMessage(err, 'No pudimos enviar la campaña.'));
    } finally {
      setSaving(false);
    }
  };

  const field = 'w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-text-main)]';
  const label = 'block text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-muted)] mb-1';

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="page-header">
        <div>
          <h1 className="page-title">Publicidad</h1>
          <p className="page-subtitle">
            Tu anuncio en la app de Zipp. Lo pagas tú y se descuenta de tu liquidación
          </p>
        </div>
        <button
          onClick={() => setCreating(true)}
          className="flex cursor-pointer items-center gap-2 rounded-lg bg-[var(--color-primary)] px-4 py-2 text-xs font-bold text-white"
        >
          <Plus className="h-4 w-4" /> Nueva campaña
        </button>
      </div>

      {outstanding > 0 ? (
        <div className="flex items-start gap-2 rounded-xl border border-[var(--color-warning-bg)] bg-[var(--color-warning-bg)] p-4">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-warning)]" />
          <p className="text-sm text-[var(--color-text-main)]">
            Llevas <strong>{money(outstanding)}</strong> en publicidad pendiente de descontar. Se
            resta de tu próxima liquidación.
          </p>
        </div>
      ) : null}

      {loading ? (
        <p className="text-sm text-[var(--color-text-muted)]">Cargando…</p>
      ) : campaigns.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-[var(--color-border-light)] bg-[var(--color-surface)] py-16">
          <Megaphone className="h-8 w-8 text-[var(--color-text-muted)]" />
          <p className="font-semibold text-[var(--color-text-main)]">Todavía no te has anunciado</p>
          <p className="max-w-sm text-center text-sm text-[var(--color-text-secondary)]">
            Tu anuncio aparece a pantalla completa cuando alguien abre la app. Pones un tope y no
            se gasta un peso más.
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {campaigns.map((c) => {
            const state = STATUS[c.approvalStatus];
            const Icon = state.icon;
            const isCpm = c.pricingModel === 'cpm';
            const served = isCpm ? c.impressionCount : c.clickCount;
            const cap = isCpm ? c.maxImpressions : c.maxClicks;
            const spent = isCpm
              ? Math.round((c.impressionCount * c.cpmRate) / 1000)
              : c.clickCount * c.cpcRate;

            return (
              <li
                key={c._id}
                className="rounded-xl border border-[var(--color-border-light)] bg-[var(--color-surface)] p-4"
              >
                <div className="flex flex-wrap items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-bold text-[var(--color-text-main)]">{c.campaignName}</p>
                      <span
                        className={`flex items-center gap-1 rounded-md px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${state.cls}`}
                      >
                        <Icon className="h-3 w-3" /> {state.label}
                      </span>
                    </div>
                    <p className="text-xs text-[var(--color-text-secondary)]">
                      {isCpm ? `${money(c.cpmRate)} por mil impresiones` : `${money(c.cpcRate)} por clic`}{' '}
                      · tope {money(c.budget)}
                    </p>
                    {c.approvalStatus === 'rejected' && c.rejectionReason ? (
                      <p className="mt-1 text-xs text-[var(--color-danger)]">{c.rejectionReason}</p>
                    ) : null}
                  </div>

                  <div className="text-right">
                    <p className="text-sm font-bold text-[var(--color-text-main)]">{money(spent)}</p>
                    <p className="text-[11px] text-[var(--color-text-muted)]">
                      {served.toLocaleString('es-CO')}
                      {cap ? ` de ${cap.toLocaleString('es-CO')}` : ''}{' '}
                      {isCpm ? 'impresiones' : 'clics'}
                    </p>
                  </div>
                </div>

                {cap ? (
                  <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-[var(--color-bg-alt)]">
                    <div
                      className="h-full bg-[var(--color-primary)]"
                      style={{ width: `${Math.min(100, (served / cap) * 100)}%` }}
                    />
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {invoices.length > 0 ? (
        <div className="space-y-2">
          <h2 className="text-xs font-bold uppercase tracking-wider text-[var(--color-text-muted)]">
            Campañas cerradas
          </h2>
          <ul className="space-y-1">
            {invoices.map((i) => (
              <li
                key={i._id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--color-border-light)] bg-[var(--color-surface)] px-3 py-2 text-xs"
              >
                <span className="text-[var(--color-text-main)]">{i.campaignName}</span>
                <span className="text-[var(--color-text-secondary)]">
                  {i.impressions.toLocaleString('es-CO')} impresiones ·{' '}
                  {i.clicks.toLocaleString('es-CO')} clics
                </span>
                <span className="font-bold text-[var(--color-text-main)]">
                  {money(i.amount)} {i.settledAt ? '· descontado' : '· pendiente'}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {creating ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-lg space-y-3 rounded-xl bg-[var(--color-surface)] p-6">
            <div className="flex items-start justify-between">
              <h2 className="text-lg font-bold text-[var(--color-text-main)]">Nueva campaña</h2>
              <button
                onClick={() => setCreating(false)}
                className="cursor-pointer rounded-lg border border-[var(--color-border)] p-1.5 text-[var(--color-text-muted)]"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div>
              <label className={label}>Nombre de la campaña</label>
              <input
                className={field}
                value={form.campaignName}
                onChange={(e) => setForm({ ...form, campaignName: e.target.value })}
                placeholder="Promo de apertura"
              />
            </div>

            <div>
              <label className={label}>Enlace del flyer</label>
              <input
                className={field}
                value={form.flyerUrl}
                onChange={(e) => setForm({ ...form, flyerUrl: e.target.value })}
                placeholder="https://…"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={label}>Empieza</label>
                <input
                  type="date"
                  className={field}
                  value={form.startDate}
                  onChange={(e) => setForm({ ...form, startDate: e.target.value })}
                />
              </div>
              <div>
                <label className={label}>Termina</label>
                <input
                  type="date"
                  className={field}
                  value={form.endDate}
                  onChange={(e) => setForm({ ...form, endDate: e.target.value })}
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={label}>Cómo se cobra</label>
                <select
                  className={field}
                  value={form.pricingModel}
                  onChange={(e) =>
                    setForm({ ...form, pricingModel: e.target.value as PricingModel })
                  }
                >
                  <option value="cpm">Por impresiones (CPM)</option>
                  <option value="cpc">Por clics (CPC)</option>
                </select>
              </div>
              <div>
                <label className={label}>
                  {form.pricingModel === 'cpm' ? 'Por mil impresiones' : 'Por clic'}
                </label>
                <input
                  type="number"
                  className={field}
                  value={form.pricingModel === 'cpm' ? form.cpmRate : form.cpcRate}
                  onChange={(e) =>
                    setForm(
                      form.pricingModel === 'cpm'
                        ? { ...form, cpmRate: Number(e.target.value) }
                        : { ...form, cpcRate: Number(e.target.value) }
                    )
                  }
                />
              </div>
            </div>

            <div>
              <label className={label}>Tope de gasto</label>
              <input
                type="number"
                className={field}
                value={form.budget}
                onChange={(e) => setForm({ ...form, budget: Number(e.target.value) })}
              />
              {/* Lo que de verdad se está comprando. Sin esto, el tope es un
                  número sin unidades y la decisión se toma a ciegas. */}
              <p className="mt-1 text-xs text-[var(--color-text-secondary)]">
                {reach
                  ? `Con ${money(form.budget)} compras unas ${reach}. No se gasta un peso más.`
                  : 'Pon una tarifa y un tope para ver cuánto alcance compras.'}
              </p>
            </div>

            {error ? (
              <p className="flex items-start gap-1.5 text-xs text-[var(--color-danger)]">
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {error}
              </p>
            ) : null}

            <p className="text-xs text-[var(--color-text-muted)]">
              La campaña la revisa Zipp antes de salir. Al cerrarse, el gasto se descuenta de tu
              liquidación.
            </p>

            <button
              onClick={submit}
              disabled={saving}
              className="w-full cursor-pointer rounded-lg bg-[var(--color-primary)] py-2 text-xs font-bold uppercase tracking-wider text-white disabled:opacity-50"
            >
              {saving ? 'Enviando…' : 'Enviar a revisión'}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
