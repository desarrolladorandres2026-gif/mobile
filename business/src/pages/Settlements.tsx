import { useCallback, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  RefreshCw, Landmark, AlertCircle, ChevronRight, ArrowLeft, Store, Download,
} from 'lucide-react';
import api from '../services/api';
import { qk } from '../lib/queryKeys';
import { useTrailingCallback } from '../hooks/useTrailingCallback';
import { useAuthStore } from '../stores/authStore';
import { useBusinessEvent } from '../hooks/realtimeContext';
import { money, signedMoney, dateTime, statusStyle } from '../lib/orderFlow';

/**
 * Liquidaciones del comercio.
 *
 * Todos los importes de esta pantalla vienen de
 * `/businesses/:id/statement`: ninguno se suma en el navegador. Esa no es
 * una preferencia de estilo — el listado de pedidos viene paginado, así
 * que sumarlos en el cliente enseñaba como "neto" la suma de los pedidos
 * que cupieron en la primera página, que es un número que no existe.
 *
 * La pantalla recorre los dos sentidos que pide el negocio: de la próxima
 * liquidación a las ventas que la componen, y de una consignación ya
 * hecha a los pedidos que pagó.
 */

interface Totals {
  orderCount: number;
  productSubtotal: number;
  merchantCommission: number;
  merchantFundedDiscount: number;
  reversedAmount: number;
  netAmount: number;
}

interface Period extends Totals {
  periodStart: string;
  periodEnd: string;
}

interface SettlementBatch {
  _id: string;
  periodStart: string;
  periodEnd: string;
  payoutCount: number;
  netAmount: number;
  reversedAmount: number;
  /** Publicidad que compraste y se descontó de este pago. */
  adSpendAmount?: number;
  reference: string;
  createdAt: string;
}

interface Statement {
  outstanding: number;
  accrued: number;
  payable: number;
  settled: number;
  nextSettlement: Totals;
  weeks: Period[];
  settlements: SettlementBatch[];
}

interface Line {
  orderId: string;
  orderNumber: string;
  orderStatus: string;
  createdAt: string;
  deliveredAt: string | null;
  productSubtotal: number;
  merchantCommission: number;
  merchantFundedDiscount: number;
  reversedAmount: number;
  netAmount: number;
  payoutStatus: string;
  settlementId: string | null;
}

/** Qué conjunto de ventas se está mirando. */
type Focus =
  | { kind: 'next' }
  | { kind: 'settlement'; batch: SettlementBatch };

export default function Settlements() {
  const selectedBusiness = useAuthStore((s) => s.selectedBusiness);

  const downloadCsv = async () => {
    if (!businessId) return;
    try {
      const response = await api.get(`/businesses/${businessId}/statement/export`, {
        responseType: 'blob',
      });

      const url = URL.createObjectURL(response.data as Blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `ventas-${new Date().toISOString().slice(0, 10)}.csv`;
      link.click();
      // Sin esto el blob se queda en memoria hasta recargar la página.
      URL.revokeObjectURL(url);
    } catch {
      setError('No se pudo descargar el archivo de ventas.');
    }
  };

  const businessId = selectedBusiness?._id;

  const queryClient = useQueryClient();
  const [focus, setFocus] = useState<Focus>({ kind: 'next' });
  const [error, setError] = useState('');

  // El extracto es la misma consulta que usa la cocina (misma clave): quien
  // viene del Dashboard ya lo tiene en pantalla sin esperar.
  const statementQuery = useQuery({
    queryKey: qk.statement(businessId),
    enabled: !!businessId,
    queryFn: async () => (await api.get(`/businesses/${businessId}/statement`)).data.data as Statement,
  });
  const statement = statementQuery.data ?? null;
  const loading = !!businessId && statementQuery.isPending;
  const loadError = statementQuery.isError ? 'No pudimos cargar tus liquidaciones. Vuelve a intentarlo.' : '';

  const linesQuery = useQuery({
    queryKey: qk.statementLines(businessId, focus.kind === 'settlement' ? focus.batch._id : 'open'),
    enabled: !!businessId,
    queryFn: async () => {
      const params =
        focus.kind === 'settlement'
          ? { settlementId: focus.batch._id, limit: 200 }
          : // Lo que aún no se ha consignado: acumulado + liquidable.
            { status: 'accrued,payable', limit: 200 };
      try {
        const { data } = await api.get(`/businesses/${businessId}/statement/lines`, { params });
        return { lines: data.data as Line[], totals: (data.meta?.totals ?? null) as Totals | null };
      } catch {
        return { lines: [] as Line[], totals: null };
      }
    },
  });
  // `null` mientras carga: la tabla lo distingue de "no hay líneas".
  const lines = linesQuery.isPending ? null : (linesQuery.data?.lines ?? []);
  const lineTotals = linesQuery.data?.totals ?? null;

  const refresh = useCallback(() => {
    setError('');
    void queryClient.invalidateQueries({ queryKey: qk.statement(businessId) });
    void queryClient.invalidateQueries({ queryKey: qk.statementLines(businessId) });
  }, [queryClient, businessId]);
  const refreshSoon = useTrailingCallback(refresh, 1000);

  // Un pedido entregado cambia lo que ZIPP debe: la próxima liquidación
  // deja de cuadrar en el instante en que se confirma una entrega.
  useBusinessEvent('order:status:changed', (payload) => {
    if (payload?.status === 'delivered' || payload?.status === 'cancelled') {
      refreshSoon();
    }
  });

  if (!selectedBusiness) {
    return (
      <div className="py-20 text-center space-y-2">
        <Store className="w-8 h-8 text-[var(--color-primary)] mx-auto" />
        <p className="font-bold text-[var(--color-text-main)] text-base">
          Sin establecimiento seleccionado
        </p>
        <p className="text-xs text-[var(--color-text-secondary)]">
          Elige un negocio en el menú lateral para ver sus liquidaciones.
        </p>
      </div>
    );
  }

  const next = statement?.nextSettlement;

  return (
    <div className="space-y-8 animate-fade-in">
      <div className="page-header">
        <div>
          <h1 className="page-title">Liquidaciones</h1>
          <p className="page-subtitle">
            Lo que ZIPP te debe, de dónde viene y qué ya se consignó
          </p>
        </div>
        <div className="flex items-center justify-center gap-2">
          {/*
            Se descarga por el cliente axios y se convierte en blob, en vez
            de abrir la URL con el token como parámetro. Un token en la
            barra de direcciones acaba en el historial del navegador, en los
            registros del servidor y en la cabecera `Referer` de la
            siguiente petición: tres sitios donde no debería estar.
          */}
          <button
            onClick={downloadCsv}
            className="px-4 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-hover)] text-xs font-semibold text-[var(--color-text-main)] transition-colors cursor-pointer flex items-center gap-2"
          >
            <Download className="w-3.5 h-3.5 text-[var(--color-primary)]" />
            Exportar CSV
          </button>

          <button
            onClick={refresh}
            className="px-4 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-hover)] text-xs font-semibold text-[var(--color-text-main)] transition-colors cursor-pointer flex items-center gap-2"
          >
            <RefreshCw className="w-3.5 h-3.5 text-[var(--color-primary)]" />
            Actualizar
          </button>
        </div>
      </div>

      {(error || loadError) && (
        <div className="flex items-start gap-2.5 rounded-xl border border-[var(--color-danger)]/30 bg-[var(--color-danger-bg)] p-3.5">
          <AlertCircle className="w-4 h-4 text-[var(--color-danger)] shrink-0 mt-0.5" />
          <p className="text-xs font-semibold text-[var(--color-danger)]">{error || loadError}</p>
        </div>
      )}

      {/* ── Franja de cifras ── */}
      <div className="grid grid-cols-1 sm:grid-cols-3 divide-y sm:divide-y-0 sm:divide-x divide-[var(--color-border-light)] border-y border-[var(--color-border-light)]">
        <Figure
          label="Próxima liquidación"
          value={money(next?.netAmount)}
          hint={`${next?.orderCount ?? 0} venta(s) acumuladas`}
          loading={loading}
          strong
        />
        <Figure
          label="Pendiente por consignar"
          value={money(statement?.outstanding)}
          hint="Incluye lo aún no cobrado por ZIPP"
          loading={loading}
        />
        <Figure
          label="Histórico consignado"
          value={money(statement?.settled)}
          hint="Transferencias ya realizadas"
          loading={loading}
        />
      </div>

      {/* ── La fórmula ── */}
      <section className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        <div>
          <h2 className="text-sm font-bold text-[var(--color-text-main)] border-b border-[var(--color-border-light)] pb-2.5 mb-1">
            Cómo se calcula tu próxima liquidación
          </h2>
          <dl className="divide-y divide-[var(--color-border-light)]">
            <FormulaRow label="Venta de productos" value={money(next?.productSubtotal)} />
            {(next?.merchantFundedDiscount ?? 0) > 0 && (
              <FormulaRow
                label="Descuentos que asumes"
                value={signedMoney(-(next?.merchantFundedDiscount ?? 0))}
                tone="warning"
              />
            )}
            <FormulaRow
              label="Comisión ZIPP"
              value={signedMoney(-(next?.merchantCommission ?? 0))}
              tone="warning"
            />
            {(next?.reversedAmount ?? 0) > 0 && (
              <FormulaRow
                label="Reembolsos y contracargos"
                value={signedMoney(-(next?.reversedAmount ?? 0))}
                tone="danger"
              />
            )}
            <FormulaRow label="Neto a consignar" value={money(next?.netAmount)} strong />
          </dl>
        </div>

        <div>
          <h2 className="text-sm font-bold text-[var(--color-text-main)] border-b border-[var(--color-border-light)] pb-2.5 mb-1">
            Semanas anteriores
          </h2>

          {statement?.weeks?.length ? (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="text-left">
                    <th className="py-2 text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">
                      Semana del
                    </th>
                    <th className="py-2 text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-muted)] text-right">
                      Ventas
                    </th>
                    <th className="py-2 text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-muted)] text-right">
                      Comisión
                    </th>
                    <th className="py-2 text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-muted)] text-right">
                      Neto
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--color-border-light)]">
                  {statement.weeks.map((week) => (
                    <tr key={week.periodStart}>
                      <td className="py-2.5 text-xs font-medium text-[var(--color-text-main)]">
                        {new Date(week.periodStart).toLocaleDateString('es-CO', {
                          day: 'numeric', month: 'short',
                        })}
                        <span className="text-[var(--color-text-muted)] font-normal">
                          {' '}· {week.orderCount} pedido(s)
                        </span>
                      </td>
                      <td className="py-2.5 text-xs tabular text-right text-[var(--color-text-secondary)]">
                        {money(week.productSubtotal)}
                      </td>
                      <td className="py-2.5 text-xs tabular text-right text-[var(--color-warning)]">
                        {signedMoney(-week.merchantCommission)}
                      </td>
                      <td className="py-2.5 text-xs tabular text-right font-bold text-[var(--color-text-main)]">
                        {money(week.netAmount)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-xs text-[var(--color-text-muted)] py-4">
              {loading ? 'Cargando…' : 'Todavía no hay semanas con ventas registradas.'}
            </p>
          )}
        </div>
      </section>

      {/* ── Consignaciones ── */}
      <section>
        <h2 className="text-sm font-bold text-[var(--color-text-main)] border-b border-[var(--color-border-light)] pb-2.5 mb-1 flex items-center gap-2">
          <Landmark className="w-4 h-4 text-[var(--color-primary)]" />
          Consignaciones realizadas
        </h2>

        {statement?.settlements?.length ? (
          <ul className="divide-y divide-[var(--color-border-light)]">
            {statement.settlements.map((batch) => {
              const open = focus.kind === 'settlement' && focus.batch._id === batch._id;
              return (
                <li key={batch._id}>
                  <button
                    onClick={() => setFocus(open ? { kind: 'next' } : { kind: 'settlement', batch })}
                    className={`w-full flex items-center justify-between gap-4 py-3 text-left cursor-pointer transition-colors hover:bg-[var(--color-surface-hover)] px-2 -mx-2 rounded-lg ${
                      open ? 'bg-[var(--color-surface-hover)]' : ''
                    }`}
                  >
                    <div className="min-w-0">
                      <p className="text-xs font-bold text-[var(--color-text-main)]">
                        {dateTime(batch.createdAt)}
                        {batch.reference ? (
                          <span className="font-normal text-[var(--color-text-muted)]">
                            {' '}· ref. {batch.reference}
                          </span>
                        ) : null}
                      </p>
                      {/* Sin esta línea, el neto baja y no hay forma de
                          saber por qué desde esta pantalla. */}
                      {(batch.adSpendAmount ?? 0) > 0 ? (
                        <p className="text-[11px] text-[var(--color-warning)] mt-0.5">
                          Incluye {money(batch.adSpendAmount ?? 0)} descontados por publicidad
                        </p>
                      ) : null}
                      <p className="text-[11px] text-[var(--color-text-muted)] mt-0.5">
                        {batch.payoutCount} pedido(s) ·{' '}
                        {new Date(batch.periodStart).toLocaleDateString('es-CO', {
                          day: 'numeric', month: 'short',
                        })}{' '}
                        al{' '}
                        {new Date(batch.periodEnd).toLocaleDateString('es-CO', {
                          day: 'numeric', month: 'short',
                        })}
                      </p>
                    </div>
                    <span className="flex items-center gap-2 shrink-0">
                      <span className="text-sm font-bold tabular text-[var(--color-success)]">
                        {money(batch.netAmount)}
                      </span>
                      <ChevronRight
                        className={`w-4 h-4 text-[var(--color-text-muted)] transition-transform ${
                          open ? 'rotate-90' : ''
                        }`}
                      />
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-xs text-[var(--color-text-muted)] py-4">
            {loading
              ? 'Cargando…'
              : 'Aún no se ha hecho ninguna consignación a tu cuenta.'}
          </p>
        )}
      </section>

      {/* ── Las ventas del conjunto enfocado ── */}
      <section>
        <div className="flex items-center justify-between gap-3 border-b border-[var(--color-border-light)] pb-2.5 mb-1">
          <h2 className="text-sm font-bold text-[var(--color-text-main)]">
            {focus.kind === 'settlement'
              ? `Ventas pagadas el ${dateTime(focus.batch.createdAt)}`
              : 'Ventas que entrarán en la próxima liquidación'}
          </h2>

          {focus.kind === 'settlement' && (
            <button
              onClick={() => setFocus({ kind: 'next' })}
              className="text-[11px] font-semibold text-[var(--color-primary)] hover:underline cursor-pointer flex items-center gap-1 shrink-0"
            >
              <ArrowLeft className="w-3 h-3" /> Volver a la próxima
            </button>
          )}
        </div>

        <div className="table-container mt-3">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="text-left">
                  <th className="table-header-cell">Pedido</th>
                  <th className="table-header-cell">Fecha</th>
                  <th className="table-header-cell">Estado</th>
                  <th className="table-header-cell text-right">Venta</th>
                  <th className="table-header-cell text-right">Comisión</th>
                  <th className="table-header-cell text-right">Neto</th>
                </tr>
              </thead>
              <tbody>
                {lines === null ? (
                  <tr>
                    <td colSpan={6} className="table-body-cell text-center text-[var(--color-text-muted)]">
                      Cargando ventas…
                    </td>
                  </tr>
                ) : lines.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="table-body-cell text-center text-[var(--color-text-muted)]">
                      {focus.kind === 'settlement'
                        ? 'Esta consignación no tiene ventas asociadas.'
                        : 'No hay ventas pendientes de liquidar.'}
                    </td>
                  </tr>
                ) : (
                  lines.map((line) => {
                    const style = statusStyle(line.orderStatus);
                    return (
                      <tr key={line.orderId} className="hover:bg-[var(--color-surface-hover)] transition-colors">
                        <td className="table-body-cell tabular font-bold text-[var(--color-primary)]">
                          {line.orderNumber}
                        </td>
                        <td className="table-body-cell text-[var(--color-text-muted)] tabular">
                          {dateTime(line.deliveredAt ?? line.createdAt)}
                        </td>
                        <td className="table-body-cell">
                          <span
                            className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[10px] font-bold uppercase tracking-wide border ${style.chip}`}
                          >
                            <span className={`w-1.5 h-1.5 rounded-full ${style.dot}`} />
                            {style.label}
                          </span>
                        </td>
                        <td className="table-body-cell text-right tabular">
                          {money(line.productSubtotal)}
                        </td>
                        <td className="table-body-cell text-right tabular text-[var(--color-warning)]">
                          {signedMoney(-line.merchantCommission)}
                        </td>
                        <td className="table-body-cell text-right tabular font-bold text-[var(--color-text-main)]">
                          {money(line.netAmount)}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>

              {lineTotals && lines?.length ? (
                <tfoot>
                  <tr className="bg-[var(--color-bg)]">
                    <td className="table-body-cell font-bold text-[var(--color-text-main)]" colSpan={3}>
                      {lineTotals.orderCount} venta(s)
                    </td>
                    <td className="table-body-cell text-right tabular font-bold">
                      {money(lineTotals.productSubtotal)}
                    </td>
                    <td className="table-body-cell text-right tabular font-bold text-[var(--color-warning)]">
                      {signedMoney(-lineTotals.merchantCommission)}
                    </td>
                    <td className="table-body-cell text-right tabular font-bold text-[var(--color-primary)]">
                      {money(lineTotals.netAmount)}
                    </td>
                  </tr>
                </tfoot>
              ) : null}
            </table>
          </div>
        </div>
      </section>
    </div>
  );
}

function Figure({
  label, value, hint, loading, strong = false,
}: {
  label: string;
  value: string;
  hint: string;
  loading: boolean;
  strong?: boolean;
}) {
  return (
    <div className="py-4 px-1 sm:px-5">
      <p className="text-xs font-semibold text-[var(--color-text-secondary)]">{label}</p>
      {loading ? (
        <span className="block h-7 w-28 mt-1 rounded bg-[var(--color-bg-alt)] animate-pulse" />
      ) : (
        <p
          className={`kpi-value mt-0.5 ${
            strong ? 'text-2xl text-[var(--color-primary)]' : 'text-2xl'
          }`}
        >
          {value}
        </p>
      )}
      <p className="text-[11px] text-[var(--color-text-muted)] mt-1">{hint}</p>
    </div>
  );
}

function FormulaRow({
  label, value, tone = 'normal', strong = false,
}: {
  label: string;
  value: string;
  tone?: 'normal' | 'warning' | 'danger';
  strong?: boolean;
}) {
  const tones = {
    normal: 'text-[var(--color-text-main)]',
    warning: 'text-[var(--color-warning)]',
    danger: 'text-[var(--color-danger)]',
  };
  return (
    <div className="flex items-center justify-between gap-3 py-2.5">
      <dt
        className={`text-xs ${
          strong
            ? 'font-bold text-[var(--color-primary)]'
            : 'font-medium text-[var(--color-text-secondary)]'
        }`}
      >
        {label}
      </dt>
      <dd
        className={`kpi-value text-sm tabular ${
          strong ? 'text-[var(--color-primary)]' : tones[tone]
        }`}
      >
        {value}
      </dd>
    </div>
  );
}
