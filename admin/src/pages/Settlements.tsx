import { useCallback, useEffect, useState } from 'react';
import { X, ShieldAlert, Eye, RefreshCw } from 'lucide-react';
import api from '../services/api';
import Pagination from '../components/Pagination';
import EntityLink from '../components/EntityLink';
import { apiMessage, apiErrorCode } from '../lib/apiError';
import { money, day } from '../lib/drivers';
import { useAuthStore } from '../stores/authStore';
import { Permission } from '../lib/permissions';

/**
 * Liquidaciones: la rutina semanal de finanzas.
 *
 * Dos pasos separados a propósito, igual que en el servidor: **liquidar**
 * reclama los pagos de un beneficiario y fija el neto; **registrar el pago**
 * (transferencia hecha por fuera, con referencia y comprobante) es lo que
 * cierra la liquidación y asienta el libro. Mezclarlos en un botón haría
 * posible marcar como pagado algo que no salió del banco.
 */

interface Payable {
 beneficiary: 'business' | 'driver';
 businessId: string | null;
 driverId: string | null;
 name: string | null;
 count: number;
 clawbackCount: number;
 net: number;
 daysWaiting: number;
}

interface Settlement {
 _id: string;
 beneficiary: 'business' | 'driver';
 businessId: string | null;
 driverId: string | null;
 businessName: string | null;
 driverName: string | null;
 payoutCount: number;
 grossAmount: number;
 reversedAmount: number;
 adSpendAmount: number;
 clawbackAmount: number;
 netAmount: number;
 paymentStatus: 'pending' | 'paid';
 paymentMethod?: string | null;
 reference?: string;
 receiptUrl?: string | null;
 paidAt?: string | null;
 createdAt: string;
}

interface RevealedAccount {
 method: string;
 bankName: string | null;
 accountType: string | null;
 accountNumber: string;
 holderName: string;
 holderDocument: string | null;
 changedSinceSettlement: boolean;
}

const METHOD_LABEL: Record<string, string> = {
 bank_transfer: 'Transferencia bancaria',
 nequi: 'Nequi',
 daviplata: 'Daviplata',
 cash: 'Efectivo',
 other: 'Otro',
};

const BENEFICIARY_LABEL = { business: 'Comercio', driver: 'Domiciliario' } as const;

type Tab = 'payables' | 'history';

const label = 'text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-main)]';
const input =
 'h-10 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 text-xs outline-none focus:border-[var(--color-primary)]';

export default function Settlements() {
 const canProcess = useAuthStore((s) => s.hasPermission(Permission.PAYOUTS_PROCESS));
 const canReveal = useAuthStore((s) => s.hasPermission(Permission.PAYOUTS_REVEAL_ACCOUNT));
 const canManage = useAuthStore((s) => s.hasPermission(Permission.FINANCE_MANAGE));

 const [tab, setTab] = useState<Tab>('payables');
 const [beneficiary, setBeneficiary] = useState<'' | 'business' | 'driver'>('');
 const [status, setStatus] = useState<'' | 'pending' | 'paid'>('pending');
 const [payables, setPayables] = useState<Payable[]>([]);
 const [items, setItems] = useState<Settlement[]>([]);
 const [page, setPage] = useState(1);
 const [meta, setMeta] = useState({ total: 0, totalPages: 1, limit: 25 });
 const [loading, setLoading] = useState(true);
 const [error, setError] = useState('');
 const [notice, setNotice] = useState('');

 const [toSettle, setToSettle] = useState<Payable | null>(null);
 const [settling, setSettling] = useState(false);
 const [settleError, setSettleError] = useState('');

 const [paying, setPaying] = useState<Settlement | null>(null);
 const [form, setForm] = useState({ method: 'bank_transfer', reference: '', receiptUrl: '', note: '' });
 const [payError, setPayError] = useState('');
 const [needsRefresh, setNeedsRefresh] = useState(false);
 const [account, setAccount] = useState<RevealedAccount | null>(null);
 const [busy, setBusy] = useState(false);

 const load = useCallback(async () => {
 setLoading(true);
 setError('');
 try {
 if (tab === 'payables') {
 const { data } = await api.get('/finance/payables', { params: beneficiary ? { beneficiary } : {} });
 setPayables(data.data ?? []);
 } else {
 const { data } = await api.get('/finance/settlements', {
 params: {
 page,
 limit: 25,
 ...(beneficiary ? { beneficiary } : {}),
 ...(status ? { paymentStatus: status } : {}),
 },
 });
 setItems(data.data ?? []);
 setMeta(data.meta ?? { total: 0, totalPages: 1, limit: 25 });
 }
 } catch (err) {
 setError(apiMessage(err, 'No se pudieron cargar las liquidaciones.'));
 } finally {
 setLoading(false);
 }
 }, [tab, beneficiary, status, page]);

 useEffect(() => {
 load();
 }, [load]);

 const runSettle = async () => {
 if (!toSettle) return;
 setSettling(true);
 setSettleError('');
 try {
 await api.post('/finance/settlements', {
 beneficiary: toSettle.beneficiary,
 ...(toSettle.businessId ? { businessId: toSettle.businessId } : { driverId: toSettle.driverId }),
 });
 setToSettle(null);
 setNotice(`Liquidación creada para ${toSettle.name ?? 'el beneficiario'}. Falta registrar el pago.`);
 // Llevar a donde está el siguiente paso: pagarla.
 setStatus('pending');
 setPage(1);
 setTab('history');
 } catch (err) {
 setSettleError(apiMessage(err, 'No se pudo liquidar.'));
 } finally {
 setSettling(false);
 }
 };

 const openPay = (s: Settlement) => {
 setPaying(s);
 setForm({ method: 'bank_transfer', reference: '', receiptUrl: '', note: '' });
 setPayError('');
 setNeedsRefresh(false);
 setAccount(null);
 };

 const closePay = () => {
 setPaying(null);
 // El número de cuenta completo no se queda en memoria de la pantalla.
 setAccount(null);
 };

 const reveal = async () => {
 if (!paying) return;
 setBusy(true);
 setPayError('');
 try {
 const { data } = await api.get(`/finance/settlements/${paying._id}/payout-account`);
 setAccount(data.data);
 if (data.data.changedSinceSettlement) setNeedsRefresh(true);
 } catch (err) {
 setPayError(apiMessage(err, 'No se pudo consultar la cuenta.'));
 if (apiErrorCode(err) === 'PAYOUT_ACCOUNT_SNAPSHOT_MISSING') setNeedsRefresh(true);
 } finally {
 setBusy(false);
 }
 };

 const refreshAccount = async () => {
 if (!paying) return;
 setBusy(true);
 setPayError('');
 try {
 await api.post(`/finance/settlements/${paying._id}/payout-account/refresh`);
 setNeedsRefresh(false);
 setAccount(null);
 await reveal();
 } catch (err) {
 setPayError(apiMessage(err, 'No se pudo refrescar la cuenta. Revisa que el comercio tenga una cuenta verificada.'));
 } finally {
 setBusy(false);
 }
 };

 const issueDocument = async (s: Settlement) => {
 setNotice('');
 setError('');
 try {
 const { data } = await api.post(`/finance/settlements/${s._id}/document`);
 setNotice(`Comprobante ${data.data.number} listo. Consúltalo en Comprobantes.`);
 } catch (err) {
 setError(apiMessage(err, 'No se pudo emitir el comprobante.'));
 }
 };

 const submitPay = async () => {
 if (!paying) return;
 const reference = form.reference.trim();
 const receiptUrl = form.receiptUrl.trim();
 if (reference.length < 3) return setPayError('Escribe la referencia de la transferencia.');
 if (!/^https?:\/\//i.test(receiptUrl)) return setPayError('El comprobante es obligatorio: pega su enlace (https://…).');

 setBusy(true);
 setPayError('');
 try {
 await api.post(`/finance/settlements/${paying._id}/payment`, {
 method: form.method,
 reference,
 receiptUrl,
 ...(form.note.trim() ? { note: form.note.trim() } : {}),
 });
 setNotice(`Pago registrado: ${money(paying.netAmount)} · ref. ${reference}.`);
 closePay();
 load();
 } catch (err) {
 setPayError(apiMessage(err, 'No se pudo registrar el pago.'));
 const code = apiErrorCode(err);
 if (code === 'PAYOUT_ACCOUNT_SNAPSHOT_MISSING' || code === 'PAYOUT_ACCOUNT_CHANGED') setNeedsRefresh(true);
 } finally {
 setBusy(false);
 }
 };

 const totalPayable = payables.filter((p) => p.net > 0).reduce((sum, p) => sum + p.net, 0);

 const tabButton = (id: Tab, text: string) => (
 <button
 key={id}
 onClick={() => { setTab(id); setPage(1); setNotice(''); }}
 className={`cursor-pointer border-b-2 px-3 py-1.5 text-xs font-bold uppercase tracking-wider transition-all ${
 tab === id
 ? 'border-[var(--color-primary)] text-[var(--color-primary)]'
 : 'border-transparent text-[var(--color-text-main)] hover:text-[var(--color-text-main)]'
 }`}
 >
 {text}
 </button>
 );

 return (
 <div className="space-y-4 animate-fade-in">
 <div className="page-header">
 <div>
 <h1 className="page-title">Liquidaciones</h1>
 <p className="page-subtitle">Lo que se debe a comercios y domiciliarios, y el registro de cada pago semanal</p>
 </div>
 <div className="flex gap-1">
 {tabButton('payables', 'Por liquidar')}
 {tabButton('history', 'Historial')}
 </div>
 </div>

 <div className="flex flex-wrap items-center gap-3 text-xs">
 <select
 value={beneficiary}
 onChange={(e) => { setBeneficiary(e.target.value as typeof beneficiary); setPage(1); }}
 className="h-9 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2 font-semibold text-[var(--color-text-main)]"
 aria-label="Beneficiario"
 >
 <option value="">Comercios y domiciliarios</option>
 <option value="business">Solo comercios</option>
 <option value="driver">Solo domiciliarios</option>
 </select>
 {tab === 'history' && (
 <select
 value={status}
 onChange={(e) => { setStatus(e.target.value as typeof status); setPage(1); }}
 className="h-9 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2 font-semibold text-[var(--color-text-main)]"
 aria-label="Estado del pago"
 >
 <option value="pending">Pendientes de pago</option>
 <option value="paid">Pagadas</option>
 <option value="">Todas</option>
 </select>
 )}
 {tab === 'payables' && !loading && payables.length > 0 && (
 <span className="text-[var(--color-text-main)]">
 Listo para liquidar: <strong className="text-[var(--color-text-main)]">{money(totalPayable)}</strong>
 </span>
 )}
 </div>

 {notice && <p className="text-xs font-semibold text-[var(--color-primary)]">{notice}</p>}
 {error && (
 <p className="flex items-center gap-2 text-xs font-semibold text-[var(--color-danger)]">
 <ShieldAlert className="h-4 w-4 shrink-0" /> {error}
 </p>
 )}

 {loading ? (
 <p className="py-10 text-center text-xs font-semibold text-[var(--color-text-main)]">Cargando…</p>
 ) : tab === 'payables' ? (
 payables.length === 0 ? (
 <p className="py-10 text-center text-xs text-[var(--color-text-main)]">
 No hay nada pendiente de liquidar. Los pagos aparecen aquí cuando el pedido se entrega y se cobra.
 </p>
 ) : (
 <div className="table-container">
 <div className="overflow-x-auto">
 <table className="data-grid">
 <thead>
 <tr className="text-left">
 <th className="table-header-cell">Beneficiario</th>
 <th className="table-header-cell">Tipo</th>
 <th className="table-header-cell">Pagos</th>
 <th className="table-header-cell">Saldos en contra</th>
 <th className="table-header-cell">Días esperando</th>
 <th className="table-header-cell">Neto</th>
 <th className="table-header-cell">Acción</th>
 </tr>
 </thead>
 <tbody>
 {payables.map((p) => {
 const key = p.businessId ?? p.driverId ?? '';
 return (
 <tr key={`${p.beneficiary}:${key}`}>
 <td className="table-body-cell">
 <EntityLink type={p.beneficiary === 'business' ? 'business' : 'driver'} id={key}>
 {p.name ?? 'Sin nombre'}
 </EntityLink>
 </td>
 <td className="table-body-cell text-[var(--color-text-main)]">{BENEFICIARY_LABEL[p.beneficiary]}</td>
 <td className="table-body-cell text-[var(--color-text-main)]">{p.count}</td>
 <td className="table-body-cell text-[var(--color-text-main)]">{p.clawbackCount > 0 ? p.clawbackCount : '—'}</td>
 <td className="table-body-cell text-[var(--color-text-main)]">{p.daysWaiting}</td>
 <td className={`table-body-cell ${p.net > 0 ? 'text-[var(--color-text-main)]' : 'text-[var(--color-danger)]'}`}>{money(p.net)}</td>
 <td className="table-body-cell">
 {p.net <= 0 ? (
 <span className="text-[var(--color-text-main)]">Saldo en contra: se descuenta en su próxima liquidación o se cobra desde Finanzas.</span>
 ) : canProcess ? (
 <button onClick={() => { setToSettle(p); setSettleError(''); }} className="cursor-pointer text-[var(--color-primary)]">
 Liquidar
 </button>
 ) : null}
 </td>
 </tr>
 );
 })}
 </tbody>
 </table>
 </div>
 </div>
 )
 ) : items.length === 0 ? (
 <p className="py-10 text-center text-xs text-[var(--color-text-main)]">No hay liquidaciones con este filtro.</p>
 ) : (
 <>
 <div className="table-container">
 <div className="overflow-x-auto">
 <table className="data-grid">
 <thead>
 <tr className="text-left">
 <th className="table-header-cell">Beneficiario</th>
 <th className="table-header-cell">Tipo</th>
 <th className="table-header-cell">Fecha</th>
 <th className="table-header-cell">Pagos</th>
 <th className="table-header-cell">Bruto</th>
 <th className="table-header-cell">Reversado</th>
 <th className="table-header-cell">Publicidad</th>
 <th className="table-header-cell">Saldo en contra</th>
 <th className="table-header-cell">Neto</th>
 <th className="table-header-cell">Estado</th>
 <th className="table-header-cell">Pago</th>
 <th className="table-header-cell">Acción</th>
 </tr>
 </thead>
 <tbody>
 {items.map((s) => {
 const name = s.beneficiary === 'business' ? s.businessName : s.driverName;
 const key = s.beneficiary === 'business' ? s.businessId : s.driverId;
 return (
 <tr key={s._id}>
 <td className="table-body-cell">
 <EntityLink type={s.beneficiary === 'business' ? 'business' : 'driver'} id={key}>
 {name ?? 'Sin nombre'}
 </EntityLink>
 </td>
 <td className="table-body-cell text-[var(--color-text-main)]">{BENEFICIARY_LABEL[s.beneficiary]}</td>
 <td className="table-body-cell text-[var(--color-text-main)]">{day(s.createdAt)}</td>
 <td className="table-body-cell text-[var(--color-text-main)]">{s.payoutCount}</td>
 <td className="table-body-cell text-[var(--color-text-main)]">{money(s.grossAmount)}</td>
 <td className="table-body-cell text-[var(--color-text-main)]">{s.reversedAmount > 0 ? `−${money(s.reversedAmount)}` : '—'}</td>
 <td className="table-body-cell text-[var(--color-text-main)]">{s.adSpendAmount > 0 ? `−${money(s.adSpendAmount)}` : '—'}</td>
 <td className="table-body-cell text-[var(--color-text-main)]">{s.clawbackAmount > 0 ? `−${money(s.clawbackAmount)}` : '—'}</td>
 <td className="table-body-cell text-[var(--color-text-main)]">{money(s.netAmount)}</td>
 <td className={`table-body-cell ${s.paymentStatus === 'paid' ? 'text-[var(--color-success)]' : 'text-[var(--color-warning)]'}`}>
 {s.paymentStatus === 'paid' ? 'Pagada' : 'Falta pagar'}
 </td>
 <td className="table-body-cell text-[var(--color-text-main)]">
 {s.paymentStatus === 'paid' ? (
 <>
 {day(s.paidAt ?? undefined)} · {METHOD_LABEL[s.paymentMethod ?? ''] ?? s.paymentMethod} · ref. {s.reference}
 {s.receiptUrl && (
 <>
 {' · '}
 <a href={s.receiptUrl} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:text-[var(--color-primary)]">
 comprobante
 </a>
 </>
 )}
 </>
 ) : '—'}
 </td>
 <td className="table-body-cell">
 {s.paymentStatus === 'paid' && canManage && (
 <button onClick={() => issueDocument(s)} className="cursor-pointer text-[var(--color-primary)]">
 Emitir comprobante
 </button>
 )}
 {s.paymentStatus === 'pending' && canProcess && (
 <button onClick={() => openPay(s)} className="cursor-pointer text-[var(--color-primary)]">
 Registrar pago
 </button>
 )}
 </td>
 </tr>
 );
 })}
 </tbody>
 </table>
 </div>
 </div>
 <Pagination page={page} totalPages={meta.totalPages} total={meta.total} limit={meta.limit} onPageChange={setPage} />
 </>
 )}

 {toSettle && (
 <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-xs animate-fade-in">
 <div className="zipp-modal w-full max-w-sm space-y-3 rounded-2xl p-6">
 <div className="flex items-start justify-between gap-3">
 <div>
 <h3 className="text-base font-bold text-[var(--color-text-main)]">Liquidar a {toSettle.name ?? 'beneficiario'}</h3>
 <p className="text-xs text-[var(--color-text-main)]">
 {toSettle.count} {toSettle.count === 1 ? 'pago' : 'pagos'} · neto {money(toSettle.net)}
 </p>
 </div>
 <button onClick={() => setToSettle(null)} aria-label="Cerrar" className="cursor-pointer p-1 text-[var(--color-text-main)]">
 <X className="h-4 w-4" />
 </button>
 </div>
 <p className="text-[11px] text-[var(--color-text-main)]">
 Esto reclama los pagos y fija el neto (con la publicidad y los saldos en contra ya descontados). No mueve dinero: el pago se registra después, con su comprobante.
 {toSettle.beneficiary === 'business' && ' La cuenta del comercio debe estar verificada.'}
 </p>
 {settleError && <p className="text-xs font-semibold text-[var(--color-danger)]">{settleError}</p>}
 <button
 onClick={runSettle}
 disabled={settling}
 className="h-10 w-full cursor-pointer rounded-lg bg-[var(--color-primary)] text-xs font-bold uppercase tracking-wider text-white disabled:opacity-60"
 >
 {settling ? 'Liquidando…' : 'Crear liquidación'}
 </button>
 </div>
 </div>
 )}

 {paying && (
 <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-xs animate-fade-in">
 <div className="zipp-modal max-h-[90vh] w-full max-w-md space-y-3 overflow-y-auto rounded-2xl p-6">
 <div className="flex items-start justify-between gap-3">
 <div>
 <h3 className="text-base font-bold text-[var(--color-text-main)]">Registrar pago</h3>
 <p className="text-xs text-[var(--color-text-main)]">
 {(paying.beneficiary === 'business' ? paying.businessName : paying.driverName) ?? 'Beneficiario'} · {money(paying.netAmount)}
 </p>
 </div>
 <button onClick={closePay} aria-label="Cerrar" className="cursor-pointer p-1 text-[var(--color-text-main)]">
 <X className="h-4 w-4" />
 </button>
 </div>

 {paying.beneficiary === 'business' && canReveal && (
 <div className="space-y-2 border-y border-[var(--color-border-light)] py-3">
 {account ? (
 <dl className="space-y-1 text-xs">
 <div className="flex justify-between gap-3"><dt className="text-[var(--color-text-main)]">Medio</dt><dd className="font-semibold text-[var(--color-text-main)]">{account.method === 'bank' ? `${account.bankName ?? 'Banco'} · ${account.accountType ?? ''}` : METHOD_LABEL[account.method] ?? account.method}</dd></div>
 <div className="flex justify-between gap-3"><dt className="text-[var(--color-text-main)]">Número</dt><dd className="font-mono font-semibold text-[var(--color-text-main)]">{account.accountNumber}</dd></div>
 <div className="flex justify-between gap-3"><dt className="text-[var(--color-text-main)]">Titular</dt><dd className="font-semibold text-[var(--color-text-main)]">{account.holderName}</dd></div>
 {account.holderDocument && (
 <div className="flex justify-between gap-3"><dt className="text-[var(--color-text-main)]">Documento</dt><dd className="font-mono font-semibold text-[var(--color-text-main)]">{account.holderDocument}</dd></div>
 )}
 <p className="pt-1 text-[10px] text-[var(--color-text-main)]">Esta es la cuenta verificada al liquidar. Cada consulta queda auditada.</p>
 </dl>
 ) : (
 <button
 onClick={reveal}
 disabled={busy}
 className="flex cursor-pointer items-center gap-1.5 text-xs font-semibold text-[var(--color-primary)] disabled:opacity-60"
 >
 <Eye className="h-3.5 w-3.5" /> Ver la cuenta a la que se paga
 </button>
 )}
 {needsRefresh && (
 <div className="space-y-1">
 <p className="text-[11px] font-semibold text-[var(--color-warning)]">
 La cuenta cambió o falta el registro de la cuenta de esta liquidación. Refréscala con la cuenta verificada actual antes de pagar.
 </p>
 <button
 onClick={refreshAccount}
 disabled={busy}
 className="flex cursor-pointer items-center gap-1.5 text-xs font-semibold text-[var(--color-primary)] disabled:opacity-60"
 >
 <RefreshCw className="h-3.5 w-3.5" /> Refrescar cuenta
 </button>
 </div>
 )}
 </div>
 )}

 <label className="block space-y-1">
 <span className={label}>Medio de pago</span>
 <select value={form.method} onChange={(e) => setForm((f) => ({ ...f, method: e.target.value }))} className={input}>
 {Object.entries(METHOD_LABEL).map(([id, text]) => (
 <option key={id} value={id}>{text}</option>
 ))}
 </select>
 </label>
 <label className="block space-y-1">
 <span className={label}>Referencia de la transferencia</span>
 <input value={form.reference} onChange={(e) => setForm((f) => ({ ...f, reference: e.target.value }))} maxLength={120} className={input} />
 </label>
 <label className="block space-y-1">
 <span className={label}>Enlace del comprobante</span>
 <input value={form.receiptUrl} onChange={(e) => setForm((f) => ({ ...f, receiptUrl: e.target.value }))} placeholder="https://..." className={input} />
 </label>
 <label className="block space-y-1">
 <span className={label}>Nota (opcional)</span>
 <input value={form.note} onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} maxLength={500} className={input} />
 </label>

 <p className="text-[11px] text-[var(--color-text-main)]">
 Al registrar, la liquidación queda pagada y el libro asienta el desembolso. No se puede deshacer ni pagar dos veces.
 </p>
 {payError && <p className="text-xs font-semibold text-[var(--color-danger)]">{payError}</p>}
 <button
 onClick={submitPay}
 disabled={busy}
 className="h-10 w-full cursor-pointer rounded-lg bg-[var(--color-primary)] text-xs font-bold uppercase tracking-wider text-white disabled:opacity-60"
 >
 {busy ? 'Registrando…' : `Registrar pago de ${money(paying.netAmount)}`}
 </button>
 </div>
 </div>
 )}
 </div>
 );
}
