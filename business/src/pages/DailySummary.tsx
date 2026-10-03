import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Printer, RefreshCw } from 'lucide-react';
import api from '../services/api';
import { qk } from '../lib/queryKeys';
import { money } from '../lib/orderFlow';
import { apiMessage } from '../lib/apiError';
import { useAuthStore } from '../stores/authStore';
import SummaryGrid from '../components/SummaryGrid';

/**
 * Cierre del día del comercio. Espejo de "Resumen diario" del admin, pero
 * con la caja del negocio: lo vendido, lo que ZIPP descuenta y lo que se
 * le debe. El dinero viene de `order.finance`, el mismo snapshot que usa
 * Liquidaciones, así que ambos números cuadran.
 */

// Espejo de backend/src/services/businessDailySummary.service.ts
interface DaySnapshot {
  date: string;
  ordersCreated: number;
  ordersDelivered: number;
  ordersCancelled: number;
  sales: number;
  merchantCommission: number;
  merchantFundedDiscount: number;
  businessPayout: number;
  avgTicket: number;
  avgPrepMinutes: number;
  payDigitalCount: number;
  payDigitalAmount: number;
  payCashCount: number;
  payCashAmount: number;
  reviewsCount: number;
  avgRating: number;
  lowRatingsCount: number;
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

interface Summary {
  date: string;
  generatedAt: string;
  today: DaySnapshot;
  baseline: DaySnapshot;
  comparison: ComparisonRow[];
  topProducts: Array<{ productId: string; name: string; quantity: number; sales: number }>;
  cancelReasons: Array<{ reason: string; count: number }>;
  byHour: Array<{ hour: number; orders: number }>;
  ordersInProgressNow: number | null;
}

const MONEY_METRICS = new Set(['sales', 'businessPayout', 'avgTicket']);
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

const CANCEL_LABEL: Record<string, string> = {
  client_changed_mind: 'El cliente cambió de idea',
  client_ordered_by_mistake: 'Pedido por error',
  client_too_slow: 'El cliente se cansó de esperar',
  client_wrong_address: 'Dirección equivocada',
  client_unreachable: 'Cliente no contesta',
  business_out_of_stock: 'Sin existencias',
  business_closed: 'Negocio cerrado',
  business_too_busy: 'Negocio saturado',
  no_driver_available: 'Sin domiciliario',
  driver_incident: 'Incidente del domiciliario',
  payment_failed: 'Pago fallido',
  suspected_fraud: 'Sospecha de fraude',
  other: 'Otro',
};
export default function DailySummary() {
  const businessId = useAuthStore((s) => s.selectedBusiness?._id);
  const [date, setDate] = useState(todayStr());
  const isToday = date === todayStr();

  const query = useQuery({
    queryKey: qk.dailySummary(businessId, date),
    enabled: !!businessId,
    queryFn: async () =>
      (await api.get(`/businesses/${businessId}/daily-summary`, { params: { date } })).data.data as Summary,
  });
  const data = query.data;
  const t = data?.today;

  return (
    <div className="space-y-6">
      <style>{`@media print { aside, header.sticky, .no-print { display: none !important; } @page { size: A4; margin: 12mm; } html, body, #root, main { height: auto !important; overflow: visible !important; background: #fff !important; } }`}</style>

      <div className="page-header">
        <div>
          <h1 className="page-title">Resumen del día</h1>
          <p className="page-subtitle first-letter:uppercase">{longDate(date)}</p>
        </div>
        <div className="flex items-center gap-1 no-print">
          <button onClick={() => setDate((d) => shift(d, -1))} title="Día anterior"
            className="p-1.5 rounded-md text-[var(--color-text-secondary)] hover:text-[var(--color-text-main)] hover:bg-[var(--color-surface-hover)] cursor-pointer">
            <ChevronLeft className="w-4 h-4" />
          </button>
          <input type="date" value={date} max={todayStr()}
            onChange={(e) => e.target.value && setDate(e.target.value)}
            className="h-8 px-2 rounded-md text-xs text-[var(--color-text-main)] bg-[var(--color-surface)] border border-[var(--color-border)] focus:outline-none focus:border-[var(--color-primary)] cursor-pointer" />
          {!isToday && (
            <button onClick={() => setDate((d) => shift(d, 1))} title="Día siguiente"
              className="p-1.5 rounded-md text-[var(--color-text-secondary)] hover:text-[var(--color-text-main)] hover:bg-[var(--color-surface-hover)] cursor-pointer">
              <ChevronRight className="w-4 h-4" />
            </button>
          )}
          <button onClick={() => query.refetch()} title="Actualizar"
            className="p-1.5 rounded-md text-[var(--color-text-secondary)] hover:text-[var(--color-text-main)] hover:bg-[var(--color-surface-hover)] cursor-pointer">
            <RefreshCw className={`w-4 h-4 ${query.isFetching ? 'animate-spin' : ''}`} />
          </button>
          <button onClick={() => window.print()}
            className="ml-2 flex items-center gap-1.5 h-8 px-3 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-hover)] text-xs font-medium text-[var(--color-text-main)] cursor-pointer">
            <Printer className="w-3.5 h-3.5 text-[var(--color-text-secondary)]" /> Imprimir
          </button>
        </div>
      </div>

      {!t ? (
        <p className="py-20 text-center text-xs font-semibold text-[var(--color-text-secondary)]">
          {query.isError ? apiMessage(query.error, 'No se pudo cargar el resumen de este día.') : 'Reconstruyendo el día…'}
        </p>
      ) : (
        <>
          <SummaryGrid
            items={[
              { label: 'Pedidos recibidos', value: num(t.ordersCreated),
                hint: isToday && data!.ordersInProgressNow != null ? `${num(data!.ordersInProgressNow)} abiertos ahora` : '' },
              { label: 'Entregados', value: num(t.ordersDelivered), hint: `Ticket prom. ${money(t.avgTicket)}` },
              { label: 'Cancelados', value: num(t.ordersCancelled),
                hint: `${t.ordersCreated > 0 ? Math.round((t.ordersCancelled / t.ordersCreated) * 100) : 0}% de los recibidos` },
              { label: 'Neto para tu negocio', value: money(t.businessPayout), hint: `Ventas ${money(t.sales)}` },
            ]}
          />

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 lg:gap-0 lg:divide-x divide-[var(--color-border)] lg:[&>*]:px-6 lg:[&>*:first-child]:pl-0 lg:[&>*:last-child]:pr-0">
            <div className="space-y-6 min-w-0">
              <Section title="Hoy vs. semana pasada">
                <Comparison rows={data!.comparison} baselineDate={data!.baseline.date} isToday={isToday} />
              </Section>
              <Section title="Dinero del día">
                <Line label="Ventas de producto (entregado)" value={money(t.sales)} strong />
                <Line label="Comisión ZIPP" value={`−${money(t.merchantCommission)}`} />
                <Line label="Descuentos que pusiste tú" value={`−${money(t.merchantFundedDiscount)}`} />
                <div className="my-1 border-t border-[var(--color-border)]" />
                <Line label="Neto a liquidar" value={money(t.businessPayout)} strong />
              </Section>
            </div>

            <div className="space-y-6 min-w-0">
              <Section title="Cómo pagaron">
                <Line label="Pago digital" value={`${num(t.payDigitalCount)} · ${money(t.payDigitalAmount)}`} />
                <Line label="Efectivo contra entrega" value={`${num(t.payCashCount)} · ${money(t.payCashAmount)}`} />
                <p className="pt-1 text-[10px] text-[var(--color-text-secondary)]">
                  Montos cobrados al cliente, incluido domicilio.
                </p>
              </Section>
              <Section title="Operación y calidad">
                <Line label="Preparación promedio" value={t.avgPrepMinutes ? `${num(t.avgPrepMinutes)} min` : '—'} />
                <Line label="Reseñas del día" value={num(t.reviewsCount)} />
                <Line label="Calificación promedio" value={t.avgRating ? `${t.avgRating} ★` : '—'} />
                <Line label="Reseñas de 2★ o menos" value={num(t.lowRatingsCount)} />
                {data!.cancelReasons.length > 0 && (
                  <>
                    <div className="my-1 border-t border-[var(--color-border)]" />
                    {data!.cancelReasons.map((c) => (
                      <Line key={c.reason} label={`Cancelado: ${CANCEL_LABEL[c.reason] ?? c.reason}`} value={num(c.count)} />
                    ))}
                  </>
                )}
              </Section>
            </div>

            <div className="space-y-6 min-w-0">
              <Section title="Lo más vendido">
                {data!.topProducts.length === 0 ? (
                  <Empty>Sin pedidos entregados este día.</Empty>
                ) : (
                  <ol className="divide-y divide-[var(--color-border)]">
                    {data!.topProducts.slice(0, 5).map((p, i) => (
                      <li key={p.productId} className="flex items-center justify-between gap-3 py-1 text-xs">
                        <span className="flex items-center gap-3 min-w-0">
                          <span className="w-4 text-[var(--color-text-secondary)] tabular">{i + 1}</span>
                          <span className="text-[var(--color-text-main)] truncate">{p.name}</span>
                        </span>
                        <span className="tabular shrink-0 text-[var(--color-text-main)]">
                          {num(p.quantity)} u · {money(p.sales)}
                        </span>
                      </li>
                    ))}
                  </ol>
                )}
              </Section>
              <Section title="Pedidos por hora">
                <ByHour rows={data!.byHour} />
              </Section>
            </div>
          </div>

          <p className="text-[10px] text-right text-[var(--color-text-secondary)]">
            Generado {new Date(data!.generatedAt).toLocaleString('es-CO')}
          </p>
        </>
      )}
    </div>
  );

}

function Comparison({ rows, baselineDate, isToday }: { rows: ComparisonRow[]; baselineDate: string; isToday: boolean }) {
  const fmt = (metric: string, v: number) => (MONEY_METRICS.has(metric) ? money(v) : num(v));
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-[var(--color-text-secondary)] border-b border-[var(--color-border)]">
            <th className="pb-1.5 font-semibold">Métrica</th>
            <th className="pb-1.5 font-semibold text-right">{isToday ? 'Hoy' : 'Este día'}</th>
            <th className="pb-1.5 font-semibold text-right">{baselineDate.slice(5)}</th>
            <th className="pb-1.5 font-semibold text-right">Δ%</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--color-border)]">
          {rows.map((r) => {
            const improved = r.direction === 'flat' ? null : (r.direction === 'up') === r.goodWhenUp;
            const color = improved == null ? 'text-[var(--color-text-main)]' : improved ? 'text-[#059669]' : 'text-[var(--color-danger)]';
            return (
              <tr key={r.metric}>
                <td className="py-1 pr-2 text-[var(--color-text-main)]">{r.label}</td>
                <td className="py-1 text-right tabular font-medium text-[var(--color-text-main)]">{fmt(r.metric, r.today)}</td>
                <td className="py-1 text-right tabular text-[var(--color-text-secondary)]">{fmt(r.metric, r.baseline)}</td>
                <td className={`py-1 text-right tabular ${color}`}>
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

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="col-title">{title}</h2>
      {children}
    </section>
  );
}

function Line({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between py-1 text-xs">
      <span className="text-[var(--color-text-main)]">{label}</span>
      <span className={`tabular ${strong ? 'font-semibold' : ''} text-[var(--color-text-main)]`}>{value}</span>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="py-1.5 text-xs text-[var(--color-text-secondary)]">{children}</p>;
}

/** Barras verticales de 00 a 23 h, fijas en altura para no empujar el scroll. Sin librería de gráficos. */
function ByHour({ rows }: { rows: Array<{ hour: number; orders: number }> }) {
  if (rows.length === 0) return <Empty>Sin pedidos este día.</Empty>;
  const byHour = new Map(rows.map((r) => [r.hour, r.orders]));
  const max = Math.max(...rows.map((r) => r.orders));
  return (
    <div>
      <div className="flex items-end gap-[2px] h-24">
        {Array.from({ length: 24 }, (_, h) => {
          const n = byHour.get(h) ?? 0;
          return (
            <span key={h} title={`${String(h).padStart(2, '0')}:00 · ${n} pedidos`}
              className={`flex-1 ${n ? 'bg-[var(--color-primary)]' : 'bg-[var(--color-border)]'}`}
              style={{ height: n ? `${Math.max((n / max) * 100, 4)}%` : '1px' }} />
          );
        })}
      </div>
      <div className="mt-1 flex justify-between text-[10px] tabular text-[var(--color-text-secondary)]">
        <span>00</span><span>06</span><span>12</span><span>18</span><span>23</span>
      </div>
    </div>
  );
}
