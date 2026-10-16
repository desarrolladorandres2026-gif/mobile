import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import api from '../services/api';
import { qk } from '../lib/queryKeys';
import { money } from '../lib/orderFlow';
import { apiMessage } from '../lib/apiError';
import { useAuthStore } from '../stores/authStore';
import { useFlowProfile } from '../hooks/useFlowProfile';
import SummaryGrid from '../components/SummaryGrid';

/**
 * Cómo le va al negocio en un periodo: ventas, horas pico, qué se vende,
 * quién compra y qué tan bien se atiende.
 *
 * Las cifras salen de una agregación del servidor sobre el rango pedido (ver
 * `businessAnalytics.service.ts`), no de los últimos pedidos que cupieron en
 * una página. Las ventas son productos entregados: sin domicilio, propina ni
 * pedidos cancelados. Sin librería de gráficos, como el resumen del día.
 */

interface Analytics {
  range: { from: string; to: string; days: number };
  totals: {
    orders: number;
    delivered: number;
    cancelled: number;
    revenue: number;
    averageTicket: number;
    cancellationRate: number;
  };
  previous: { orders: number; revenue: number };
  byDay: Array<{ date: string; orders: number; revenue: number }>;
  byHour: Array<{ hour: number; orders: number }>;
  topProducts: Array<{ productId: string; name: string; quantity: number; sales: number }>;
  avgPrepMinutes: number | null;
  customers: { total: number; new: number; returning: number };
  lostByBusiness: { orders: number; rate: number };
}

const PERIODS = [
  { days: 7, label: '7 días' },
  { days: 30, label: '30 días' },
  { days: 90, label: '90 días' },
] as const;

const num = (value: number) => (value ?? 0).toLocaleString('es-CO');

const shortDate = (iso: string) =>
  new Date(`${iso}T12:00:00`).toLocaleDateString('es-CO', { day: 'numeric', month: 'short' });

/** «+12 % frente a los 30 días anteriores», o por qué no hay comparación. */
function versus(current: number, previous: number, days: number): string {
  if (previous <= 0) return `Sin ventas en los ${days} días anteriores`;
  const change = Math.round(((current - previous) / previous) * 100);
  const sign = change > 0 ? '+' : change < 0 ? '−' : '';
  return `${sign}${Math.abs(change)} % frente a los ${days} días anteriores`;
}

export default function Analytics() {
  const businessId = useAuthStore((s) => s.selectedBusiness?._id);
  const profile = useFlowProfile();
  const [days, setDays] = useState<number>(30);

  const query = useQuery({
    queryKey: qk.analytics(businessId, days),
    enabled: !!businessId,
    queryFn: async () =>
      (await api.get(`/businesses/${businessId}/analytics`, { params: { days } })).data.data as Analytics,
  });
  const data = query.data;
  const prepLabel = profile === 'picking' ? 'Tiempo de alistamiento' : 'Tiempo de preparación';

  return (
    <div className="space-y-6">
      <div className="page-header">
        <div>
          <h1 className="page-title">Analítica</h1>
          <p className="page-subtitle">
            Ventas de producto entregado, sin domicilio ni propina. Las horas son las de Colombia.
          </p>
        </div>
        <div role="radiogroup" aria-label="Periodo" className="flex items-center gap-1">
          {PERIODS.map((period) => {
            const selected = days === period.days;
            return (
              <button
                key={period.days}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => setDays(period.days)}
                className={`h-8 cursor-pointer rounded-md px-3 text-xs ${
                  selected
                    ? 'font-semibold text-[var(--color-primary)] underline underline-offset-4'
                    : 'font-medium text-[var(--color-text-main)] hover:bg-[var(--color-surface-hover)]'
                }`}
              >
                {period.label}
              </button>
            );
          })}
        </div>
      </div>

      {query.isError ? (
        <div role="alert" className="flex items-start gap-2 border-l-2 border-[var(--color-danger)] py-0.5 pl-3">
          <p className="text-xs font-semibold text-[var(--color-danger)]">
            {apiMessage(query.error, 'No pudimos cargar la analítica.')}
          </p>
          <button
            type="button"
            onClick={() => void query.refetch()}
            className="ml-2 inline-flex cursor-pointer items-center gap-1 text-xs font-bold text-[var(--color-danger)] underline"
          >
            <RefreshCw className="h-3 w-3" /> Reintentar
          </button>
        </div>
      ) : null}

      {!data ? (
        query.isError ? null : (
          <p className="py-20 text-center text-xs font-semibold text-[var(--color-text-secondary)]">
            Calculando el periodo…
          </p>
        )
      ) : data.totals.orders === 0 ? (
        <p className="py-20 text-center text-xs font-semibold text-[var(--color-text-secondary)]">
          Todavía no hay pedidos en estos {days} días.
        </p>
      ) : (
        <>
          <SummaryGrid
            items={[
              {
                label: 'Ventas de producto',
                value: money(data.totals.revenue),
                hint: versus(data.totals.revenue, data.previous.revenue, days),
                strong: true,
              },
              {
                label: 'Pedidos',
                value: num(data.totals.orders),
                hint: `${num(data.totals.delivered)} entregados`,
              },
              { label: 'Ticket promedio', value: money(data.totals.averageTicket) },
              {
                label: 'Cancelados',
                value: num(data.totals.cancelled),
                hint: `${data.totals.cancellationRate} % de los pedidos`,
              },
            ]}
          />

          <div className="grid grid-cols-1 gap-8 lg:grid-cols-2 lg:gap-0 lg:divide-x divide-[var(--color-border)] lg:[&>*]:px-6 lg:[&>*:first-child]:pl-0 lg:[&>*:last-child]:pr-0">
            <Section title="Ventas por día">
              <ByDay rows={data.byDay} />
            </Section>
            <Section title="Horas pico">
              <ByHour rows={data.byHour} />
            </Section>
          </div>

          <div className="grid grid-cols-1 gap-8 lg:grid-cols-3 lg:gap-0 lg:divide-x divide-[var(--color-border)] lg:[&>*]:px-6 lg:[&>*:first-child]:pl-0 lg:[&>*:last-child]:pr-0">
            <Section title="Lo más vendido">
              {data.topProducts.length === 0 ? (
                <Empty>Sin ventas entregadas en el periodo.</Empty>
              ) : (
                <ol className="space-y-1">
                  {data.topProducts.map((product, index) => (
                    <li key={product.productId} className="flex items-baseline gap-2 py-1 text-xs">
                      <span className="w-4 tabular text-[var(--color-text-secondary)]">{index + 1}</span>
                      <span className="min-w-0 flex-1 truncate text-[var(--color-text-main)]">{product.name}</span>
                      <span className="tabular text-[var(--color-text-secondary)]">{num(product.quantity)} uds</span>
                      <span className="w-24 text-right tabular font-semibold text-[var(--color-text-main)]">
                        {money(product.sales)}
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </Section>

            <Section title="Clientes">
              {data.customers.total === 0 ? (
                <Empty>Sin clientes con pedidos entregados.</Empty>
              ) : (
                <>
                  <Line label="Compraron en el periodo" value={num(data.customers.total)} strong />
                  <Line label="Nuevos" value={num(data.customers.new)} />
                  <Line label="Ya habían comprado antes" value={num(data.customers.returning)} />
                  <p className="pt-2 text-[11px] text-[var(--color-text-secondary)]">
                    {Math.round((data.customers.returning / data.customers.total) * 100)} % repite. Es la cifra que
                    más pesa en el negocio de barrio.
                  </p>
                </>
              )}
            </Section>

            <Section title="Cómo atiendes">
              <Line
                label={prepLabel}
                value={data.avgPrepMinutes === null ? 'Sin datos' : `${num(data.avgPrepMinutes)} min`}
                strong
              />
              <Line label="Pedidos que no atendiste" value={num(data.lostByBusiness.orders)} />
              <Line label="De todos los pedidos" value={`${data.lostByBusiness.rate} %`} />
              <p className="pt-2 text-[11px] text-[var(--color-text-secondary)]">
                Cuenta los que rechazaste y los que dejaste vencer sin aceptar. El cliente ya había pagado o
                esperado.
              </p>
            </Section>
          </div>
        </>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="min-w-0 space-y-2">
      <h2 className="text-sm font-semibold text-[var(--color-text-main)]">{title}</h2>
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

function Empty({ children }: { children: ReactNode }) {
  return <p className="py-1.5 text-xs text-[var(--color-text-secondary)]">{children}</p>;
}

/** Una barra por día del periodo, con la fecha del primero y del último. */
function ByDay({ rows }: { rows: Analytics['byDay'] }) {
  if (rows.length === 0) return <Empty>Sin ventas entregadas en el periodo.</Empty>;
  const max = Math.max(...rows.map((row) => row.revenue), 1);
  return (
    <div>
      <div className="flex h-28 items-end gap-[2px]">
        {rows.map((row) => (
          <span
            key={row.date}
            title={`${shortDate(row.date)} · ${money(row.revenue)} · ${num(row.orders)} pedidos`}
            className={`flex-1 ${row.revenue ? 'bg-[var(--color-text-main)]' : 'bg-[var(--color-border)]'}`}
            style={{ height: row.revenue ? `${Math.max((row.revenue / max) * 100, 4)}%` : '1px' }}
          />
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[10px] tabular text-[var(--color-text-secondary)]">
        <span>{shortDate(rows[0].date)}</span>
        <span>Mejor día: {money(max)}</span>
        <span>{shortDate(rows[rows.length - 1].date)}</span>
      </div>
    </div>
  );
}

/** Barras de 00 a 23 h, fijas en altura. */
function ByHour({ rows }: { rows: Analytics['byHour'] }) {
  if (rows.length === 0) return <Empty>Sin pedidos entregados en el periodo.</Empty>;
  const byHour = new Map(rows.map((row) => [row.hour, row.orders]));
  const max = Math.max(...rows.map((row) => row.orders));
  return (
    <div>
      <div className="flex h-28 items-end gap-[2px]">
        {Array.from({ length: 24 }, (_, hour) => {
          const n = byHour.get(hour) ?? 0;
          return (
            <span
              key={hour}
              title={`${String(hour).padStart(2, '0')}:00 · ${n} pedidos`}
              className={`flex-1 ${n ? 'bg-[var(--color-text-main)]' : 'bg-[var(--color-border)]'}`}
              style={{ height: n ? `${Math.max((n / max) * 100, 4)}%` : '1px' }}
            />
          );
        })}
      </div>
      <div className="mt-1 flex justify-between text-[10px] tabular text-[var(--color-text-secondary)]">
        <span>00</span>
        <span>06</span>
        <span>12</span>
        <span>18</span>
        <span>23</span>
      </div>
    </div>
  );
}
