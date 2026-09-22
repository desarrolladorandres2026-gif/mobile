import { useEffect, useState, useCallback } from 'react';
import {
  ChevronLeft, ChevronRight, Printer, RefreshCw, TriangleAlert,
  CircleCheck, PackageCheck, PackageX, Package, Wallet, CreditCard,
  Banknote, Store, Truck, UserPlus, Star, RotateCcw, MessageSquareWarning,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import api from '../services/api';

// ── Tipos (espejo de dailySummary.service.ts) ──────────────────────

interface DaySnapshot {
  date: string;
  ordersCreated: number;
  ordersDelivered: number;
  ordersCancelled: number;
  avgTicket: number;
  avgDeliveryMinutes: number;
  gmv: number;
  platformGrossRevenue: number;
  promotionExpense: number;
  netRevenue: number;
  businessPayouts: number;
  driverPayouts: number;
  tips: number;
  tax: number;
  merchantFundedDiscount: number;
  platformFundedDiscount: number;
  payDigitalCount: number;
  payDigitalAmount: number;
  payCashCount: number;
  payCashAmount: number;
  newClients: number;
  newBusinesses: number;
  newDrivers: number;
  activeDrivers: number;
  deliveriesPerActiveDriver: number;
  reviewsCount: number;
  avgBusinessRating: number;
  avgDriverRating: number;
  lowRatingsCount: number;
  pqrsOpened: number;
  refundsCount: number;
  refundsAmount: number;
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

interface TopBusiness {
  businessId: string;
  name: string;
  orders: number;
  gmv: number;
}

interface DailySummary {
  date: string;
  generatedAt: string;
  today: DaySnapshot;
  baseline: DaySnapshot;
  comparison: ComparisonRow[];
  flags: HealthFlag[];
  pqrsByType: Array<{ type: string; count: number }>;
  newUsersByRole: Array<{ role: string; count: number }>;
  topBusinessesByOrders: TopBusiness[];
  topBusinessesByGmv: TopBusiness[];
  cashByStatus: Array<{ status: string; count: number; amount: number }>;
  ordersInProgressNow: number | null;
}

// ── Helpers ────────────────────────────────────────────────────────

const money = (v: number) => `$${Math.round(v ?? 0).toLocaleString('es-CO')}`;
const num = (v: number) => (v ?? 0).toLocaleString('es-CO');

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
const ROLE_LABEL: Record<string, string> = {
  client: 'Clientes', driver: 'Domiciliarios', business: 'Comercios', admin: 'Admins',
};
const CASH_LABEL: Record<string, string> = {
  pending: 'Por rendir', reported: 'Reportado', verified: 'Verificado',
  settled: 'Liquidado', overdue: 'Vencido',
};

// ── Bloques de presentación ────────────────────────────────────────

function Card({ title, icon: Icon, children }: { title: string; icon: LucideIcon; children: React.ReactNode }) {
  return (
    <div className="zipp-card p-5">
      <div className="flex items-center gap-2 mb-4 pb-3 border-b border-[var(--color-border-light)] dark:border-[#232E46]">
        <Icon className="w-4 h-4 text-[var(--color-primary)]" strokeWidth={1.8} />
        <h2 className="text-sm font-bold text-[var(--color-text-main)] dark:text-white">{title}</h2>
      </div>
      {children}
    </div>
  );
}

function Line({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between py-1.5 text-xs">
      <span className="text-[var(--color-text-secondary)] dark:text-[#7C8BA1]">{label}</span>
      <span className={`tabular ${strong ? 'font-bold text-[var(--color-text-main)] dark:text-white' : 'font-semibold text-[var(--color-text-main)] dark:text-[#EDF1F5]'}`}>
        {value}
      </span>
    </div>
  );
}

// ── Página ─────────────────────────────────────────────────────────

export default function DailySummary() {
  const [date, setDate] = useState(todayStr());
  const [data, setData] = useState<DailySummary | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const res = await api.get(`/admin/daily-summary?date=${date}`);
      setData(res.data.data);
    } catch (err) {
      console.error('Error cargando el resumen diario:', err);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [date]);

  useEffect(() => { load(); }, [load]);

  const isToday = date === todayStr();
  const t = data?.today;

  return (
    <div className="space-y-6 animate-fade-in">
      <style>{`@media print { aside, header.sticky { display: none !important; } .no-print { display: none !important; } .page-container { padding: 0 !important; } }`}</style>

      {/* Header + navegación de fecha */}
      <div className="page-header">
        <div>
          <h1 className="page-title">Resumen Diario</h1>
          <p className="page-subtitle capitalize">{longDate(date)}</p>
        </div>

        <div className="flex items-center gap-2 no-print">
          <button
            onClick={() => setDate((d) => shift(d, -1))}
            className="p-2 rounded-lg bg-[var(--color-surface)] dark:bg-[#1B2437] border border-[var(--color-border)] dark:border-[#232E46] text-[var(--color-text-secondary)] hover:text-[var(--color-text-main)] dark:hover:text-white transition-colors cursor-pointer"
            title="Día anterior"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <input
            type="date"
            value={date}
            max={todayStr()}
            onChange={(e) => e.target.value && setDate(e.target.value)}
            className="px-3 py-1.5 text-xs rounded-lg bg-[var(--color-surface)] dark:bg-[#1B2437] border border-[var(--color-border)] dark:border-[#232E46] text-[var(--color-text-main)] dark:text-white focus:outline-none focus:border-[var(--color-primary)] cursor-pointer"
          />
          <button
            onClick={() => setDate((d) => shift(d, 1))}
            disabled={isToday}
            className="p-2 rounded-lg bg-[var(--color-surface)] dark:bg-[#1B2437] border border-[var(--color-border)] dark:border-[#232E46] text-[var(--color-text-secondary)] hover:text-[var(--color-text-main)] dark:hover:text-white transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            title="Día siguiente"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
          <div className="w-px h-6 bg-[var(--color-border)] dark:bg-[#232E46] mx-1" />
          <button
            onClick={load}
            className="p-2 rounded-lg bg-[var(--color-surface)] dark:bg-[#1B2437] border border-[var(--color-border)] dark:border-[#232E46] text-[var(--color-text-secondary)] hover:text-[var(--color-text-main)] dark:hover:text-white transition-colors cursor-pointer"
            title="Refrescar"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
          <button
            onClick={() => window.print()}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-[var(--color-primary)] text-white text-xs font-bold hover:bg-[#8A5D08] transition-colors cursor-pointer shadow-xs"
          >
            <Printer className="w-3.5 h-3.5" />
            Imprimir
          </button>
        </div>
      </div>

      {loading || !t ? (
        <div className="flex flex-col items-center justify-center h-80 text-[var(--color-text-secondary)] space-y-3">
          <RefreshCw className="w-7 h-7 text-[var(--color-primary)] animate-spin" />
          <p className="text-xs font-semibold">
            {loading ? 'Reconstruyendo el día...' : 'No se pudo cargar el resumen de este día.'}
          </p>
        </div>
      ) : (
        <>
          {/* Alertas del cierre */}
          <HealthFlags flags={data!.flags} />

          {/* KPIs del día */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-6 pb-6 border-b border-[var(--color-border-light)] dark:border-[#232E46]">
            <Kpi icon={Package} label="Pedidos creados" value={num(t.ordersCreated)}
              hint={isToday && data!.ordersInProgressNow != null ? `${num(data!.ordersInProgressNow)} sin cerrar ahora` : ''} />
            <Kpi icon={PackageCheck} label="Entregados" value={num(t.ordersDelivered)}
              hint={`Ticket prom. ${money(t.avgTicket)}`} />
            <Kpi icon={PackageX} label="Cancelados" value={num(t.ordersCancelled)}
              hint={`${t.ordersCreated > 0 ? Math.round((t.ordersCancelled / t.ordersCreated) * 100) : 0}% de los creados`} />
            <Kpi icon={Wallet} label="GMV del día" value={money(t.gmv)}
              hint={`Margen neto ${money(t.netRevenue)}`} />
          </div>

          {/* Comparativa vs. mismo día -7 */}
          <Card title="Hoy vs. mismo día de la semana pasada" icon={RotateCcw}>
            <Comparison rows={data!.comparison} baselineDate={data!.baseline.date} />
          </Card>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            {/* Dinero del día */}
            <Card title="Dinero del día" icon={Wallet}>
              <Line label="GMV (lo que pagó el cliente)" value={money(t.gmv)} strong />
              <Line label="Ingreso bruto ZIPP" value={money(t.platformGrossRevenue)} />
              <Line label="Gasto promocional" value={`−${money(t.promotionExpense)}`} />
              <Line label="Margen neto operativo" value={money(t.netRevenue)} strong />
              <div className="my-2 border-t border-[var(--color-border-light)] dark:border-[#232E46]" />
              <Line label="Pagos a comercios" value={money(t.businessPayouts)} />
              <Line label="Pagos a domiciliarios" value={money(t.driverPayouts)} />
              <Line label="Propinas" value={money(t.tips)} />
              <Line label="Impuestos" value={money(t.tax)} />
              <Line label="Descuentos que puso el comercio" value={money(t.merchantFundedDiscount)} />
              <Line label="Descuentos que puso ZIPP" value={money(t.platformFundedDiscount)} />
            </Card>

            {/* Métodos de pago + efectivo por conciliar */}
            <Card title="Métodos de pago y efectivo" icon={CreditCard}>
              <div className="flex items-center justify-between py-1.5 text-xs">
                <span className="flex items-center gap-1.5 text-[var(--color-text-secondary)] dark:text-[#7C8BA1]">
                  <CreditCard className="w-3.5 h-3.5" /> Pago digital
                </span>
                <span className="tabular font-semibold text-[var(--color-text-main)] dark:text-[#EDF1F5]">
                  {num(t.payDigitalCount)} · {money(t.payDigitalAmount)}
                </span>
              </div>
              <div className="flex items-center justify-between py-1.5 text-xs">
                <span className="flex items-center gap-1.5 text-[var(--color-text-secondary)] dark:text-[#7C8BA1]">
                  <Banknote className="w-3.5 h-3.5" /> Efectivo contra entrega
                </span>
                <span className="tabular font-semibold text-[var(--color-text-main)] dark:text-[#EDF1F5]">
                  {num(t.payCashCount)} · {money(t.payCashAmount)}
                </span>
              </div>
              <div className="my-2 border-t border-[var(--color-border-light)] dark:border-[#232E46]" />
              <p className="text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-muted)] mb-1">
                Conciliaciones de efectivo abiertas hoy
              </p>
              {data!.cashByStatus.length > 0 ? (
                data!.cashByStatus.map((c) => (
                  <Line key={c.status} label={`${CASH_LABEL[c.status] ?? c.status} (${c.count})`} value={money(c.amount)} />
                ))
              ) : (
                <p className="text-xs text-[var(--color-text-muted)] py-1.5">Sin efectivo por conciliar de este día.</p>
              )}
            </Card>

            {/* Altas del día */}
            <Card title="Altas del día" icon={UserPlus}>
              <Line label="Clientes nuevos" value={num(t.newClients)} />
              <Line label="Comercios nuevos" value={num(t.newBusinesses)} />
              <Line label="Domiciliarios nuevos" value={num(t.newDrivers)} />
              {data!.newUsersByRole.filter((r) => r.role !== 'client').map((r) => (
                <Line key={r.role} label={`Usuarios rol "${ROLE_LABEL[r.role] ?? r.role}"`} value={num(r.count)} />
              ))}
            </Card>

            {/* Operación de domiciliarios */}
            <Card title="Operación de domiciliarios" icon={Truck}>
              <Line label="Domiciliarios con entregas" value={num(t.activeDrivers)} strong />
              <Line label="Entregas por domiciliario" value={num(t.deliveriesPerActiveDriver)} />
              <Line label="Tiempo medio de entrega" value={`${num(t.avgDeliveryMinutes)} min`} />
            </Card>
          </div>

          {/* Top comercios */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            <Card title="Top comercios por pedidos" icon={Store}>
              <TopList rows={data!.topBusinessesByOrders} render={(b) => `${num(b.orders)} pedidos`} />
            </Card>
            <Card title="Top comercios por ventas" icon={Store}>
              <TopList rows={data!.topBusinessesByGmv} render={(b) => money(b.gmv)} />
            </Card>
          </div>

          {/* Calidad y soporte */}
          <Card title="Calidad y soporte" icon={MessageSquareWarning}>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <Kpi icon={Star} label="Reseñas del día" value={num(t.reviewsCount)}
                hint={`Comercio ${t.avgBusinessRating || '—'} · Repartidor ${t.avgDriverRating || '—'}`} />
              <Kpi icon={TriangleAlert} label="Reseñas ≤ 2★" value={num(t.lowRatingsCount)} />
              <Kpi icon={MessageSquareWarning} label="PQRS abiertas" value={num(t.pqrsOpened)}
                hint={data!.pqrsByType.map((p) => `${PQRS_LABEL[p.type] ?? p.type}: ${p.count}`).join(' · ')} />
              <Kpi icon={RotateCcw} label="Reembolsos" value={num(t.refundsCount)}
                hint={money(t.refundsAmount)} />
            </div>
          </Card>

          <p className="text-[10px] text-[var(--color-text-muted)] text-right">
            Generado {new Date(data!.generatedAt).toLocaleString('es-CO')}
          </p>
        </>
      )}
    </div>
  );
}

// ── Sub-componentes ────────────────────────────────────────────────

function Kpi({ icon: Icon, label, value, hint }: { icon: LucideIcon; label: string; value: string; hint?: string }) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <Icon className="w-4 h-4 text-[var(--color-primary)]" strokeWidth={1.8} />
        <p className="text-[11px] font-semibold text-[var(--color-text-secondary)] dark:text-[#7C8BA1]">{label}</p>
      </div>
      <p className="kpi-value text-xl">{value}</p>
      {hint ? <p className="text-[10px] text-[var(--color-text-muted)] mt-1 truncate">{hint}</p> : null}
    </div>
  );
}

function TopList({ rows, render }: { rows: TopBusiness[]; render: (b: TopBusiness) => string }) {
  if (rows.length === 0) {
    return <p className="text-xs text-[var(--color-text-muted)] py-1.5">Sin pedidos entregados este día.</p>;
  }
  return (
    <div className="divide-y divide-[var(--color-bg)] dark:divide-[#232E46]">
      {rows.map((b, i) => (
        <div key={b.businessId} className="flex items-center justify-between py-2 text-xs">
          <span className="flex items-center gap-2 truncate max-w-[220px]">
            <span className="w-5 h-5 rounded bg-[var(--color-bg)] dark:bg-[#232E46] text-[var(--color-text-secondary)] font-bold flex items-center justify-center text-[10px]">
              {i + 1}
            </span>
            <span className="font-semibold text-[var(--color-text-main)] dark:text-[#EDF1F5] truncate">{b.name}</span>
          </span>
          <span className="tabular font-bold text-[var(--color-primary)]">{render(b)}</span>
        </div>
      ))}
    </div>
  );
}

function HealthFlags({ flags }: { flags: HealthFlag[] }) {
  if (flags.length === 0) {
    return (
      <div className="flex items-center gap-2 text-[#059669] text-xs font-semibold">
        <CircleCheck className="w-4 h-4" />
        Sin alertas para este día.
        <span className="font-normal text-[var(--color-text-muted)] no-print">
          (o <code>deriveHealthFlags</code> aún no está implementada)
        </span>
      </div>
    );
  }
  const style: Record<HealthFlag['level'], string> = {
    ok: 'text-[#059669]',
    warn: 'text-[var(--color-chart-purple)]',
    critical: 'text-[var(--color-danger)]',
  };
  return (
    <div className="space-y-2">
      {flags.map((f) => (
        <div key={f.code} className={`flex items-center gap-2 text-xs font-semibold ${style[f.level]}`}>
          {f.level === 'ok' ? <CircleCheck className="w-4 h-4 flex-shrink-0" /> : <TriangleAlert className="w-4 h-4 flex-shrink-0" />}
          {f.message}
        </div>
      ))}
    </div>
  );
}

function Comparison({ rows, baselineDate }: { rows: ComparisonRow[]; baselineDate: string }) {
  if (rows.length === 0) {
    return (
      <p className="text-xs text-[var(--color-text-muted)] py-2">
        Pendiente: implementa <code className="text-[var(--color-primary)]">buildComparison()</code> en{' '}
        <code>backend/src/services/dailySummary.service.ts</code> para llenar esta tabla
        (referencia: {baselineDate}).
      </p>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-[var(--color-text-muted)] border-b border-[var(--color-border-light)] dark:border-[#232E46]">
            <th className="pb-2 font-semibold">Métrica</th>
            <th className="pb-2 font-semibold text-right">Hoy</th>
            <th className="pb-2 font-semibold text-right">{baselineDate}</th>
            <th className="pb-2 font-semibold text-right">Δ</th>
            <th className="pb-2 font-semibold text-right">Δ%</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--color-bg)] dark:divide-[#232E46]">
          {rows.map((r) => {
            const improved = r.direction === 'flat'
              ? null
              : (r.direction === 'up') === r.goodWhenUp;
            const color = improved == null ? 'text-[var(--color-text-muted)]' : improved ? 'text-[#059669]' : 'text-[var(--color-danger)]';
            return (
              <tr key={r.metric}>
                <td className="py-2 font-semibold text-[var(--color-text-main)] dark:text-[#EDF1F5]">{r.label}</td>
                <td className="py-2 text-right tabular font-bold text-[var(--color-text-main)] dark:text-white">{num(r.today)}</td>
                <td className="py-2 text-right tabular text-[var(--color-text-secondary)] dark:text-[#7C8BA1]">{num(r.baseline)}</td>
                <td className={`py-2 text-right tabular font-semibold ${color}`}>
                  {r.deltaAbs > 0 ? '+' : ''}{num(r.deltaAbs)}
                </td>
                <td className={`py-2 text-right tabular font-semibold ${color}`}>
                  {r.deltaPct == null ? '—' : `${r.deltaPct > 0 ? '+' : ''}${r.deltaPct}%`}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
