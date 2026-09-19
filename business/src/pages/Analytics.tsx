import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { AlertCircle, TrendingUp, TrendingDown, Clock, ShoppingBag, XCircle } from 'lucide-react';
import api from '../services/api';
import { qk } from '../lib/queryKeys';
import { useAuthStore } from '../stores/authStore';
import { apiMessage } from '../lib/apiError';

/**
 * Analíticas del comercio.
 *
 * El panel calculaba estos números en el navegador sobre los últimos cien
 * pedidos. Ese número no es una muestra: es "lo que cupo en la primera
 * página", así que un negocio con tráfico veía como "ventas del mes" las de
 * sus últimos dos días. Aquí todo viene agregado del servidor sobre un
 * rango explícito.
 *
 * El Dashboard sigue siendo el hoy —qué hay en la cocina ahora mismo—; esta
 * pantalla es la tendencia.
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
}

const money = (value: number) => `$${(value ?? 0).toLocaleString('es-CO')}`;

const RANGES = [
  { days: 7, label: '7 días' },
  { days: 30, label: '30 días' },
  { days: 90, label: '90 días' },
];

/** Variación porcentual, o null si no había con qué comparar. */
function delta(current: number, previous: number): number | null {
  if (!previous) return null;
  return Math.round(((current - previous) / previous) * 100);
}

export default function Analytics() {
  const selectedBusiness = useAuthStore((s) => s.selectedBusiness);
  const businessId = selectedBusiness?._id;

  const [days, setDays] = useState(30);

  // Cada rango es su propia entrada: volver a 30 días tras mirar 7 no
  // vuelve a pedir nada, y mientras llega un rango nuevo se sigue viendo
  // el anterior en vez de un hueco.
  const analyticsQuery = useQuery({
    queryKey: qk.analytics(businessId, days),
    enabled: !!businessId,
    placeholderData: keepPreviousData,
    queryFn: async () =>
      (await api.get(`/businesses/${businessId}/analytics`, { params: { days } })).data.data as Analytics,
  });
  const data = analyticsQuery.data ?? null;
  const loading = !!businessId && analyticsQuery.isPending;
  const loadError = analyticsQuery.isError ? apiMessage(analyticsQuery.error, 'No se pudieron cargar las analíticas.') : '';

  const revenueDelta = data ? delta(data.totals.revenue, data.previous.revenue) : null;
  const ordersDelta = data ? delta(data.totals.orders, data.previous.orders) : null;

  const maxDayRevenue = Math.max(1, ...(data?.byDay.map((d) => d.revenue) ?? [1]));
  const maxHourOrders = Math.max(1, ...(data?.byHour.map((h) => h.orders) ?? [1]));

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="page-title">Analíticas</h1>
          <p className="page-subtitle">
            Cómo va tu negocio comparado con el periodo anterior del mismo tamaño
          </p>
        </div>

        <div className="flex items-center gap-1 p-1 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)]">
          {RANGES.map((range) => (
            <button
              key={range.days}
              onClick={() => setDays(range.days)}
              className={`px-3 py-1.5 rounded-md text-xs font-bold transition-all cursor-pointer ${
                days === range.days
                  ? 'bg-[var(--color-primary)] text-white'
                  : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-alt)]'
              }`}
            >
              {range.label}
            </button>
          ))}
        </div>
      </div>

      {loadError && (
        <div className="bg-[var(--color-danger-bg)] border border-[var(--color-danger-bg)] text-[var(--color-danger)] text-xs p-4 rounded-xl flex items-start gap-3">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <p className="flex-1 font-semibold">{loadError}</p>
        </div>
      )}

      {loading || !data ? (
        <div className="table-container p-16 text-center text-[var(--color-text-secondary)] text-xs font-semibold">
          Cargando analíticas...
        </div>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Metric
              label="Ventas"
              value={money(data.totals.revenue)}
              delta={revenueDelta}
              hint="Solo pedidos entregados"
            />
            <Metric
              label="Pedidos"
              value={String(data.totals.orders)}
              delta={ordersDelta}
              hint={`${data.totals.delivered} entregados`}
            />
            <Metric
              label="Ticket promedio"
              value={money(data.totals.averageTicket)}
              hint="Por pedido entregado"
              icon={<ShoppingBag className="w-4 h-4 text-[var(--color-primary)]" />}
            />
            <Metric
              label="Cancelaciones"
              value={`${data.totals.cancellationRate}%`}
              hint={`${data.totals.cancelled} de ${data.totals.orders}`}
              icon={<XCircle className="w-4 h-4 text-[var(--color-danger)]" />}
              alarming={data.totals.cancellationRate > 10}
            />
          </div>

          {/* ── Ventas por día ── */}
          <div className="zipp-card p-5 space-y-4">
            <h2 className="text-sm font-bold text-[var(--color-text-main)]">Ventas por día</h2>

            {data.byDay.length === 0 ? (
              <p className="text-xs text-[var(--color-text-muted)] py-8 text-center">
                Sin ventas entregadas en este periodo.
              </p>
            ) : (
              <div className="flex items-end gap-1 h-40 overflow-x-auto">
                {data.byDay.map((day) => (
                  <div
                    key={day.date}
                    className="flex-1 min-w-[10px] flex flex-col items-center gap-1 group"
                    title={`${day.date}: ${money(day.revenue)} en ${day.orders} pedidos`}
                  >
                    <div
                      className="w-full rounded-t bg-[var(--color-primary)] transition-all group-hover:opacity-80"
                      style={{ height: `${(day.revenue / maxDayRevenue) * 100}%` }}
                    />
                  </div>
                ))}
              </div>
            )}

            <p className="text-xs text-[var(--color-text-muted)]">
              Pasa el cursor sobre una barra para ver el día y su venta.
            </p>
          </div>

          {/* ── Horas pico ── */}
          <div className="zipp-card p-5 space-y-4">
            <div className="flex items-center gap-2">
              <Clock className="w-4 h-4 text-[var(--color-primary)]" />
              <h2 className="text-sm font-bold text-[var(--color-text-main)]">Horas con más pedidos</h2>
            </div>

            {data.byHour.length === 0 ? (
              <p className="text-xs text-[var(--color-text-muted)] py-8 text-center">
                Todavía no hay suficientes pedidos para ver un patrón.
              </p>
            ) : (
              <div className="space-y-1.5">
                {[...data.byHour]
                  .sort((a, b) => b.orders - a.orders)
                  .slice(0, 6)
                  .map((slot) => (
                    <div key={slot.hour} className="flex items-center gap-3">
                      <span className="text-xs font-mono font-bold text-[var(--color-text-main)] w-12">
                        {String(slot.hour).padStart(2, '0')}:00
                      </span>
                      <div className="flex-1 h-5 rounded bg-[var(--color-bg)] overflow-hidden">
                        <div
                          className="h-full bg-[var(--color-primary)] rounded"
                          style={{ width: `${(slot.orders / maxHourOrders) * 100}%` }}
                        />
                      </div>
                      <span className="text-xs font-semibold text-[var(--color-text-secondary)] w-16 text-right">
                        {slot.orders} {slot.orders === 1 ? 'pedido' : 'pedidos'}
                      </span>
                    </div>
                  ))}
              </div>
            )}

            <p className="text-xs text-[var(--color-text-muted)]">
              Útil para decidir a qué hora poner una promoción, o cuándo necesitas más manos.
            </p>
          </div>
        </>
      )}
    </div>
  );
}

function Metric({
  label,
  value,
  delta: deltaValue,
  hint,
  icon,
  alarming,
}: {
  label: string;
  value: string;
  delta?: number | null;
  hint?: string;
  icon?: React.ReactNode;
  alarming?: boolean;
}) {
  return (
    <div className="zipp-card p-4 space-y-1.5">
      <div className="flex items-center justify-between">
        <p className="text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">
          {label}
        </p>
        {icon}
      </div>

      <p
        className={`text-xl font-bold ${
          alarming ? 'text-[var(--color-danger)]' : 'text-[var(--color-text-main)]'
        }`}
      >
        {value}
      </p>

      <div className="flex items-center gap-2">
        {/* Sin periodo anterior no se inventa un porcentaje: un negocio
            nuevo vería "+100%" en su primera semana y no significaría nada. */}
        {deltaValue != null && (
          <span
            className={`inline-flex items-center gap-1 text-xs font-bold ${
              deltaValue >= 0 ? 'text-[#047857]' : 'text-[var(--color-danger)]'
            }`}
          >
            {deltaValue >= 0 ? (
              <TrendingUp className="w-3 h-3" />
            ) : (
              <TrendingDown className="w-3 h-3" />
            )}
            {Math.abs(deltaValue)}%
          </span>
        )}
        {hint && <span className="text-xs text-[var(--color-text-muted)]">{hint}</span>}
      </div>
    </div>
  );
}
