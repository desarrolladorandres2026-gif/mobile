import { useCallback, useEffect, useState } from 'react';
import { ShieldAlert, X } from 'lucide-react';
import api from '../services/api';
import Pagination from '../components/Pagination';
import EntityLink from '../components/EntityLink';
import { apiMessage } from '../lib/apiError';
import { money, day } from '../lib/drivers';
import { useAuthStore } from '../stores/authStore';
import { Permission } from '../lib/permissions';

/**
 * Facturas de publicidad: lo que cada campaña cerrada le costó al anunciante.
 *
 * Las de un comercio se descuentan solas de su siguiente liquidación. Las que
 * vendió el equipo comercial por fuera solo se cierran aquí, registrando el
 * cobro con referencia y comprobante: sin esta pantalla quedaban abiertas
 * para siempre.
 */

type View = 'to_deduct' | 'deducted' | 'to_collect' | 'collected';

interface Invoice {
  _id: string;
  view: View;
  campaignName: string;
  businessId: string | null;
  advertiserName: string;
  pricingModel: string;
  impressions: number;
  clicks: number;
  amount: number;
  settledAt: string | null;
  collectionReference: string | null;
  createdAt: string;
}

const VIEW_LABEL: Record<View, { text: string; className: string }> = {
  to_deduct: { text: 'Se descuenta en su próxima liquidación', className: 'text-[var(--color-warning)]' },
  deducted: { text: 'Descontada de una liquidación', className: 'text-[var(--color-success)]' },
  to_collect: { text: 'Por cobrar', className: 'text-[var(--color-danger)]' },
  collected: { text: 'Cobrada', className: 'text-[var(--color-success)]' },
};

const FILTERS: Array<{ id: View | ''; text: string }> = [
  { id: 'to_collect', text: 'Por cobrar' },
  { id: 'to_deduct', text: 'Por descontar' },
  { id: '', text: 'Todas' },
];

const input =
  'h-10 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 text-xs outline-none focus:border-[var(--color-primary)]';

export default function AdInvoices() {
  const canManage = useAuthStore((s) => s.hasPermission(Permission.FINANCE_MANAGE));
  const [view, setView] = useState<View | ''>('to_collect');
  const [items, setItems] = useState<Invoice[]>([]);
  const [totals, setTotals] = useState<Record<View, { count: number; amount: number }> | null>(null);
  const [page, setPage] = useState(1);
  const [meta, setMeta] = useState({ total: 0, totalPages: 1, limit: 25 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [collecting, setCollecting] = useState<Invoice | null>(null);
  const [form, setForm] = useState({ reference: '', receiptUrl: '' });
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const { data } = await api.get('/finance/ad-invoices', { params: { page, limit: 25, ...(view ? { view } : {}) } });
      setItems(data.data?.items ?? []);
      setTotals(data.data?.totals ?? null);
      setMeta(data.meta ?? { total: 0, totalPages: 1, limit: 25 });
    } catch (err) {
      setError(apiMessage(err, 'No se pudieron cargar las facturas de publicidad.'));
    } finally {
      setLoading(false);
    }
  }, [page, view]);

  useEffect(() => {
    load();
  }, [load]);

  const collect = async () => {
    if (!collecting) return;
    const reference = form.reference.trim();
    const receiptUrl = form.receiptUrl.trim();
    if (reference.length < 3) return setFormError('Escribe la referencia del pago.');
    if (!/^https?:\/\//i.test(receiptUrl)) return setFormError('El comprobante es obligatorio: pega su enlace (https://…).');
    setBusy(true);
    setFormError('');
    try {
      await api.post(`/finance/ad-invoices/${collecting._id}/collect`, { reference, receiptUrl });
      setCollecting(null);
      load();
    } catch (err) {
      setFormError(apiMessage(err, 'No se pudo registrar el cobro.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4 animate-fade-in">
      <div className="page-header">
        <div>
          <h1 className="page-title">Facturas de publicidad</h1>
          <p className="page-subtitle">Lo que cuestan las campañas cerradas y si ya se cobró</p>
        </div>
        <div className="flex gap-1">
          {FILTERS.map((f) => (
            <button
              key={f.text}
              onClick={() => { setView(f.id); setPage(1); }}
              className={`cursor-pointer border-b-2 px-3 py-1.5 text-xs font-bold uppercase tracking-wider transition-all ${
                view === f.id
                  ? 'border-[var(--color-primary)] text-[var(--color-primary)]'
                  : 'border-transparent text-[var(--color-text-secondary)] hover:text-[var(--color-text-main)]'
              }`}
            >
              {f.text}
            </button>
          ))}
        </div>
      </div>

      {totals && (
        <div className="grid grid-cols-2 gap-4 border-b border-[var(--color-border-light)] pb-4 lg:grid-cols-4">
          {(Object.keys(VIEW_LABEL) as View[]).map((k) => (
            <div key={k}>
              <p className="text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-secondary)]">{VIEW_LABEL[k].text}</p>
              <p className="kpi-value mt-1 text-xl text-[var(--color-text-main)]">{money(totals[k].amount)}</p>
              <p className="mt-0.5 text-xs text-[var(--color-text-muted)]">{totals[k].count} {totals[k].count === 1 ? 'factura' : 'facturas'}</p>
            </div>
          ))}
        </div>
      )}

      {error && (
        <p className="flex items-center gap-2 text-xs font-semibold text-[var(--color-danger)]">
          <ShieldAlert className="h-4 w-4 shrink-0" /> {error}
        </p>
      )}

      {loading ? (
        <p className="py-10 text-center text-xs font-semibold text-[var(--color-text-secondary)]">Cargando…</p>
      ) : items.length === 0 ? (
        <p className="py-10 text-center text-xs text-[var(--color-text-muted)]">No hay facturas con este filtro.</p>
      ) : (
        <>
          <div className="divide-y divide-[var(--color-border-light)]">
            {items.map((i) => (
              <div key={i._id} className="flex flex-wrap items-start justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-bold text-[var(--color-text-main)]">{i.campaignName}</p>
                  <p className="text-[11px] text-[var(--color-text-secondary)]">
                    <EntityLink type="business" id={i.businessId}>{i.advertiserName || 'Sin anunciante'}</EntityLink>
                    {' · '}{day(i.createdAt)} · {i.impressions.toLocaleString('es-CO')} impresiones · {i.clicks.toLocaleString('es-CO')} clics
                  </p>
                  {i.collectionReference && (
                    <p className="text-[11px] text-[var(--color-text-muted)]">Referencia {i.collectionReference}</p>
                  )}
                </div>
                <div className="flex items-center gap-4">
                  <div className="text-right">
                    <p className="text-sm font-bold text-[var(--color-text-main)]">{money(i.amount)}</p>
                    <p className={`text-[10px] font-bold uppercase tracking-wider ${VIEW_LABEL[i.view].className}`}>{VIEW_LABEL[i.view].text}</p>
                  </div>
                  {i.view === 'to_collect' && canManage && (
                    <button
                      onClick={() => { setCollecting(i); setForm({ reference: '', receiptUrl: '' }); setFormError(''); }}
                      className="cursor-pointer rounded-lg bg-[var(--color-primary)] px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-white"
                    >
                      Registrar cobro
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
          <Pagination page={page} totalPages={meta.totalPages} total={meta.total} limit={meta.limit} onPageChange={setPage} />
        </>
      )}

      {collecting && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-xs animate-fade-in">
          <div className="zipp-modal w-full max-w-sm space-y-3 rounded-2xl p-6">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-base font-bold text-[var(--color-text-main)]">Registrar cobro</h3>
                <p className="text-xs text-[var(--color-text-secondary)]">{collecting.campaignName} · {money(collecting.amount)}</p>
              </div>
              <button onClick={() => setCollecting(null)} aria-label="Cerrar" className="cursor-pointer p-1 text-[var(--color-text-muted)]">
                <X className="h-4 w-4" />
              </button>
            </div>
            <label className="block space-y-1">
              <span className="text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-secondary)]">Referencia del pago</span>
              <input value={form.reference} onChange={(e) => setForm((f) => ({ ...f, reference: e.target.value }))} maxLength={120} className={input} />
            </label>
            <label className="block space-y-1">
              <span className="text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-secondary)]">Enlace del comprobante</span>
              <input value={form.receiptUrl} onChange={(e) => setForm((f) => ({ ...f, receiptUrl: e.target.value }))} placeholder="https://..." className={input} />
            </label>
            {formError && <p className="text-xs font-semibold text-[var(--color-danger)]">{formError}</p>}
            <button
              onClick={collect}
              disabled={busy}
              className="h-10 w-full cursor-pointer rounded-lg bg-[var(--color-primary)] text-xs font-bold uppercase tracking-wider text-white disabled:opacity-60"
            >
              {busy ? 'Registrando…' : 'Registrar cobro'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
