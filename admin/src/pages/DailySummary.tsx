import { useEffect, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, Printer, RefreshCw, X } from 'lucide-react';
import api from '../services/api';
import { apiMessage } from '../lib/apiError';
import { PermissionGate } from '../components/PermissionGate';
import { Permission } from '../lib/permissions';

// ── Tipos (espejo de dailySummary.service.ts y dailySummaryFinance.service.ts) ──
// Las cifras de dinero llegan opcionales: sin `finance:view` el backend las quita.

interface DaySnapshot {
 date: string;
 ordersCreated: number;
 ordersDelivered: number;
 ordersCancelled: number;
 avgTicket?: number;
 avgDeliveryMinutes: number;
 gmv?: number;
 platformGrossRevenue?: number;
 promotionExpense?: number;
 netRevenue?: number;
 driverPayouts?: number;
 driverDeliveryPayouts?: number;
 deliveryFees?: number;
 tips?: number;
 platformResult?: {
 processingExpense: number;
 driverFeeAbsorbed: number;
 cashShortageExpense: number;
 badDebt: number;
 incomplete: boolean;
 incompleteReason: string;
 };
 payDigitalCount: number;
 payCashCount: number;
 activeBusinesses: number;
 buyers: number;
 newClients: number;
 newBusinesses: number;
 newDrivers: number;
 activeDrivers: number;
 reviewsCount: number;
 avgBusinessRating: number;
 avgDriverRating: number;
 lowRatingsCount: number;
 pqrsOpened: number;
 refundsCount: number;
 refundsAmount?: number;
}

interface ComparisonRow {
 metric: string;
 label: string;
 today: number;
 baseline: number;
 deltaAbs: number;
 deltaPct: number | null;
 direction: 'up' | 'down' | 'flat';
 goodWhenUp: boolean;
}

interface HealthFlag {
 level: 'ok' | 'warn' | 'critical';
 code: string;
 message: string;
}

interface PayableSide {
 ledgerBalance: number;
 accrued: number | null;
 payable: number | null;
 claimedUnpaid: number | null;
}

interface PendingMoney {
 asOf: 'close_of_day' | 'now';
 merchants: PayableSide;
 drivers: PayableSide;
 tipsPending: number | null;
 refundsPending: { count: number; amount: number };
 cashToReconcile: { count: number; amount: number };
}

interface GatewayStatus {
 state: 'no_charges' | 'not_configured' | 'incomplete' | 'ok';
 booked: number;
 charges: number;
 missing: number;
}

interface DailySummary {
 date: string;
 generatedAt: string;
 today: DaySnapshot;
 baseline: DaySnapshot;
 comparison: ComparisonRow[];
 monthComparison: ComparisonRow[];
 flags: HealthFlag[];
 pqrsByType: Array<{ type: string; count: number }>;
 ordersInProgressNow: number | null;
 operation: { pending: number; preparing: number; onWay: number };
 pending?: PendingMoney;
 gateway?: GatewayStatus;
}

interface DetailRow {
 orderId: string;
 orderNumber: string;
 status: string;
 paymentMethod: string;
 closedAt: string | null;
 gmv: number;
 commission: number;
 serviceFee: number;
 deliveryMargin: number;
 merchantFundedDiscount: number;
 platformFundedDiscount: number;
 businessPayout: number;
 driverPayout: number;
 tip: number;
 gatewayFee: number | null;
 refunded: number;
 paymentStatus: string | null;
 cashStatus: string | null;
 businessPayoutStatus: string | null;
 driverPayoutStatus: string | null;
}

interface DetailPage {
 date: string;
 page: number;
 limit: number;
 total: number;
 rows: DetailRow[];
}

// ── Helpers ────────────────────────────────────────────────────────

const money = (v: number | undefined | null) => (v == null ? '—' : `$${Math.round(v).toLocaleString('es-CO')}`);
const num = (v: number | undefined | null) => (v == null ? '—' : v.toLocaleString('es-CO'));

const todayStr = () => {
 const d = new Date();
 return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const shift = (dateStr: string, delta: number) => {
 const [y, m, d] = dateStr.split('-').map(Number);
 const dt = new Date(y, m - 1, d + delta);
 return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
};
const longDate = (dateStr: string) => {
 const [y, m, d] = dateStr.split('-').map(Number);
 return new Date(y, m - 1, d).toLocaleDateString('es-CO', {
 weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
 });
};

const PQRS_LABEL: Record<string, string> = {
 petition: 'Peticiones', complaint: 'Quejas', claim: 'Reclamos', suggestion: 'Sugerencias',
};

const STATUS_LABEL: Record<string, string> = {
 delivered: 'Entregado', cancelled: 'Cancelado',
 paid: 'Pagado', refunded: 'Reembolsado', pending: 'Pendiente', failed: 'Fallido',
 pending_cash: 'Efectivo por cobrar', cash_received: 'Efectivo recibido',
 reported: 'Reportado', verified: 'Verificado', settled: 'Liquidado', overdue: 'Vencido',
 accrued: 'Devengado', payable: 'Exigible', reversed: 'Revertido',
 online: 'Digital', cash_on_delivery: 'Efectivo',
};
const label = (v: string | null) => (v ? STATUS_LABEL[v] ?? v : '—');

// ── Bloques de presentación ────────────────────────────────────────

function Section({ title, hint, children, className = '' }: {
 title: string; hint?: string; children: React.ReactNode; className?: string;
}) {
 return (
 <section className={`min-h-0 lg:overflow-y-auto print:overflow-visible ${className}`}>
 <div className="mb-2 pb-1.5 border-b border-[var(--color-border)]">
 <h2 className="text-sm font-bold text-[var(--color-text-main)]">{title}</h2>
 {hint ? <p className="text-[10px] text-[var(--color-text-secondary)]">{hint}</p> : null}
 </div>
 {children}
 </section>
 );
}

function Line({ label, value, strong, muted, note }: {
 label: string; value: string; strong?: boolean; muted?: boolean; note?: string;
}) {
 return (
 <div className="py-[3px] text-xs">
 <div className="flex items-center justify-between gap-3">
 <span className={muted ? 'text-[var(--color-text-secondary)]' : 'text-[var(--color-text-main)]'}>{label}</span>
 <span className={`tabular ${strong ? 'font-bold' : 'font-semibold'} text-[var(--color-text-main)]`}>{value}</span>
 </div>
 {note ? <p className="text-[10px] text-[var(--color-text-secondary)]">{note}</p> : null}
 </div>
 );
}

/** Variación contra una referencia, con el color que dicta si subir es bueno. */
function Delta({ row, suffix }: { row?: ComparisonRow; suffix: string }) {
 if (!row) return null;
 const improved = row.direction === 'flat' ? null : (row.direction === 'up') === row.goodWhenUp;
 const color = improved == null
 ? 'text-[var(--color-text-secondary)]'
 : improved ? 'text-[#059669]' : 'text-[var(--color-danger)]';
 const text = row.deltaPct == null
 ? (row.deltaAbs === 0 ? '0' : `${row.deltaAbs > 0 ? '+' : ''}${num(row.deltaAbs)}`)
 : `${row.deltaPct > 0 ? '+' : ''}${row.deltaPct}%`;
 return <span className={`tabular ${color}`}>{text} {suffix}</span>;
}

function Kpi({ label, value, hint, week, month }: {
 label: string; value: string; hint?: string; week?: ComparisonRow; month?: ComparisonRow;
}) {
 return (
 <div className="min-w-0">
 <p className="text-[11px] font-semibold text-[var(--color-text-secondary)] truncate">{label}</p>
 <p className="kpi-value text-xl">{value}</p>
 {hint ? <p className="text-[10px] text-[var(--color-text-secondary)] truncate">{hint}</p> : null}
 {(week || month) && (
 <p className="text-[10px] flex gap-2 flex-wrap">
 <Delta row={week} suffix="sem." />
 <Delta row={month} suffix="mes" />
 </p>
 )}
 </div>
 );
}

function HealthFlags({ flags }: { flags: HealthFlag[] }) {
 const style: Record<HealthFlag['level'], string> = {
 ok: 'text-[#059669]',
 warn: 'text-[var(--color-chart-purple)]',
 critical: 'text-[var(--color-danger)]',
 };
 const shown = flags.filter((f) => f.level !== 'ok');
 if (shown.length === 0) {
 return <p className="text-xs font-semibold text-[#059669]">Nada fuera de lo normal en el cierre del día.</p>;
 }
 return (
 <div className="flex flex-wrap gap-x-6 gap-y-1">
 {shown.map((f) => (
 <p key={f.code + f.message} className={`text-xs font-semibold ${style[f.level]}`}>{f.message}</p>
 ))}
 </div>
 );
}

function gatewayNote(g: GatewayStatus | undefined): string | undefined {
 if (!g) return undefined;
 if (g.state === 'not_configured') return 'Sin configurar: hay cobros en línea sin comisión asentada.';
 if (g.state === 'incomplete') return `Incompleta: ${g.missing} de ${g.charges} cobros sin comisión asentada.`;
 if (g.state === 'no_charges') return 'Sin cobros en línea este día.';
 return undefined;
}

// ── Detalle financiero (superficie flotante) ───────────────────────

function FinanceDetail({ date, onClose }: { date: string; onClose: () => void }) {
 const [page, setPage] = useState(1);
 const [data, setData] = useState<DetailPage | null>(null);
 const [error, setError] = useState('');
 const [loading, setLoading] = useState(true);

 useEffect(() => {
 let alive = true;
 setLoading(true);
 setError('');
 api.get('/admin/daily-summary/finance-detail', { params: { date, page, limit: 50 } })
 .then((res) => { if (alive) setData(res.data.data); })
 .catch((err) => { if (alive) setError(apiMessage(err, 'No se pudo cargar el detalle financiero.')); })
 .finally(() => { if (alive) setLoading(false); });
 return () => { alive = false; };
 }, [date, page]);

 const pages = data ? Math.max(1, Math.ceil(data.total / data.limit)) : 1;

 return createPortal(
 <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4 no-print" onClick={onClose}>
 <div
 className="zipp-modal w-full max-w-[96vw] max-h-[90vh] flex flex-col rounded-xl shadow-xl bg-[var(--color-bg)] p-5"
 onClick={(e) => e.stopPropagation()}
 role="dialog"
 aria-label="Detalle financiero del día"
 >
 <div className="flex items-start justify-between gap-4 mb-3">
 <div>
 <h2 className="text-base font-bold text-[var(--color-text-main)]">Detalle financiero</h2>
 <p className="text-xs text-[var(--color-text-secondary)] capitalize">
 {longDate(date)} · pedidos entregados y cancelados ese día
 </p>
 </div>
 <button onClick={onClose} className="p-1 text-[var(--color-text-main)] hover:text-[var(--color-primary)] cursor-pointer" aria-label="Cerrar">
 <X className="w-4 h-4" />
 </button>
 </div>

 <div className="overflow-auto flex-1 min-h-0">
 {loading && !data ? (
 <p className="py-8 text-center text-xs text-[var(--color-text-secondary)]">Cargando…</p>
 ) : error ? (
 <p className="py-8 text-center text-xs text-[var(--color-danger)]">{error}</p>
 ) : data && data.rows.length === 0 ? (
 <p className="py-8 text-center text-xs text-[var(--color-text-secondary)]">Sin pedidos cerrados este día.</p>
 ) : data ? (
 <table className="data-grid min-w-[1200px] text-xs">
 <thead className="sticky top-0 bg-[var(--color-bg)]">
 <tr className="text-left text-[10px] uppercase tracking-wider text-[var(--color-text-secondary)] border-b border-[var(--color-border)]">
 <th className="py-1.5 pr-3 font-semibold">Pedido</th>
 <th className="pr-3 font-semibold">Estado</th>
 <th className="pr-3 font-semibold">Pago</th>
 <th className="pr-3 font-semibold text-right">GMV</th>
 <th className="pr-3 font-semibold text-right">Comisión</th>
 <th className="pr-3 font-semibold text-right">Tarifa serv.</th>
 <th className="pr-3 font-semibold text-right">Margen dom.</th>
 <th className="pr-3 font-semibold text-right">Desc. comercio</th>
 <th className="pr-3 font-semibold text-right">Desc. ZIPP</th>
 <th className="pr-3 font-semibold text-right">Al comercio</th>
 <th className="pr-3 font-semibold text-right">Al domiciliario</th>
 <th className="pr-3 font-semibold text-right">Propina</th>
 <th className="pr-3 font-semibold text-right">Wompi</th>
 <th className="pr-3 font-semibold text-right">Reembolsos</th>
 <th className="font-semibold">Conciliación</th>
 </tr>
 </thead>
 <tbody className="divide-y divide-[var(--color-border)]">
 {data.rows.map((r) => (
 <tr key={r.orderId} className="text-[var(--color-text-main)]">
 <td className="py-1 pr-3 font-semibold">{r.orderNumber}</td>
 <td className="pr-3">{label(r.status)}</td>
 <td className="pr-3">{label(r.paymentMethod)}</td>
 <td className="pr-3 text-right tabular">{money(r.gmv)}</td>
 <td className="pr-3 text-right tabular">{money(r.commission)}</td>
 <td className="pr-3 text-right tabular">{money(r.serviceFee)}</td>
 <td className="pr-3 text-right tabular">{money(r.deliveryMargin)}</td>
 <td className="pr-3 text-right tabular">{money(r.merchantFundedDiscount)}</td>
 <td className="pr-3 text-right tabular">{money(r.platformFundedDiscount)}</td>
 <td className="pr-3 text-right tabular">{money(r.businessPayout)}</td>
 <td className="pr-3 text-right tabular">{money(r.driverPayout)}</td>
 <td className="pr-3 text-right tabular">{money(r.tip)}</td>
 <td className="pr-3 text-right tabular">
 {r.gatewayFee == null ? <span className="text-[var(--color-danger)]">Sin asiento</span> : money(r.gatewayFee)}
 </td>
 <td className="pr-3 text-right tabular">{r.refunded > 0 ? money(r.refunded) : '—'}</td>
 <td className="text-[10px] leading-tight">
 <span>Cobro: {r.cashStatus ? label(r.cashStatus) : label(r.paymentStatus)}</span>
 <br />
 <span className="text-[var(--color-text-secondary)]">
 Comercio: {label(r.businessPayoutStatus)} · Domic.: {label(r.driverPayoutStatus)}
 </span>
 </td>
 </tr>
 ))}
 </tbody>
 </table>
 ) : null}
 </div>

 {data && data.total > data.limit && (
 <div className="flex items-center justify-between pt-3 mt-2 border-t border-[var(--color-border)] text-xs">
 <span className="text-[var(--color-text-secondary)]">{num(data.total)} pedidos · página {page} de {pages}</span>
 <span className="flex gap-2">
 <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className="px-2 py-1 font-semibold text-[var(--color-primary)] disabled:opacity-40 cursor-pointer">Anterior</button>
 <button disabled={page >= pages} onClick={() => setPage((p) => p + 1)} className="px-2 py-1 font-semibold text-[var(--color-primary)] disabled:opacity-40 cursor-pointer">Siguiente</button>
 </span>
 </div>
 )}
 </div>
 </div>,
 document.body,
 );
}

// ── Página ─────────────────────────────────────────────────────────

export default function DailySummary() {
 const [date, setDate] = useState(todayStr());
 const [data, setData] = useState<DailySummary | null>(null);
 const [loading, setLoading] = useState(true);
 const [loadError, setLoadError] = useState('');
 const [showDetail, setShowDetail] = useState(false);

 const load = useCallback(async () => {
 try {
 setLoading(true);
 setLoadError('');
 const res = await api.get(`/admin/daily-summary?date=${date}`);
 setData(res.data.data);
 } catch (err) {
 console.error('Error cargando el resumen diario:', err);
 setLoadError(apiMessage(err, 'No se pudo cargar el resumen de este día.'));
 setData(null);
 } finally {
 setLoading(false);
 }
 }, [date]);

 useEffect(() => { load(); }, [load]);

 const isToday = date === todayStr();
 const t = data?.today;
 const week = (metric: string) => data?.comparison.find((r) => r.metric === metric);
 const month = (metric: string) => data?.monthComparison?.find((r) => r.metric === metric);
 const pr = t?.platformResult;
 const pending = data?.pending;

 return (
 <div className="flex flex-col gap-3 animate-fade-in lg:-m-4 lg:h-[calc(100vh-7rem)] lg:min-h-[640px] print:h-auto">
 <style>{`@media print { aside, header.sticky { display: none !important; } .no-print { display: none !important; } .page-container { padding: 0 !important; } @page { size: A4; margin: 12mm; } html, body, #root { height: auto !important; overflow: visible !important; background: #fff !important; color: #111 !important; } #root > div, main { display: block !important; height: auto !important; overflow: visible !important; background: #fff !important; } * { color-scheme: light !important; box-shadow: none !important; } section { break-inside: avoid; page-break-inside: avoid; } .truncate { overflow: visible !important; white-space: normal !important; } }`}</style>

 {/* Encabezado + navegación de fecha */}
 <div className="page-header !mb-0 shrink-0">
 <div>
 <h1 className="page-title">Resumen Diario</h1>
 <p className="page-subtitle capitalize">{longDate(date)}</p>
 </div>

 <div className="flex items-center gap-1 no-print">
 <button onClick={() => setDate((d) => shift(d, -1))} className="p-2 text-[var(--color-text-main)] hover:text-[var(--color-primary)] transition-colors cursor-pointer" title="Día anterior">
 <ChevronLeft className="w-4 h-4" />
 </button>
 <input
 type="date"
 value={date}
 max={todayStr()}
 onChange={(e) => e.target.value && setDate(e.target.value)}
 className="px-2 py-1.5 text-xs text-[var(--color-text-main)] bg-transparent border-b border-[var(--color-border)] focus:outline-none focus:border-[var(--color-primary)] cursor-pointer"
 />
 <button onClick={() => setDate((d) => shift(d, 1))} disabled={isToday} className="p-2 text-[var(--color-text-main)] hover:text-[var(--color-primary)] transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed" title="Día siguiente">
 <ChevronRight className="w-4 h-4" />
 </button>
 <button onClick={load} className="p-2 text-[var(--color-text-main)] hover:text-[var(--color-primary)] transition-colors cursor-pointer" title="Refrescar">
 <RefreshCw className="w-4 h-4" />
 </button>
 <PermissionGate permission={Permission.FINANCE_VIEW}>
 <button onClick={() => setShowDetail(true)} className="px-3 py-1.5 text-xs font-bold text-[var(--color-primary)] hover:text-[#8A5D08] transition-colors cursor-pointer">
 Ver detalle financiero
 </button>
 </PermissionGate>
 <button onClick={() => window.print()} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold text-[var(--color-primary)] hover:text-[#8A5D08] transition-colors cursor-pointer">
 <Printer className="w-3.5 h-3.5" />
 Imprimir
 </button>
 </div>
 </div>

 {loading || !t || !data ? (
 <div className="flex flex-col items-center justify-center h-80 text-[var(--color-text-main)] space-y-3">
 <RefreshCw className="w-7 h-7 text-[var(--color-primary)] animate-spin" />
 <p className="text-xs font-semibold">
 {loading ? 'Reconstruyendo el día...' : loadError || 'No se pudo cargar el resumen de este día.'}
 </p>
 </div>
 ) : (
 <>
 <div className="shrink-0"><HealthFlags flags={data.flags} /></div>

 {/* 1 · Pedidos → GMV → Ingresos → Margen (con comparación semana / mes) */}
 <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-y-3 pb-3 border-b border-[var(--color-border)] lg:divide-x divide-[var(--color-border)] lg:[&>*]:px-4 lg:[&>*:first-child]:pl-0 lg:[&>*:last-child]:pr-0 shrink-0">
 <Kpi label="Pedidos entregados" value={num(t.ordersDelivered)}
 hint={isToday && data.ordersInProgressNow != null ? `${num(data.ordersInProgressNow)} sin cerrar` : undefined}
 week={week('ordersDelivered')} month={month('ordersDelivered')} />
 <Kpi label="GMV" value={money(t.gmv)} hint="Lo que pagaron los clientes"
 week={week('gmv')} month={month('gmv')} />
 <Kpi label="Ingresos ZIPP" value={money(t.platformGrossRevenue)}
 week={week('platformGrossRevenue')} month={month('platformGrossRevenue')} />
 <Kpi label="Margen operativo" value={money(t.netRevenue)}
 hint={pr?.incomplete ? 'Sin costo de transferencia' : undefined}
 week={week('netRevenue')} month={month('netRevenue')} />
 <Kpi label="Ticket promedio" value={money(t.avgTicket)}
 week={week('avgTicket')} month={month('avgTicket')} />
 <Kpi label="Cancelaciones" value={num(t.ordersCancelled)}
 hint={`${t.ordersCreated > 0 ? Math.round((t.ordersCancelled / t.ordersCreated) * 100) : 0}% de los creados`}
 week={week('ordersCancelled')} month={month('ordersCancelled')} />
 <Kpi label="Clientes nuevos" value={num(t.newClients)}
 week={week('newClients')} month={month('newClients')} />
 <Kpi label="Comercios activos" value={num(t.activeBusinesses)} hint="Con pedidos entregados"
 week={week('activeBusinesses')} month={month('activeBusinesses')} />
 </div>

 {/* 2 · Dinero: movido / de ZIPP / de terceros */}
 {pending && pr ? (
 <div className="grid grid-cols-1 lg:grid-cols-3 gap-y-4 shrink-0 lg:divide-x divide-[var(--color-border)] lg:[&>*]:px-5 lg:[&>*:first-child]:pl-0 lg:[&>*:last-child]:pr-0">
 <Section title="Dinero movido" hint="Pasa por ZIPP, no es ingreso de ZIPP">
 <Line label="GMV" value={money(t.gmv)} strong />
 <Line label="Domicilios cobrados" value={money(t.deliveryFees)} />
 <Line label="Propinas" value={money(t.tips)} note="Van al domiciliario" />
 <Line label="Pago digital" value={num(t.payDigitalCount)} muted />
 <Line label="Efectivo contra entrega" value={num(t.payCashCount)} muted />
 </Section>

 <Section title="Dinero de ZIPP" hint="Del libro mayor; los reembolsos ya restan del ingreso">
 <Line label="Ingresos (comisión, servicio, margen de domicilio)" value={money(t.platformGrossRevenue)} strong />
 <Line label="Descuentos asumidos por ZIPP" value={`−${money(t.promotionExpense)}`} />
 <Line label="Tarifas de domiciliario asumidas" value={`−${money(pr.driverFeeAbsorbed)}`} />
 <Line label="Faltantes de efectivo y deuda incobrable" value={`−${money(pr.cashShortageExpense + pr.badDebt)}`} />
 <Line label="Comisión de pago (Wompi)" value={`−${money(pr.processingExpense)}`} note={gatewayNote(data.gateway)} />
 <div className="my-1.5 border-t border-[var(--color-border)]" />
 <Line label="Margen operativo" value={money(t.netRevenue)} strong
 note={pr.incomplete ? 'Aún no incluye el costo de transferencia a comercios y domiciliarios.' : undefined} />
 <Line label="Reembolsos del día" value={money(t.refundsAmount)} muted note={`${num(t.refundsCount)} reembolsos completados`} />
 </Section>

 <Section title="Dinero de terceros" hint={pending.asOf === 'now' ? 'Saldos a este momento' : 'Saldos al cierre de ese día'}>
 <Line label="Por pagar a comercios" value={money(pending.merchants.ledgerBalance)} strong
 note={pending.merchants.payable != null
 ? `Exigible ${money(pending.merchants.payable)} · lotes sin pagar ${money(pending.merchants.claimedUnpaid)}`
 : undefined} />
 <Line label="Por pagar a domiciliarios" value={money(pending.drivers.ledgerBalance)} strong
 note={pending.drivers.payable != null
 ? `Exigible ${money(pending.drivers.payable)} · lotes sin pagar ${money(pending.drivers.claimedUnpaid)}`
 : undefined} />
 <Line label="Propinas pendientes" value={pending.tipsPending == null ? 'Solo hoy' : money(pending.tipsPending)}
 note="Incluidas en lo que se debe a domiciliarios" />
 <Line label="Reembolsos pendientes" value={`${num(pending.refundsPending.count)} · ${money(pending.refundsPending.amount)}`}
 note="Fallidos o sin resolver hace más de 15 min" />
 <Line label="Efectivo por conciliar" value={`${num(pending.cashToReconcile.count)} · ${money(pending.cashToReconcile.amount)}`} />
 </Section>
 </div>
 ) : null}

 {/* 3 · Operación · Crecimiento · Calidad (secundaria) */}
 <div className="grid grid-cols-1 lg:grid-cols-3 gap-y-4 flex-1 min-h-0 lg:divide-x divide-[var(--color-border)] lg:[&>*]:px-5 lg:[&>*:first-child]:pl-0 lg:[&>*:last-child]:pr-0">
 <Section title="Operación" hint="Estado actual de los pedidos creados ese día">
 <Line label="Creados" value={num(t.ordersCreated)} strong />
 <Line label="Por aceptar" value={num(data.operation.pending)} muted />
 <Line label="En preparación" value={num(data.operation.preparing)} />
 <Line label="En camino" value={num(data.operation.onWay)} />
 <Line label="Entregados" value={num(t.ordersDelivered)} />
 <Line label="Cancelados" value={num(t.ordersCancelled)} />
 <div className="my-1.5 border-t border-[var(--color-border)]" />
 <Line label="Domiciliarios activos" value={num(t.activeDrivers)} />
 <Line label="Tiempo promedio de entrega" value={`${num(t.avgDeliveryMinutes)} min`} />
 </Section>

 <Section title="Crecimiento" hint="Hoy · vs. semana anterior · vs. mes anterior">
 {([
 ['newClients', 'Clientes nuevos', t.newClients],
 ['newBusinesses', 'Comercios nuevos', t.newBusinesses],
 ['newDrivers', 'Domiciliarios nuevos', t.newDrivers],
 ['buyers', 'Clientes que compraron', t.buyers],
 ] as const).map(([metric, text, value]) => (
 <div key={metric} className="py-[3px] text-xs">
 <div className="flex items-center justify-between gap-3">
 <span className="text-[var(--color-text-main)]">{text}</span>
 <span className="tabular font-semibold text-[var(--color-text-main)]">{num(value)}</span>
 </div>
 <p className="text-[10px] flex gap-3">
 <Delta row={week(metric)} suffix="sem." />
 <Delta row={month(metric)} suffix="mes" />
 </p>
 </div>
 ))}
 </Section>

 <Section title="Calidad y soporte" hint="Secundario">
 <Line label="Calificación del comercio" value={t.avgBusinessRating ? `${t.avgBusinessRating} ★` : '—'} />
 <Line label="Calificación del domiciliario" value={t.avgDriverRating ? `${t.avgDriverRating} ★` : '—'} />
 <Line label="Reseñas del día" value={num(t.reviewsCount)} />
 <Line label="Reseñas negativas (≤ 2★)" value={num(t.lowRatingsCount)} />
 <Line label="PQRS abiertas" value={num(t.pqrsOpened)}
 note={data.pqrsByType.map((p) => `${PQRS_LABEL[p.type] ?? p.type}: ${p.count}`).join(' · ') || undefined} />
 <Line label="Reembolsos" value={num(t.refundsCount)} />
 </Section>
 </div>

 <p className="text-[10px] text-[var(--color-text-secondary)] text-right shrink-0">
 Generado {new Date(data.generatedAt).toLocaleString('es-CO')}
 </p>
 </>
 )}

 {showDetail && <FinanceDetail date={date} onClose={() => setShowDetail(false)} />}
 </div>
 );
}
