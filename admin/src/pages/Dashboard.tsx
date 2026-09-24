import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  RefreshCw, ArrowUpRight,
  CheckCircle2, CreditCard, Banknote, AlertCircle
} from 'lucide-react';
import api from '../services/api';
import { apiMessage } from '../lib/apiError';
import { useAdminSocketEvents, useTrailingCallback } from '../hooks/useAdminSocket';
import {
  PackageLogo, CashLogo, StoreLogo, DeliveryLogo,
} from '../components/logos';
import type { DashboardFinancials, DashboardStats, RecentOrder, RevenuePoint } from '../lib/apiTypes';

export default function Dashboard() {
  const queryClient = useQueryClient();
  const [period, setPeriod] = useState<'7D' | '14D' | '30D' | '90D'>('14D');
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const days = { '7D': 7, '14D': 14, '30D': 30, '90D': 90 }[period] || 14;

  // Cada bloque es su propia consulta cacheada: volver al Dashboard desde
  // otra página lo pinta al instante con lo último que se vio y lo refresca
  // por detrás, en vez de un spinner de página completa esperando a la
  // más lenta de cuatro peticiones. Cambiar el rango del gráfico solo
  // vuelve a pedir el gráfico.
  const statsQuery = useQuery({
    queryKey: ['admin', 'dashboard', 'stats'],
    queryFn: async () => (await api.get('/admin/dashboard')).data.data as DashboardStats,
  });
  const financialsQuery = useQuery({
    queryKey: ['admin', 'dashboard', 'financials'],
    queryFn: async () => (await api.get('/admin/financials?period=today')).data.data as DashboardFinancials,
  });
  const recentQuery = useQuery({
    queryKey: ['admin', 'dashboard', 'recent'],
    queryFn: async () => ((await api.get('/admin/orders?limit=6')).data.data || []) as RecentOrder[],
  });
  const chartQuery = useQuery({
    queryKey: ['admin', 'dashboard', 'chart', days],
    queryFn: async () =>
      ((await api.get(`/admin/revenue-chart?days=${days}`)).data.data || []) as RevenuePoint[],
    placeholderData: (previous) => previous,
  });

  const stats = statsQuery.data ?? null;
  const financials = financialsQuery.data ?? null;
  const recentOrders = recentQuery.data ?? [];
  const revenueChartData = chartQuery.data ?? [];
  const loading = statsQuery.isPending;
  const refreshing = statsQuery.isFetching || financialsQuery.isFetching || recentQuery.isFetching;
  const failedQuery = [statsQuery, financialsQuery, recentQuery, chartQuery].find((q) => q.isError);
  const loadError = failedQuery ? apiMessage(failedQuery.error, 'No se pudieron cargar todas las métricas.') : '';

  const fetchDashboardData = () => {
    void queryClient.invalidateQueries({ queryKey: ['admin', 'dashboard'] });
  };

  // En hora pico llegan varios cambios de estado por segundo: se agrupan
  // y el Dashboard se refresca una vez cuando se calman (1,5 s).
  const refreshSoon = useTrailingCallback(fetchDashboardData, 1500);
  useAdminSocketEvents({
    'order:new': refreshSoon,
    'order:status:changed': refreshSoon,
  });

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center h-96 text-[var(--color-text-secondary)] animate-fade-in space-y-3">
        <RefreshCw className="w-8 h-8 text-[var(--color-primary)] animate-spin" />
        <p className="text-xs font-semibold text-[var(--color-text-secondary)]">Cargando métricas y analítica en tiempo real...</p>
      </div>
    );
  }

  // 1. Top 4 Real KPI Cards
  const kpiCards = [
    {
      title: 'Pedidos Totales',
      value: (stats?.totalOrders ?? 0).toLocaleString(),
      sub: `${stats?.todayOrders ?? 0} pedidos hoy`,
      change: `${stats?.activeOrders ?? 0} activos`,
      isPositive: true,
      Illustration: PackageLogo,
    },
    {
      title: 'Ventas de Hoy (GMV)',
      value: `$${(financials?.totalRevenue || stats?.todayRevenue || 0).toLocaleString('es-CO')}`,
      sub: `Ingreso ZIPP: $${(financials?.platformResult?.grossRevenue ?? stats?.platformResult?.grossRevenue ?? 0).toLocaleString('es-CO')}`,
      change: financials?.platformResult?.incomplete ? 'Sin costos de pasarela' : `COP`,
      isPositive: true,
      Illustration: CashLogo,
    },
    {
      title: 'Comercios Aliados',
      value: (stats?.activeBusinesses ?? 0).toLocaleString(),
      sub: `de ${stats?.totalBusinesses ?? 0} registrados`,
      change: `${stats?.activeBusinesses ?? 0} abiertos`,
      isPositive: true,
      Illustration: StoreLogo,
    },
    {
      title: 'Domiciliarios',
      value: (stats?.approvedDrivers ?? 0).toLocaleString(),
      sub: `de ${stats?.totalDrivers ?? 0} en plataforma`,
      change: `Aprobados`,
      isPositive: true,
      Illustration: DeliveryLogo,
    },
  ];

  // 2. Real Payment Methods & Delivery stats
  // Los agregados del día salen del servidor, sobre todos los pedidos del
  // periodo. Antes se calculaban aquí sobre los 6 más recientes, y un "% de
  // efectivo" de seis filas no decía nada del día.
  const onlineCount = financials?.paymentBreakdown?.online.count ?? 0;
  const cashCount = financials?.paymentBreakdown?.cash.count ?? 0;
  const paidTotal = onlineCount + cashCount;
  const deliveredCount = financials?.deliveredCount ?? 0;
  const byStatus = financials?.ordersByStatus ?? {};
  const activeCount = ['pending', 'accepted', 'preparing', 'ready', 'picked_up', 'on_way'].reduce(
    (sum, status) => sum + (byStatus[status] ?? 0),
    0
  );
  const activeTotal = activeCount + deliveredCount + (financials?.cancelledCount ?? 0);
  const pct = (part: number, whole: number) => (whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : '0%');
  const deliveryRate = (financials?.deliveryRate ?? 0).toFixed(1);

  const paymentBreakdown = [
    {
      name: 'Pago Digital / En Línea',
      percent: pct(onlineCount, paidTotal),
      count: `${onlineCount} pedidos hoy`,
      icon: CreditCard,
    },
    {
      name: 'Efectivo contra Entrega',
      percent: pct(cashCount, paidTotal),
      count: `${cashCount} pedidos hoy`,
      icon: Banknote,
    },
    {
      name: 'Pedidos en Curso',
      percent: pct(activeCount, activeTotal),
      count: `${activeCount} activos`,
      icon: CheckCircle2,
    },
    {
      name: 'Entregados con Éxito',
      percent: `${deliveryRate}%`,
      count: `${deliveredCount} entregas`,
      icon: CheckCircle2,
    },
  ];

  // 3. Real Performance Chart builder — only actual backend data, no fabricated series
  const chartData = revenueChartData.map((d: RevenuePoint) => ({
    date: d._id ? d._id.slice(5) : 'Día',
    orders: d.orders || 0,
    // El gráfico muestra el ingreso de ZIPP (libro mayor), no el GMV.
    revenue: d.platformRevenue ?? 0,
  }));
  const hasChartData = chartData.length > 0;

  const maxOrders = Math.max(...chartData.map((d) => d.orders), 5);
  const maxRevenue = Math.max(...chartData.map((d) => d.revenue), 50000);

  const chartW = 560;
  const chartH = 170;
  const stepX = chartW / chartData.length;

  const linePoints = chartData.map((d, i) => {
    const x = stepX * i + stepX / 2;
    const y = chartH - (d.revenue / maxRevenue) * chartH;
    return { x, y };
  });

  let splinePath = linePoints.length > 0 ? `M ${linePoints[0].x} ${linePoints[0].y}` : '';
  for (let i = 0; i < linePoints.length - 1; i++) {
    const p0 = linePoints[i];
    const p1 = linePoints[i + 1];
    const mx = (p0.x + p1.x) / 2;
    splinePath += ` C ${mx} ${p0.y}, ${mx} ${p1.y}, ${p1.x} ${p1.y}`;
  }

  const getStatusBadge = (status: string) => {
    // Espejo del esquema `orderStatus` de mobile/theme/tokens.ts.
    const map: Record<string, { label: string; text: string }> = {
      pending: { label: 'Por Aceptar', text: 'text-[#B45309]' },
      accepted: { label: 'Aceptado', text: 'text-[var(--color-chart-purple)]' },
      preparing: { label: 'En Cocina', text: 'text-[#B45309]' },
      ready: { label: 'Listo', text: 'text-[var(--color-chart-purple)]' },
      picked_up: { label: 'En Camino', text: 'text-[#8A5D08]' },
      on_way: { label: 'En Camino', text: 'text-[#8A5D08]' },
      delivered: { label: 'Entregado', text: 'text-[#047857]' },
      cancelled: { label: 'Cancelado', text: 'text-[var(--color-danger)]' },
    };
    return map[status] || { label: status, text: 'text-gray-900' };
  };

  return (
    <div className="animate-fade-in">
      {loadError && (
        <p className="mb-3 flex items-center gap-2 text-xs font-semibold text-[var(--color-danger)]">
          <AlertCircle className="h-4 w-4 shrink-0" /> {loadError}
          <button onClick={fetchDashboardData} className="cursor-pointer underline">Reintentar</button>
        </p>
      )}
      {/* ── ROW 1: 4 Top Real KPIs ── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-0 pb-3 border-b border-[var(--color-border)] sm:divide-x divide-[var(--color-border)]">
        {kpiCards.map((kpi, idx) => (
          <div key={idx} className="flex items-start gap-2.5 px-4 first:pl-0 py-1">
            <kpi.Illustration size={28} />
            <div>
              <p className="text-xs font-semibold text-[var(--color-text-secondary)]">{kpi.title}</p>
              <p className="kpi-value text-xl font-bold text-[var(--color-text-main)]">{kpi.value}</p>
              <div className="flex items-center gap-1.5 text-[11px]">
                <span className="font-bold text-[var(--color-primary)]">{kpi.change}</span>
                <span className="text-[var(--color-text-muted)] font-medium">· {kpi.sub}</span>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* ── ROW 2: 3 Analytics & Performance Cards ── */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-0 py-3 border-b border-[var(--color-border)] lg:divide-x divide-[var(--color-border)]">
        {/* Card 1: Conversions / Entregas Efectivas (3 Cols) */}
        <div className="lg:col-span-3 zipp-card pr-4 flex flex-col justify-between">
          <div>
            <h2 className="text-sm font-bold text-[var(--color-text-main)]">Efectividad Operativa</h2>
            <p className="text-[11px] text-[var(--color-text-muted)]">Tasa de pedidos entregados con éxito</p>
          </div>

          {/* Donut Progress Gauge */}
          <div className="my-2 flex flex-col items-center justify-center relative">
            <div className="relative w-28 h-28 flex items-center justify-center">
              <svg className="w-full h-full transform -rotate-90" viewBox="0 0 120 120">
                <circle
                  cx="60"
                  cy="60"
                  r="48"
                  style={{ stroke: 'var(--color-bg-alt)' }}
                  strokeWidth="9"
                  fill="none"
                />
                <circle
                  cx="60"
                  cy="60"
                  r="48"
                  style={{ stroke: 'var(--color-primary)' }}
                  strokeWidth="9"
                  strokeDasharray="301"
                  strokeDashoffset={301 - (301 * parseFloat(deliveryRate)) / 100}
                  strokeLinecap="round"
                  fill="none"
                  className="transition-all duration-1000 ease-out"
                />
              </svg>
              <div className="absolute inset-0 flex flex-col items-center justify-center text-center p-2">
                <span className="text-xl font-bold text-[var(--color-text-main)]">{deliveryRate}%</span>
                <span className="text-[10px] text-[var(--color-text-secondary)] font-medium leading-tight">Entregas Exitosas</span>
              </div>
            </div>
          </div>

          {/* Weekly Stats */}
          <div className="space-y-2">
            <div className="grid grid-cols-2 gap-2 text-center pt-2 border-t border-[var(--color-border)]">
              <div>
                <p className="text-[11px] text-[var(--color-text-muted)]">Pedidos Hoy</p>
                <p className="text-sm font-bold text-[var(--color-text-main)]">{stats?.todayOrders ?? 0}</p>
              </div>
              <div className="border-l border-[var(--color-border)]">
                <p className="text-[11px] text-[var(--color-text-muted)]">Esta Semana</p>
                <p className="text-sm font-bold text-[var(--color-text-main)]">{stats?.weekOrders ?? 0}</p>
              </div>
            </div>

            <a
              href="/orders"
              className="block w-full py-1.5 px-3 rounded-lg bg-[var(--color-bg)] hover:bg-[var(--color-bg-alt)] border border-[var(--color-border)] text-xs font-semibold text-[var(--color-text-main)] transition-colors text-center cursor-pointer"
            >
              Ver Todos los Pedidos
            </a>
          </div>
        </div>

        {/* Card 2: Performance Chart (6 Cols) */}
        <div className="lg:col-span-6 zipp-card px-4 flex flex-col justify-between">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-2">
            <div>
              <h2 className="text-sm font-bold text-[var(--color-text-main)]">Rendimiento de Pedidos y Ventas</h2>
              <p className="text-[11px] text-[var(--color-text-muted)]">Evolución temporal de la demanda</p>
            </div>

            {/* Time Filter Pills */}
            <div className="flex items-center gap-1 bg-[var(--color-bg-alt)] p-0.5 rounded-lg">
              {(['7D', '14D', '30D', '90D'] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setPeriod(t)}
                  className={`px-2.5 py-1 text-[10px] font-bold rounded-md transition-all cursor-pointer ${period === t
                    ? 'bg-[var(--color-surface)] text-[var(--color-text-main)] shadow-xs'
                    : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-main)]'
                    }`}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>

          {/* Alert Notice */}
          <div className="mb-2 text-[11px] text-[#8A5D08] flex items-center justify-between">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-[var(--color-primary)] flex-shrink-0" />
              <span>Operación en tiempo real: {stats?.activeOrders ?? 0} pedidos procesándose en este momento.</span>
            </div>
            <button
              onClick={fetchDashboardData}
              disabled={refreshing}
              className="text-[var(--color-primary)] hover:underline font-bold text-[10px] cursor-pointer"
            >
              {refreshing ? 'Actualizando...' : 'Refrescar'}
            </button>
          </div>

          {/* Hybrid Bar (Teal Orders) + Spline Line (Blue Revenue) Chart */}
          {!hasChartData ? (
            <div className="w-full h-40 flex items-center justify-center text-center text-[11px] text-[var(--color-text-muted)] font-medium">
              Aún no hay datos de ventas para el periodo seleccionado.
            </div>
          ) : (
          <div className="w-full relative select-none">
            <svg viewBox={`0 0 ${chartW + 40} ${chartH + 40}`} className="w-full h-40 overflow-visible">
              {/* Y Axis Gridlines */}
              {[4, 3, 2, 1, 0].map((step) => {
                const val = Math.round((maxOrders / 4) * step);
                const y = chartH - (step / 4) * chartH + 10;
                return (
                  <g key={step}>
                    <line x1="30" y1={y} x2={chartW + 30} y2={y} stroke="#E1E6ED" strokeDasharray="3 3" />
                    <text x="22" y={y + 3.5} textAnchor="end" fontSize="10" fill="#0B0F19" fontFamily="var(--font-sans)">
                      {val}
                    </text>
                  </g>
                );
              })}

              {/* Monthly / Daily Teal Bars */}
              {chartData.map((d, i) => {
                const x = 30 + stepX * i + (stepX - 16) / 2;
                const barH = maxOrders > 0 ? (d.orders / maxOrders) * chartH : 0;
                const y = chartH - barH + 10;
                const isHover = hoveredIndex === i;

                return (
                  <g key={i} onMouseEnter={() => setHoveredIndex(i)} onMouseLeave={() => setHoveredIndex(null)} className="cursor-pointer">
                    <rect
                      x={x}
                      y={y}
                      width={16}
                      height={Math.max(barH, 3)}
                      rx={3}
                      fill={isHover ? '#E5B242' : '#D69E26'}
                      className="transition-colors duration-150"
                    />
                    {/* Date Label */}
                    <text
                      x={30 + stepX * i + stepX / 2}
                      y={chartH + 28}
                      textAnchor="middle"
                      fontSize="10"
                      fill={isHover ? '#141B2A' : '#0B0F19'}
                      fontWeight={isHover ? 'bold' : 'normal'}
                    >
                      {d.date}
                    </text>
                  </g>
                );
              })}

              {/* Blue Spline Line */}
              {splinePath && (
                <path
                  d={splinePath}
                  transform="translate(30, 10)"
                  fill="none"
                  stroke="#E5B242"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                />
              )}

              {/* Tooltip Callout */}
              {hoveredIndex !== null && chartData[hoveredIndex] && (
                <g transform={`translate(${30 + stepX * hoveredIndex + stepX / 2}, ${chartH - (chartData[hoveredIndex].orders / maxOrders) * chartH - 10})`}>
                  <rect x="-48" y="-36" width="96" height="30" rx="6" fill="#141B2A" />
                  <polygon points="0, -6 -5, -1 5, -1" fill="#141B2A" />
                  <text x="0" y="-22" textAnchor="middle" fontSize="9" fill="#0B0F19" fontWeight="bold">
                    {chartData[hoveredIndex].date}
                  </text>
                  <text x="0" y="-10" textAnchor="middle" fontSize="10" fill="#ffffff" fontWeight="bold">
                    {chartData[hoveredIndex].orders} pedidos
                  </text>
                </g>
              )}
            </svg>
          </div>
          )}

          {/* Legend */}
          <div className="flex items-center justify-center gap-3 mt-1 pt-2 border-t border-[var(--color-border)] text-xs">
            <div className="flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full bg-[var(--color-primary)]" />
              <span className="text-[var(--color-text-secondary)] text-[11px] font-medium">Volumen de Pedidos</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full bg-[var(--color-primary-light)]" />
              <span className="text-[var(--color-text-secondary)] text-[11px] font-medium">Ventas ($ COP)</span>
            </div>
          </div>
        </div>

        {/* Card 3: Métodos de Pago y Canales (3 Cols) */}
        <div className="lg:col-span-3 zipp-card pl-4 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-sm font-bold text-[var(--color-text-main)]">Canales y Métodos</h2>
            </div>

            <div className="divide-y divide-[var(--color-border)] text-xs">
              {paymentBreakdown.map((b, idx) => (
                <div key={idx} className="py-1.5 first:pt-0">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[var(--color-text-main)] font-semibold flex items-center gap-1.5 min-w-0">
                      <b.icon className="w-3.5 h-3.5 text-[var(--color-primary)]" />
                      {b.name}
                    </span>
                    <span className="text-[var(--color-primary)] font-bold flex-shrink-0 pl-2">{b.percent}</span>
                  </div>
                  <p className="text-[11px] text-[var(--color-text-secondary)]">{b.count}</p>
                </div>
              ))}
            </div>
          </div>

          <div className="mt-2 pt-2 border-t border-[var(--color-border)] text-center">
            <a href="/financials" className="text-xs font-semibold text-[var(--color-text-secondary)] hover:text-[var(--color-primary)] transition-colors">
              Ver Balances Financieros
            </a>
          </div>
        </div>
      </div>

      {/* ── ROW 3: Últimos Pedidos en Vivo ── */}
      <div className="grid grid-cols-1 pt-3">
        {/* Real Orders Table */}
        <div className="zipp-card flex flex-col justify-between">
          <div className="flex items-center justify-between mb-2">
            <div>
              <h2 className="text-sm font-bold text-[var(--color-text-main)]">Últimos Pedidos en Vivo</h2>
              <p className="text-[11px] text-[var(--color-text-muted)]">Actividad reciente de compras en la plataforma</p>
            </div>
            <a
              href="/orders"
              className="text-xs font-semibold text-[var(--color-primary)] hover:underline flex items-center gap-1"
            >
              Ver Todos
              <ArrowUpRight className="w-3.5 h-3.5" />
            </a>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-[var(--color-text-muted)] border-b border-[var(--color-border)]">
                  <th className="pb-1.5 font-semibold">ID Pedido</th>
                  <th className="pb-1.5 font-semibold">Establecimiento</th>
                  <th className="pb-1.5 font-semibold text-right">Total</th>
                  <th className="pb-1.5 font-semibold text-right">Estado</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-border)]">
                {recentOrders.length > 0 ? (
                  recentOrders.slice(0, 5).map((o) => {
                    const st = getStatusBadge(o.status);
                    return (
                      <tr key={o._id} className="hover:bg-[var(--color-bg)] transition-colors">
                        <td className="py-1.5 font-medium text-[var(--color-text-main)]">
                          <span className="font-mono text-[var(--color-primary)] font-bold">#{o._id.slice(-6).toUpperCase()}</span>
                        </td>
                        <td className="py-1.5 text-[var(--color-text-main)] font-semibold truncate max-w-[140px]">
                          {o.businessId?.name || 'Establecimiento'}
                        </td>
                        <td className="py-1.5 text-right font-bold text-[var(--color-text-main)]">
                          ${(o.total || 0).toLocaleString('es-CO')}
                        </td>
                        <td className="py-1.5 text-right">
                          <span className={`text-[10px] font-bold uppercase tracking-wide ${st.text}`}>
                            {st.label}
                          </span>
                        </td>
                      </tr>
                    );
                  })
                ) : (
                  <tr>
                    <td colSpan={4} className="py-4 text-center text-[var(--color-text-muted)] font-medium">
                      No hay pedidos registrados todavía en el sistema.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="mt-2 pt-2 border-t border-[var(--color-border)] text-right">
            <span className="text-[11px] text-[var(--color-text-muted)]">Monitoreo central en vivo</span>
          </div>
        </div>
      </div>
    </div>
  );
}
