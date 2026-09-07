import { useCallback, useEffect, useState } from 'react';
import {
  Receipt, BadgePercent, AlertCircle, TicketPercent, Gauge,
  CheckCircle2, ShieldAlert, Landmark, CreditCard
} from 'lucide-react';
import api from '../services/api';
import { apiMessage } from '../lib/apiError';

interface SummaryType {
  totalRevenue: number;
  platformEarnings: number;
  totalBusinessPayouts: number;
  totalDriverPayouts: number;
  totalOrders: number;
  pendingDriverDebts: number;
}

interface PayoutSummary {
  accrued: number;
  payable: number;
  settled: number;
  outstanding: number;
}

interface LedgerBalance {
  account: string;
  debit: number;
  credit: number;
  balance: number;
}

interface CashRow {
  _id: string;
  driverId?: { userId?: { name: string } };
  amount: number;
  status: string;
  orderId?: { orderNumber: string };
}

interface IncidentRow {
  _id: string;
  driverId?: { userId?: { name: string; phone?: string } };
  orderId?: { orderNumber: string; createdAt?: string; clientId?: { name: string } };
  amount: number;
  status: string;
  resolution?: string | null;
  driverNote?: string;
  adminNote?: string;
  resolvedBy?: { name: string } | null;
  createdAt: string;
}

const money = (v: number) => `$${Math.round(v ?? 0).toLocaleString('es-CO')}`;

const CUENTA_LABEL: Record<string, string> = {
  customer_payment: 'Cobrado a clientes',
  receivable: 'Por cobrar',
  cash_in_transit: 'Efectivo en poder de repartidores',
  merchant_payable: 'Por pagar a comercios',
  driver_payable: 'Por pagar a repartidores',
  commission_revenue: 'Comisiones ZIPP',
  service_fee_revenue: 'Tarifas de servicio',
  delivery_margin_revenue: 'Margen de domicilio',
  tax_payable: 'Impuestos por pagar',
  promotion_expense: 'Gasto promocional',
  cash_shortage_expense: 'Faltantes de efectivo asumidos',
  refund: 'Reembolsos',
  chargeback: 'Contracargos',
};

/**
 * Estado de una incidencia de efectivo.
 *
 * Va aparte del estado de la conciliación a propósito: "por rendir" habla
 * del dinero y "abierta" habla de la discusión sobre ese dinero. Mezclarlos
 * escondería justo el caso que hay que atender.
 */
const ESTADO_INCIDENCIA: Record<string, { texto: string; clase: string }> = {
  open: { texto: 'Abierta', clase: 'bg-[var(--color-danger-bg)] text-[#B91C1C]' },
  under_review: { texto: 'En revisión', clase: 'bg-[var(--color-warning-bg)] text-[#B45309]' },
  resolved: { texto: 'Resuelta', clase: 'bg-[var(--color-success-bg)] text-[#047857]' },
  rejected: { texto: 'Rechazada', clase: 'bg-[var(--color-bg-alt)] text-[var(--color-text-secondary)]' },
};

const RESOLUCION_INCIDENCIA: Record<string, string> = {
  driver_favor: 'A favor del domiciliario',
  debt_confirmed: 'Deuda confirmada',
  closed: 'Cerrada administrativamente',
};

const ESTADO_EFECTIVO: Record<string, { texto: string; clase: string }> = {
  pending: { texto: 'Por rendir', clase: 'text-[var(--color-warning)]' },
  reported: { texto: 'Reportado', clase: 'text-[#8A5D08]' },
  verified: { texto: 'Verificado', clase: 'text-[var(--color-primary)]' },
  overdue: { texto: 'Vencido', clase: 'text-[var(--color-danger)]' },
  settled: { texto: 'Liquidado', clase: 'text-[var(--color-text-muted)]' },
};

export default function Financials() {
  const [period, setPeriod] = useState<'today' | 'week' | 'month'>('today');
  const [summary, setSummary] = useState<SummaryType | null>(null);
  const [payouts, setPayouts] = useState<{ business: PayoutSummary; driver: PayoutSummary } | null>(null);
  const [ledger, setLedger] = useState<{ balances: LedgerBalance[]; balanced: boolean } | null>(null);
  const [cash, setCash] = useState<CashRow[]>([]);
  const [incidents, setIncidents] = useState<IncidentRow[]>([]);
  const [expandido, setExpandido] = useState<string | null>(null);
  const [notaAdmin, setNotaAdmin] = useState('');
  const [errorIncidencia, setErrorIncidencia] = useState('');
  const [loading, setLoading] = useState(true);

  // `useCallback` con sus dependencias de verdad, y el efecto colgando de
  // ella. Antes la función se recreaba en cada render y el efecto
  // dependía de [period] a mano: la lista tenía que mantenerse
  // sincronizada con lo que la función lee por dentro, y cuando dejaba
  // de estarlo el panel se quedaba pidiendo datos del filtro anterior.
  const cargar = useCallback(async () => {
    try {
      setLoading(true);
      const [resSummary, resPayouts, resLedger, resCash, resIncidents] = await Promise.all([
        api.get(`/admin/financials?period=${period}`),
        api.get('/finance/payouts/summary'),
        api.get('/finance/ledger/summary'),
        api.get('/finance/cash?limit=100'),
        api.get('/finance/cash/incidents?limit=100'),
      ]);
      setSummary(resSummary.data.data);
      setPayouts(resPayouts.data.data);
      setLedger(resLedger.data.data);
      setCash(resCash.data.data);
      setIncidents(resIncidents.data.data);
    } catch (err) {
      console.error('Error fetching financial data:', err);
    } finally {
      setLoading(false);
    }
  }, [period]);

  useEffect(() => { cargar(); }, [cargar]);

  const cuenta = (nombre: string) => ledger?.balances.find((b) => b.account === nombre);

  const ingresoBruto =
    Math.abs(cuenta('commission_revenue')?.balance ?? 0) +
    Math.abs(cuenta('service_fee_revenue')?.balance ?? 0) +
    Math.abs(cuenta('delivery_margin_revenue')?.balance ?? 0);
  const gastoPromocional = cuenta('promotion_expense')?.balance ?? 0;
  // Un faltante perdonado es dinero que ZIPP puso, igual que una promoción:
  // dejarlo fuera del margen haría que operar en efectivo pareciera más
  // rentable de lo que es, que es justo la cifra que hay que vigilar para
  // decidir si el método se mantiene.
  const gastoFaltantes = cuenta('cash_shortage_expense')?.balance ?? 0;
  const margenNeto = ingresoBruto - gastoPromocional - gastoFaltantes;

  const gmv = summary?.totalRevenue ?? 0;
  const pasivoComercios = payouts?.business.outstanding ?? 0;
  const pasivoRepartidores = payouts?.driver.outstanding ?? 0;
  const efectivoPendiente = cash
    .filter((c) => c.status !== 'settled')
    .reduce((s, c) => s + c.amount, 0);

  const verificar = async (ids: string[]) => {
    try {
      await api.post('/finance/cash/verify', { ids });
      await cargar();
    } catch (err) {
      console.error(err);
    }
  };

  const liquidar = async (ids: string[]) => {
    try {
      await api.post('/finance/cash/settle', { ids });
      await cargar();
    } catch (err) {
      console.error(err);
    }
  };

  const revisarIncidencia = async (id: string) => {
    setErrorIncidencia('');
    try {
      await api.post(`/finance/cash/incidents/${id}/review`);
      setExpandido(id);
      await cargar();
    } catch (err) {
      setErrorIncidencia(apiMessage(err, 'No se pudo abrir la revisión.'));
    }
  };

  const resolverIncidencia = async (id: string, resolution: string) => {
    setErrorIncidencia('');
    try {
      await api.post(`/finance/cash/incidents/${id}/resolve`, {
        resolution,
        ...(notaAdmin.trim() ? { adminNote: notaAdmin.trim() } : {}),
      });
      setExpandido(null);
      setNotaAdmin('');
      await cargar();
    } catch (err) {
      setErrorIncidencia(apiMessage(err, 'No se pudo resolver la incidencia.'));
    }
  };

  const incidenciasAbiertas = incidents.filter(
    (i) => i.status === 'open' || i.status === 'under_review'
  );

  const tarjetas = [
    {
      label: 'GMV (Volumen Total)',
      value: money(gmv),
      sub: `${summary?.totalOrders ?? 0} pedidos procesados`,
      icon: Receipt,
      color: 'text-[var(--color-text-main)]',
      iconBg: 'bg-[var(--color-primary-bg)] text-[var(--color-primary)]',
    },
    {
      label: 'Ingreso Bruto ZIPP',
      value: money(ingresoBruto),
      sub: 'Comisiones + tarifas servicio',
      icon: BadgePercent,
      color: 'text-[var(--color-primary)]',
      iconBg: 'bg-[var(--color-primary-bg)] text-[var(--color-primary)]',
    },
    {
      label: 'Gasto Promocional',
      value: `−${money(gastoPromocional)}`,
      sub: 'Cupones pagados por ZIPP',
      icon: TicketPercent,
      color: 'text-[var(--color-warning)]',
      iconBg: 'bg-[var(--color-warning-bg)] text-[var(--color-warning)]',
    },
    {
      label: 'Margen Neto Estimado',
      value: money(margenNeto),
      sub: 'Utilidad bruta operacional',
      icon: Gauge,
      color: margenNeto >= 0 ? 'text-[var(--color-primary)]' : 'text-[var(--color-danger)]',
      iconBg: margenNeto >= 0 ? 'bg-[var(--color-primary-bg)] text-[var(--color-primary)]' : 'bg-[var(--color-danger-bg)] text-[var(--color-danger)]',
    },
  ];

  const pasivos = [
    {
      label: 'Por pagar a comercios',
      value: pasivoComercios,
      detalle: `${money(payouts?.business.payable ?? 0)} listo para giro`,
    },
    {
      label: 'Por pagar a domiciliarios',
      value: pasivoRepartidores,
      detalle: `${money(payouts?.driver.payable ?? 0)} listo para giro`,
    },
    {
      label: 'Impuestos retenidos',
      value: Math.abs(cuenta('tax_payable')?.balance ?? 0),
      detalle: 'Retención en la fuente',
    },
    {
      label: 'Efectivo en calle',
      value: efectivoPendiente,
      detalle: 'En poder de repartidores',
    },
  ];

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div className="page-header">
        <div>
          <h1 className="page-title">Consola Financiera ZIPP</h1>
          <p className="page-subtitle">Balance contable, comisiones, pasivos y liquidaciones de efectivo</p>
        </div>
        <div className="flex gap-1 bg-[var(--color-surface)] p-1 rounded-lg border border-[var(--color-border)] shadow-xs">
          {(['today', 'week', 'month'] as const).map((p) => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              className={`px-3 py-1.5 rounded-md text-xs font-bold uppercase tracking-wider transition-all cursor-pointer ${
                period === p
                  ? 'bg-[var(--color-primary)] text-white shadow-xs'
                  : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-main)]'
              }`}
            >
              {p === 'today' ? 'Hoy' : p === 'week' ? 'Semana' : 'Mes'}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="table-container p-16 text-center text-[var(--color-text-secondary)] text-xs font-semibold">
          Cargando balance financiero...
        </div>
      ) : (
        <>
          {/* Status Ledger Pill */}
          {ledger && (
            <div className={`p-4 rounded-xl border flex items-center justify-between shadow-xs ${
              ledger.balanced
                ? 'bg-[var(--color-primary-bg)] border-[var(--color-primary-bg)] text-[var(--color-primary)]'
                : 'bg-[var(--color-danger-bg)] border-[var(--color-danger-bg)] text-[var(--color-danger)]'
            }`}>
              <div className="flex items-center gap-3">
                {ledger.balanced ? <CheckCircle2 className="w-5 h-5" /> : <ShieldAlert className="w-5 h-5" />}
                <div>
                  <p className="text-xs font-bold uppercase tracking-wider">
                    {ledger.balanced ? 'Libro Contable Cuadrado' : 'Alerta: Libro Contable Descuadrado'}
                  </p>
                  <p className="text-[11px] opacity-90">
                    {ledger.balanced ? 'Los débitos y créditos coinciden en cero diferencias.' : 'Existen discrepancias en los registros financieros.'}
                  </p>
                </div>
              </div>
              <Landmark className="w-5 h-5 opacity-60" />
            </div>
          )}

          {/* Main KPI Row */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6 pb-6 border-b border-[var(--color-border-light)]">
            {tarjetas.map((c) => (
              <div key={c.label} className="flex items-start gap-3">
                <div className={`w-10 h-10 rounded-lg shrink-0 ${c.iconBg} flex items-center justify-center`}>
                  <c.icon className="w-5 h-5" />
                </div>
                <div>
                  <p className="text-[11px] font-bold text-[var(--color-text-secondary)] uppercase tracking-wider">{c.label}</p>
                  <p className={`kpi-value text-2xl mt-1 ${c.color}`}>{c.value}</p>
                  <p className="text-xs text-[var(--color-text-muted)] mt-1">{c.sub}</p>
                </div>
              </div>
            ))}
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
            {/* Pasivos */}
            <div className="space-y-3">
              <div className="flex items-center justify-between border-b border-[var(--color-border-light)] pb-3">
                <h3 className="text-sm font-bold text-[var(--color-text-main)] flex items-center gap-2">
                  <CreditCard className="w-4 h-4 text-[var(--color-warning)]" />
                  Pasivos y Obligaciones
                </h3>
                <span className="text-[10px] font-mono text-[var(--color-text-muted)]">COP</span>
              </div>
              <div className="divide-y divide-[var(--color-border-light)]">
                {pasivos.map((row) => (
                  <div key={row.label} className="flex items-center justify-between py-2.5">
                    <div>
                      <p className="text-xs font-bold text-[var(--color-text-main)]">{row.label}</p>
                      <p className="text-[10px] text-[var(--color-text-secondary)]">{row.detalle}</p>
                    </div>
                    <span className="text-sm font-bold text-[var(--color-warning)]">{money(row.value)}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Balance por Cuenta */}
            <div className="space-y-3">
              <div className="flex items-center justify-between border-b border-[var(--color-border-light)] pb-3">
                <h3 className="text-sm font-bold text-[var(--color-text-main)] flex items-center gap-2">
                  <Landmark className="w-4 h-4 text-[var(--color-primary)]" />
                  Cuentas del Libro Mayor
                </h3>
                <span className="text-[10px] font-mono text-[var(--color-text-muted)]">Ledger</span>
              </div>
              <div className="divide-y divide-[var(--color-border-light)] max-h-[240px] overflow-y-auto pr-1">
                {ledger?.balances
                  .filter((b) => b.debit !== 0 || b.credit !== 0)
                  .map((b) => (
                    <div key={b.account} className="flex items-center justify-between py-2 text-xs">
                      <span className="text-[var(--color-text-secondary)] font-medium">
                        {CUENTA_LABEL[b.account] ?? b.account}
                      </span>
                      <span className="font-bold text-[var(--color-primary)]">
                        {money(Math.abs(b.balance))}
                      </span>
                    </div>
                  ))}
              </div>
            </div>
          </div>

          {/*
            Los faltantes van ARRIBA de la conciliación, no debajo: son lo
            único de esta pantalla donde alguien está esperando una decisión.
            La conciliación normal se puede mirar cuando se pueda; una
            incidencia abierta es dinero de ZIPP en el aire y un domiciliario
            con un saldo que no sabe si debe.
          */}
          {incidents.length > 0 && (
            <div className="table-container">
              <div className="px-5 py-4 border-b border-[var(--color-border-light)] bg-[#FEF2F2] flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-bold text-[#B91C1C] flex items-center gap-2">
                    <ShieldAlert className="w-4 h-4" />
                    Efectivo no recibido
                  </h3>
                  <p className="text-xs text-[#7F1D1D]">
                    {incidenciasAbiertas.length > 0
                      ? `${incidenciasAbiertas.length} caso(s) esperando decisión · el saldo sigue pendiente hasta que se resuelva`
                      : 'Todos los casos están cerrados'}
                  </p>
                </div>
                <span className="text-sm font-bold text-[#B91C1C]">
                  {money(incidenciasAbiertas.reduce((s, i) => s + i.amount, 0))}
                </span>
              </div>

              {errorIncidencia && (
                <div className="px-5 py-2.5 bg-[#FEF2F2] border-b border-[#FECACA] text-xs font-semibold text-[#B91C1C]">
                  {errorIncidencia}
                </div>
              )}

              <div className="max-h-[420px] overflow-y-auto divide-y divide-[var(--color-border-light)]">
                {incidents.map((inc) => {
                  const estado = ESTADO_INCIDENCIA[inc.status] ?? ESTADO_INCIDENCIA.open;
                  const abierto = expandido === inc._id;
                  const decidible = inc.status === 'open' || inc.status === 'under_review';

                  return (
                    <div key={inc._id} className="p-3.5 px-5 hover:bg-[var(--color-bg)] transition-colors">
                      <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <p className="text-xs font-bold text-[var(--color-text-main)]">
                              Pedido #{inc.orderId?.orderNumber ?? 'N/A'}
                            </p>
                            <span
                              className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider ${estado.clase}`}
                            >
                              {estado.texto}
                            </span>
                            {inc.resolution && (
                              <span className="text-[10px] font-semibold text-[var(--color-text-secondary)]">
                                {RESOLUCION_INCIDENCIA[inc.resolution] ?? inc.resolution}
                              </span>
                            )}
                          </div>

                          <p className="text-[10px] text-[var(--color-text-secondary)] mt-1">
                            Domiciliario:{' '}
                            <span className="font-semibold text-[var(--color-text-main)]">
                              {inc.driverId?.userId?.name ?? 'Sin nombre'}
                            </span>
                            {inc.orderId?.clientId?.name && (
                              <> · Cliente: <span className="font-semibold text-[var(--color-text-main)]">{inc.orderId.clientId.name}</span></>
                            )}
                            {' · '}
                            {new Date(inc.createdAt).toLocaleString('es-CO')}
                          </p>

                          {inc.driverNote && (
                            <p className="text-[11px] text-[var(--color-text-secondary)] mt-1.5 italic border-l-2 border-[var(--color-border)] pl-2">
                              "{inc.driverNote}"
                            </p>
                          )}
                          {inc.adminNote && (
                            <p className="text-[11px] text-[#047857] mt-1.5 pl-2">
                              Resolución: {inc.adminNote}
                              {inc.resolvedBy?.name ? ` — ${inc.resolvedBy.name}` : ''}
                            </p>
                          )}
                        </div>

                        <div className="flex items-center gap-3 shrink-0">
                          <span className="text-xs font-bold text-[#B91C1C]">{money(inc.amount)}</span>
                          {decidible && !abierto && (
                            <button
                              onClick={() => { setNotaAdmin(''); revisarIncidencia(inc._id); }}
                              className="px-3 py-1 rounded-md text-xs font-bold bg-[var(--color-sidebar-hover)] text-white uppercase tracking-wider hover:bg-[#2A3548] cursor-pointer shadow-xs"
                            >
                              Revisar
                            </button>
                          )}
                        </div>
                      </div>

                      {/*
                        Las tres salidas se enseñan juntas y con su
                        consecuencia escrita al lado. Quien decide esto está
                        moviendo el saldo de una persona concreta, y "resolver"
                        a secas no dice en qué dirección.
                      */}
                      {decidible && abierto && (
                        <div className="mt-3 p-3 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] space-y-2.5">
                          <textarea
                            value={notaAdmin}
                            onChange={(e) => setNotaAdmin(e.target.value)}
                            placeholder="Nota de la decisión (queda en la auditoría)"
                            maxLength={500}
                            rows={2}
                            className="w-full px-3 py-2 rounded-md border border-[var(--color-border)] text-xs text-[var(--color-text-main)] resize-none focus:outline-none focus:border-[var(--color-primary)]"
                          />

                          <div className="flex flex-wrap gap-2">
                            <button
                              onClick={() => resolverIncidencia(inc._id, 'driver_favor')}
                              className="px-3 py-1.5 rounded-md text-xs font-bold bg-[#047857] text-white cursor-pointer hover:bg-[#065F46]"
                              title="Anula el saldo pendiente de este pedido"
                            >
                              Resolver a favor del domiciliario
                            </button>
                            <button
                              onClick={() => resolverIncidencia(inc._id, 'debt_confirmed')}
                              className="px-3 py-1.5 rounded-md text-xs font-bold bg-[#B91C1C] text-white cursor-pointer hover:bg-[#991B1B]"
                              title="El saldo sigue pendiente de liquidación"
                            >
                              Confirmar deuda
                            </button>
                            <button
                              onClick={() => resolverIncidencia(inc._id, 'closed')}
                              className="px-3 py-1.5 rounded-md text-xs font-bold bg-[var(--color-surface)] text-[var(--color-text-main)] border border-[var(--color-border)] cursor-pointer hover:bg-[var(--color-bg-alt)]"
                              title="Cierre sin efecto sobre el saldo"
                            >
                              Marcar como resuelta
                            </button>
                            <button
                              onClick={() => { setExpandido(null); setNotaAdmin(''); }}
                              className="px-3 py-1.5 rounded-md text-xs font-semibold text-[var(--color-text-secondary)] cursor-pointer hover:bg-[var(--color-bg-alt)]"
                            >
                              Cancelar
                            </button>
                          </div>

                          <p className="text-[10px] text-[var(--color-text-secondary)]">
                            A favor del domiciliario anula el saldo · Confirmar deuda lo
                            mantiene · Marcar como resuelta no lo toca. Las tres quedan auditadas.
                          </p>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Cash settlement table */}
          <div className="table-container">
            <div className="px-5 py-4 border-b border-[var(--color-border-light)] bg-[var(--color-bg)] flex items-center justify-between">
              <div>
                <h3 className="text-sm font-bold text-[var(--color-text-main)]">Conciliación de Efectivo por Domiciliario</h3>
                <p className="text-xs text-[var(--color-text-secondary)]">Verificación y liquidación de dinero en efectivo recaudado</p>
              </div>
              <AlertCircle className="w-4 h-4 text-[var(--color-warning)]" />
            </div>

            <div className="max-h-[300px] overflow-y-auto divide-y divide-[var(--color-border-light)]">
              {cash.filter((c) => c.status !== 'settled').map((row) => {
                const estado = ESTADO_EFECTIVO[row.status] ?? ESTADO_EFECTIVO.pending;
                return (
                  <div key={row._id} className="flex items-center justify-between p-3.5 px-5 hover:bg-[var(--color-bg)] transition-colors">
                    <div>
                      <p className="text-xs font-bold text-[var(--color-text-main)]">{row.driverId?.userId?.name || 'Domiciliario'}</p>
                      <p className="text-[10px] text-[var(--color-text-secondary)] font-mono">
                        Pedido #{row.orderId?.orderNumber ?? 'N/A'} • <span className={`font-semibold ${estado.clase}`}>{estado.texto}</span>
                      </p>
                    </div>

                    <div className="flex items-center gap-3">
                      <span className="text-xs font-bold text-[var(--color-warning)]">{money(row.amount)}</span>
                      {row.status === 'verified' ? (
                        <button
                          onClick={() => liquidar([row._id])}
                          className="px-3 py-1 rounded-md text-xs font-bold bg-[var(--color-primary)] text-white uppercase tracking-wider hover:bg-[#8A5D08] cursor-pointer shadow-xs"
                        >
                          Liquidar
                        </button>
                      ) : (
                        <button
                          onClick={() => verificar([row._id])}
                          className="px-3 py-1 rounded-md text-xs font-bold bg-[var(--color-primary)] text-white uppercase tracking-wider hover:bg-[#8A5D08] cursor-pointer shadow-xs"
                        >
                          Verificar
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}

              {cash.filter((c) => c.status !== 'settled').length === 0 && (
                <div className="p-10 text-center text-[var(--color-text-muted)] text-xs font-medium">
                  No hay efectivo pendiente por liquidar.
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

