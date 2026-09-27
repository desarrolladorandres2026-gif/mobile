import { useCallback, useEffect, useState } from 'react';
import { Printer, ShieldAlert, X } from 'lucide-react';
import api from '../services/api';
import Pagination from '../components/Pagination';
import { apiMessage } from '../lib/apiError';
import { money, day } from '../lib/drivers';

/**
 * Comprobantes internos (INT-) de liquidaciones pagadas.
 *
 * No son facturas: ZIPP aún no tiene NIT ni proveedor DIAN, y cada
 * comprobante lo dice. Sirven de soporte para el contador y se sustituyen por
 * el documento electrónico el día del NIT. Se emiten desde Liquidaciones.
 *"Imprimir" abre el diálogo del navegador, donde se elige"Guardar como PDF".
 */

interface Doc {
 _id: string;
 number: string;
 type: 'settlement_statement' | 'driver_payment_voucher';
 party: { kind: 'business' | 'driver'; name: string; legalName?: string | null; documentType?: string | null; documentLast4?: string | null; dv?: string | null; taxRegime?: string | null };
 lines: Array<{ label: string; amount: number }>;
 netAmount: number;
 paymentMethod?: string | null;
 paymentReference?: string | null;
 paidAt?: string | null;
 notice: string;
 issuedAt: string;
}

const TYPE_LABEL: Record<Doc['type'], string> = {
 settlement_statement: 'Pre-factura de liquidación a comercio',
 driver_payment_voucher: 'Comprobante de pago a domiciliario',
};

const thisMonth = () => new Date().toISOString().slice(0, 7);

export default function FiscalDocuments() {
 const [month, setMonth] = useState(thisMonth());
 const [items, setItems] = useState<Doc[]>([]);
 const [page, setPage] = useState(1);
 const [meta, setMeta] = useState({ total: 0, totalPages: 1, limit: 25 });
 const [loading, setLoading] = useState(true);
 const [error, setError] = useState('');
 const [open, setOpen] = useState<Doc | null>(null);

 const load = useCallback(async () => {
 setLoading(true);
 setError('');
 try {
 const { data } = await api.get('/finance/documents', { params: { page, limit: 25, ...(month ? { month } : {}) } });
 setItems(data.data ?? []);
 setMeta(data.meta ?? { total: 0, totalPages: 1, limit: 25 });
 } catch (err) {
 setError(apiMessage(err, 'No se pudieron cargar los comprobantes.'));
 } finally {
 setLoading(false);
 }
 }, [page, month]);

 useEffect(() => {
 load();
 }, [load]);

 return (
 <div className="space-y-4 animate-fade-in">
 <div className="page-header no-print">
 <div>
 <h1 className="page-title">Comprobantes internos</h1>
 <p className="page-subtitle">Soporte de cada liquidación pagada, con consecutivo INT-. No son facturas</p>
 </div>
 <input
 type="month"
 value={month}
 onChange={(e) => { setMonth(e.target.value); setPage(1); }}
 aria-label="Mes"
 className="h-9 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2 text-xs font-semibold text-[var(--color-text-main)]"
 />
 </div>

 {error && (
 <p className="no-print flex items-center gap-2 text-xs font-semibold text-[var(--color-danger)]">
 <ShieldAlert className="h-4 w-4 shrink-0" /> {error}
 </p>
 )}

 {loading ? (
 <p className="py-10 text-center text-xs font-semibold text-[var(--color-text-main)]">Cargando…</p>
 ) : items.length === 0 ? (
 <p className="py-10 text-center text-xs text-[var(--color-text-main)]">
 No hay comprobantes en este mes. Se emiten desde Liquidaciones, en una liquidación ya pagada.
 </p>
 ) : (
 <>
 <div className="divide-y divide-[var(--color-border-light)]">
 {items.map((d) => (
 <button key={d._id} onClick={() => setOpen(d)} className="flex w-full cursor-pointer flex-wrap items-start justify-between gap-3 py-3 text-left">
 <div>
 <p className="font-mono text-sm font-bold text-[var(--color-text-main)]">{d.number}</p>
 <p className="text-[11px] text-[var(--color-text-main)]">{d.party.name} · {TYPE_LABEL[d.type]} · {day(d.issuedAt)}</p>
 </div>
 <p className="text-sm font-bold text-[var(--color-text-main)]">{money(d.netAmount)}</p>
 </button>
 ))}
 </div>
 <Pagination page={page} totalPages={meta.totalPages} total={meta.total} limit={meta.limit} onPageChange={setPage} />
 </>
 )}

 {open && (
 <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-xs animate-fade-in">
 <div className="print-area zipp-modal max-h-[90vh] w-full max-w-md space-y-3 overflow-y-auto rounded-2xl p-6">
 <div className="flex items-start justify-between gap-3">
 <div>
 <p className="font-mono text-lg font-bold text-[var(--color-text-main)]">{open.number}</p>
 <p className="text-xs text-[var(--color-text-main)]">{TYPE_LABEL[open.type]} · {day(open.issuedAt)}</p>
 </div>
 <button onClick={() => setOpen(null)} aria-label="Cerrar" className="no-print cursor-pointer p-1 text-[var(--color-text-main)]">
 <X className="h-4 w-4" />
 </button>
 </div>

 <div className="space-y-0.5 text-xs">
 <p className="font-bold text-[var(--color-text-main)]">{open.party.legalName ?? open.party.name}</p>
 {open.party.documentType && (
 <p className="text-[var(--color-text-main)]">
 {open.party.documentType} ••••{open.party.documentLast4}{open.party.dv ? `-${open.party.dv}` : ''}
 {open.party.taxRegime ? ` · régimen ${open.party.taxRegime}` : ''}
 </p>
 )}
 </div>

 <div className="divide-y divide-[var(--color-border-light)] border-y border-[var(--color-border-light)]">
 {open.lines.map((l) => (
 <div key={l.label} className="flex justify-between gap-3 py-2 text-xs">
 <span className="text-[var(--color-text-main)]">{l.label}</span>
 <span className="font-semibold text-[var(--color-text-main)]">{l.amount < 0 ? `−${money(-l.amount)}` : money(l.amount)}</span>
 </div>
 ))}
 <div className="flex justify-between gap-3 py-2 text-sm font-bold">
 <span className="text-[var(--color-text-main)]">Neto pagado</span>
 <span className="text-[var(--color-text-main)]">{money(open.netAmount)}</span>
 </div>
 </div>

 <p className="text-[11px] text-[var(--color-text-main)]">
 Pagado {day(open.paidAt ?? undefined)} · {open.paymentMethod} · ref. {open.paymentReference}
 </p>
 <p className="text-[11px] font-semibold text-[var(--color-text-main)]">{open.notice}</p>

 <button
 onClick={() => window.print()}
 className="no-print flex h-10 w-full cursor-pointer items-center justify-center gap-2 rounded-lg bg-[var(--color-primary)] text-xs font-bold uppercase tracking-wider text-white"
 >
 <Printer className="h-4 w-4" /> Imprimir o guardar como PDF
 </button>
 </div>
 </div>
 )}
 </div>
 );
}
