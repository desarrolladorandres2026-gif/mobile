import { useCallback, useEffect, useState } from 'react';
import {
 Receipt, BadgePercent, X, TicketPercent, Gauge,
 CheckCircle2, ShieldAlert, Landmark, CreditCard
} from 'lucide-react';
import api from '../services/api';
import Pagination from '../components/Pagination';
import { apiMessage } from '../lib/apiError';
import { day } from '../lib/drivers';
import { useAuthStore } from '../stores/authStore';
import { Permission } from '../lib/permissions';
import type { PlatformResult } from '../lib/apiTypes';

interface SummaryType {
 totalRevenue: number;
 platformEarnings: number;
 totalBusinessPayouts: number;
 totalDriverPayouts: number;
 totalOrders: number;
 pendingDriverDebts: number;
 platformResult?: PlatformResult;
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

interface PendingAccount {
 businessId: string;
 businessName: string;
 ownerName?: string;
 method: string;
 accountMasked: string;
 holderName: string;
 updatedAt: string;
 previousLast4?: string;
 holderMatchesLegal: boolean | null;
 sharedWithBusinesses?: number;
 hasFreshBankCertificate?: boolean;
}

interface Clawback {
 id: string;
 orderId: string;
 orderNumber?: string;
 businessId?: string;
 businessName?: string;
 amount: number;
 netAmount: number;
 status: 'open' | 'collected' | 'written_off';
 daysOpen: number;
 createdAt: string;
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
 errand_advance_payable: 'Compras de mandados por reembolsar',
 payout_disbursement: 'Pagado a comercios y domiciliarios',
 ad_spend_offset: 'Publicidad compensada en liquidaciones',
 payout_offset_clearing: 'Arrastres en compensación (debe quedar en 0)',
 driver_fee_absorbed_expense: 'Tarifas de domiciliario asumidas por reembolso',
 bad_debt_expense: 'Arrastres incobrables',
 payment_processing_expense: 'Comisión estimada de Wompi',
 gateway_withheld: 'Retenido por Wompi (por conciliar)',
 loyalty_payable: 'Puntos por canjear (programa retirado)',
};

/**
 * Estado de una incidencia de efectivo.
 *
 * Va aparte del estado de la conciliación a propósito:"por rendir" habla
 * del dinero y"abierta" habla de la discusión sobre ese dinero. Mezclarlos
 * escondería justo el caso que hay que atender.
 */
const ESTADO_INCIDENCIA: Record<string, { texto: string; clase: string }> = {
 open: { texto: 'Abierta', clase: 'text-[#B91C1C]' },
 under_review: { texto: 'En revisión', clase: 'text-[#B45309]' },
 resolved: { texto: 'Resuelta', clase: 'text-[#047857]' },
 rejected: { texto: 'Rechazada', clase: 'text-[var(--color-text-main)]' },
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
 settled: { texto: 'Liquidado', clase: 'text-[var(--color-text-main)]' },
};

export default function Financials() {
 const canManage = useAuthStore((s) => s.hasPermission(Permission.FINANCE_MANAGE));
 const canProcessPayouts = useAuthStore((s) => s.hasPermission(Permission.PAYOUTS_PROCESS));
 const [period, setPeriod] = useState<'today' | 'week' | 'month'>('today');
 const [summary, setSummary] = useState<SummaryType | null>(null);
 const [payouts, setPayouts] = useState<{ business: PayoutSummary; driver: PayoutSummary } | null>(null);
 const [ledger, setLedger] = useState<{ balances: LedgerBalance[]; balanced: boolean; platformResult?: PlatformResult } | null>(null);
 const [cash, setCash] = useState<CashRow[]>([]);
 const [incidents, setIncidents] = useState<IncidentRow[]>([]);
 const [expandido, setExpandido] = useState<string | null>(null);
 const [notaAdmin, setNotaAdmin] = useState('');
 const [errorIncidencia, setErrorIncidencia] = useState('');
 const [error, setError] = useState('');
 const [loading, setLoading] = useState(true);
 const [cashStatus, setCashStatus] = useState<string>('reported');
 const [cashTotals, setCashTotals] = useState<Record<string, { count: number; amount: number }>>({});
 const [verifying, setVerifying] = useState<CashRow | null>(null);
 const [verifyForm, setVerifyForm] = useState({ reference: '', receiptUrl: '' });
 const [verifyError, setVerifyError] = useState('');
 const [clawbacks, setClawbacks] = useState<Clawback[]>([]);
 const [clawbackAction, setClawbackAction] = useState<{ item: Clawback; kind: 'collect' | 'write-off' } | null>(null);
 const [clawbackForm, setClawbackForm] = useState({ reference: '', receiptUrl: '', reason: '' });
 const [clawbackError, setClawbackError] = useState('');
 const [pendingAccounts, setPendingAccounts] = useState<PendingAccount[]>([]);

 // Dos tablas, dos paginadores independientes: no comparten contador de
 // página porque una persona puede estar en la página 3 de incidencias
 // y en la 1 de efectivo pendiente al mismo tiempo.
 const [cashPage, setCashPage] = useState(1);
 const [cashMeta, setCashMeta] = useState({ total: 0, totalPages: 1, limit: 25 });
 const [incidentsPage, setIncidentsPage] = useState(1);
 const [incidentsMeta, setIncidentsMeta] = useState({ total: 0, totalPages: 1, limit: 25 });
 const PAGE_SIZE = 25;

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
 api.get('/finance/ledger/summary', { params: { period } }),
 api.get('/finance/cash', { params: { page: cashPage, limit: PAGE_SIZE, status: cashStatus } }),
 api.get('/finance/cash/incidents', { params: { page: incidentsPage, limit: PAGE_SIZE } }),
 ]);
 const [resTotals, resClawbacks] = await Promise.all([
 api.get('/finance/cash/totals'),
 api.get('/finance/clawbacks', { params: { status: 'open' } }),
 ]);
 setCashTotals(resTotals.data.data ?? {});
 setClawbacks(resClawbacks.data.data ?? []);
 if (canProcessPayouts) {
 const resAccounts = await api.get('/finance/payout-accounts/pending');
 setPendingAccounts(resAccounts.data.data ?? []);
 }
 setSummary(resSummary.data.data);
 setPayouts(resPayouts.data.data);
 setLedger(resLedger.data.data);
 setCash(resCash.data.data);
 if (resCash.data.meta) setCashMeta(resCash.data.meta);
 setIncidents(resIncidents.data.data);
 if (resIncidents.data.meta) setIncidentsMeta(resIncidents.data.meta);
 setError('');
 } catch (err) {
 console.error('Error fetching financial data:', err);
 setError(apiMessage(err, 'No se pudieron cargar las finanzas.'));
 } finally {
 setLoading(false);
 }
 }, [period, cashPage, incidentsPage, cashStatus, canProcessPayouts]);

 useEffect(() => { cargar(); }, [cargar]);

 const cuenta = (nombre: string) => ledger?.balances.find((b) => b.account === nombre);

 // Una sola definición de ingreso, la del servidor (libro mayor, hora de
 // Colombia): la misma cifra que ven el Dashboard y el Resumen diario.
 const resultado = ledger?.platformResult ?? summary?.platformResult;
 const ingresoBruto = resultado?.grossRevenue ?? 0;
 const gastoPromocional = resultado?.promotionExpense ?? 0;
 const comisionPasarela = resultado?.processingExpense ?? 0;
 const margenNeto = resultado?.netAfterGatewayCosts ?? resultado?.netBeforeGatewayCosts ?? 0;
 const periodoLabel = period === 'today' ? 'Hoy' : period === 'week' ? 'Últimos 7 días' : 'Últimos 30 días';

 const gmv = summary?.totalRevenue ?? 0;
 const pasivoComercios = payouts?.business.outstanding ?? 0;
 const pasivoRepartidores = payouts?.driver.outstanding ?? 0;
 // Sobre el total del servidor, no sobre la página visible.
 const efectivoPendiente = ['pending', 'reported', 'overdue'].reduce(
 (sum, status) => sum + (cashTotals[status]?.amount ?? 0),
 0
 );

 const openClawback = (item: Clawback, kind: 'collect' | 'write-off') => {
 setClawbackAction({ item, kind });
 setClawbackForm({ reference: '', receiptUrl: '', reason: '' });
 setClawbackError('');
 };

 const runClawback = async () => {
 if (!clawbackAction) return;
 const { item, kind } = clawbackAction;
 let body: Record<string, string>;
 if (kind === 'collect') {
 const reference = clawbackForm.reference.trim();
 const receiptUrl = clawbackForm.receiptUrl.trim();
 if (reference.length < 3) return setClawbackError('Escribe la referencia del pago (mínimo 3 caracteres).');
 if (!/^https?:\/\/\S+$/i.test(receiptUrl)) return setClawbackError('Pega el enlace del comprobante (debe empezar por http).');
 body = { reference, receiptUrl };
 } else {
 const reason = clawbackForm.reason.trim();
 if (reason.length < 5) return setClawbackError('Escribe el motivo del castigo (mínimo 5 caracteres).');
 body = { reason };
 }
 try {
 await api.post(`/finance/clawbacks/${item.id}/${kind}`, body);
 setClawbackAction(null);
 await cargar();
 } catch (err) {
 setClawbackError(apiMessage(err, 'No se pudo registrar.'));
 }
 };

 const verificar = async () => {
 if (!verifying) return;
 const reference = verifyForm.reference.trim();
 const receiptUrl = verifyForm.receiptUrl.trim();
 if (reference.length < 4) {
 setVerifyError('Escribe la referencia de la consignación (mínimo 4 caracteres).');
 return;
 }
 if (!/^https?:\/\/\S+$/i.test(receiptUrl)) {
 setVerifyError('Pega el enlace del comprobante (debe empezar por http).');
 return;
 }
 try {
 await api.post('/finance/cash/verify', { ids: [verifying._id], reference, receiptUrl, amount: verifying.amount });
 setVerifying(null);
 await cargar();
 } catch (err) {
 setVerifyError(apiMessage(err, 'No se pudo verificar el efectivo.'));
 }
 };

 const liquidar = async (ids: string[]) => {
 try {
 await api.post('/finance/cash/settle', { ids });
 await cargar();
 } catch (err) {
 setError(apiMessage(err, 'No se pudo liquidar el efectivo.'));
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
 },
 {
 label: 'Ingreso Bruto ZIPP',
 value: money(ingresoBruto),
 sub: `${periodoLabel} · comisiones, tarifas y margen de domicilio`,
 icon: BadgePercent,
 color: 'text-[var(--color-primary)]',
 },
 {
 label: 'Gasto Promocional',
 value: `−${money(gastoPromocional)}`,
 sub: `${periodoLabel} · cupones y beneficios que paga ZIPP`,
 icon: TicketPercent,
 color: 'text-[var(--color-warning)]',
 },
 {
 label: comisionPasarela > 0 ? 'Resultado tras pasarela' : 'Resultado antes de pasarela',
 value: money(margenNeto),
 sub: `${periodoLabel} · ${comisionPasarela > 0 ? `incluye −${money(comisionPasarela)} de comisión de Wompi · ` : ''}${resultado?.incompleteReason ?? 'Falta el costo de transferencia de los pagos'}`,
 icon: Gauge,
 color: margenNeto >= 0 ? 'text-[var(--color-primary)]' : 'text-[var(--color-danger)]',
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
 label: 'Impuestos por pagar',
 value: Math.abs(cuenta('tax_payable')?.balance ?? 0),
 detalle: 'Cobrados en los pedidos (no es retención)',
 },
 {
 label: 'Efectivo en calle',
 value: efectivoPendiente,
 detalle: 'En poder de repartidores',
 },
 ];

 return (
 <div className="space-y-3 animate-fade-in">
 {/* Header */}
 <div className="page-header">
 <div>
 <h1 className="page-title">Consola Financiera ZIPP</h1>
 <p className="page-subtitle">Balance contable, comisiones, pasivos y liquidaciones de efectivo</p>
 </div>
 <div className="flex gap-1">
 {(['today', 'week', 'month'] as const).map((p) => (
 <button
 key={p}
 onClick={() => setPeriod(p)}
 className={`px-3 py-1.5 text-xs font-bold uppercase tracking-wider transition-all cursor-pointer border-b-2 ${
 period === p
 ? 'border-[var(--color-primary)] text-[var(--color-primary)]'
 : 'border-transparent text-[var(--color-text-main)] hover:text-[var(--color-text-main)]'
 }`}
 >
 {p === 'today' ? 'Hoy' : p === 'week' ? 'Semana' : 'Mes'}
 </button>
 ))}
 </div>
 </div>

 {error && (
 <p className="flex items-center gap-2 text-xs font-semibold text-[var(--color-danger)]">
 <ShieldAlert className="h-4 w-4 shrink-0" /> {error}
 </p>
 )}

 {loading ? (
 <div className="table-container p-16 text-center text-[var(--color-text-main)] text-xs font-semibold">
 Cargando balance financiero...
 </div>
 ) : (
 <>
 {/* Status Ledger Pill */}
 {ledger && (
 <div className={`flex items-center justify-between ${
 ledger.balanced ? 'text-[var(--color-primary)]' : 'text-[var(--color-danger)]'
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
 <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 pb-6 border-b border-[var(--color-border-light)]">
 {tarjetas.map((c) => (
 <div key={c.label} className="flex items-start gap-3">
 <c.icon className={`w-5 h-5 shrink-0 mt-0.5 ${c.color}`} />
 <div>
 <p className="text-[11px] font-bold text-[var(--color-text-main)] uppercase tracking-wider">{c.label}</p>
 <p className={`kpi-value text-2xl mt-1 ${c.color}`}>{c.value}</p>
 <p className="text-xs text-[var(--color-text-main)] mt-1">{c.sub}</p>
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
 <span className="text-[10px] font-mono text-[var(--color-text-main)]">COP</span>
 </div>
 <div className="divide-y divide-[var(--color-border-light)]">
 {pasivos.map((row) => (
 <div key={row.label} className="flex items-center justify-between py-2.5">
 <div>
 <p className="text-xs font-bold text-[var(--color-text-main)]">{row.label}</p>
 <p className="text-[10px] text-[var(--color-text-main)]">{row.detalle}</p>
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
 <span className="text-[10px] font-mono text-[var(--color-text-main)]">Ledger</span>
 </div>
 <div className="divide-y divide-[var(--color-border-light)] max-h-[240px] overflow-y-auto pr-1">
 {ledger?.balances
 .filter((b) => b.debit !== 0 || b.credit !== 0)
 .map((b) => (
 <div key={b.account} className="flex items-center justify-between py-2 text-xs">
 <span className="text-[var(--color-text-main)] font-medium">
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
 <div className="flex items-start justify-between gap-2.5">
 <div className="min-w-0">
 <div className="flex items-center gap-2 flex-wrap">
 <p className="text-xs font-bold text-[var(--color-text-main)]">
 Pedido #{inc.orderId?.orderNumber ?? 'N/A'}
 </p>
 <span
 className={`text-[10px] font-bold uppercase tracking-wider ${estado.clase}`}
 >
 {estado.texto}
 </span>
 {inc.resolution && (
 <span className="text-[10px] font-semibold text-[var(--color-text-main)]">
 {RESOLUCION_INCIDENCIA[inc.resolution] ?? inc.resolution}
 </span>
 )}
 </div>

 <p className="text-[10px] text-[var(--color-text-main)] mt-1">
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
 <p className="text-[11px] text-[var(--color-text-main)] mt-1.5 italic border-l-2 border-[var(--color-border)] pl-2">
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
 {canManage && decidible && !abierto && (
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
 moviendo el saldo de una persona concreta, y"resolver"
 a secas no dice en qué dirección.
 */}
 {decidible && abierto && (
 <div className="mt-2 py-2 border-t border-[var(--color-border)] space-y-2">
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
 className="px-3 py-1.5 rounded-md text-xs font-semibold text-[var(--color-text-main)] cursor-pointer hover:bg-[var(--color-bg-alt)]"
 >
 Cancelar
 </button>
 </div>

 <p className="text-[10px] text-[var(--color-text-main)]">
 A favor del domiciliario anula el saldo · Confirmar deuda lo
 mantiene · Marcar como resuelta no lo toca. Las tres quedan auditadas.
 </p>
 </div>
 )}
 </div>
 );
 })}
 </div>
 <Pagination
 page={incidentsPage} totalPages={incidentsMeta.totalPages}
 total={incidentsMeta.total} limit={incidentsMeta.limit}
 onPageChange={setIncidentsPage}
 />
 </div>
 )}

 {/* Cuentas de pago pendientes de verificar */}
 {pendingAccounts.length > 0 && (
 <div className="border-t border-[var(--color-border-light)] pt-6">
 <h3 className="text-sm font-bold text-[var(--color-text-main)]">Cuentas de pago sin verificar</h3>
 <p className="pb-3 text-xs text-[var(--color-text-main)]">
 Comercios ya aprobados con una cuenta nueva o cambiada. No se les puede liquidar hasta verificarla, en Verificar Comercios.
 </p>
 <div className="divide-y divide-[var(--color-border-light)] border-t border-[var(--color-border-light)]">
 {pendingAccounts.map((a) => (
 <div key={a.businessId} className="flex flex-wrap items-center justify-between gap-3 py-3.5 text-xs">
 <div>
 <p className="font-bold text-[var(--color-text-main)]">
 {a.businessName}
 {a.holderMatchesLegal === false && (
 <span className="ml-2 font-bold text-[var(--color-warning)]">titular no coincide</span>
 )}
 {!!a.sharedWithBusinesses && a.sharedWithBusinesses > 1 && (
 <span className="ml-2 font-bold text-[var(--color-danger)]">cuenta usada en {a.sharedWithBusinesses} comercios</span>
 )}
 </p>
 <p className="text-[var(--color-text-main)]">
 {a.method} <span className="font-mono">{a.accountMasked}</span> · titular {a.holderName}
 {a.previousLast4 ? ` · antes terminaba en ${a.previousLast4}` : ''} · {day(a.updatedAt)}
 {a.hasFreshBankCertificate === false && ' · sin certificación bancaria vigente'}
 </p>
 </div>
 <a
 href="/business-approvals"
 className="shrink-0 rounded-md border border-[var(--color-border)] px-3 py-1 text-[11px] font-semibold text-[var(--color-text-main)]"
 >
 Revisar en Verificar Comercios
 </a>
 </div>
 ))}
 </div>
 </div>
 )}

 {/* Saldos en contra de comercios */}
 {clawbacks.length > 0 && (
 <div className="border-t border-[var(--color-border-light)] pt-6">
 <h3 className="text-sm font-bold text-[var(--color-text-main)]">Saldos en contra de comercios</h3>
 <p className="pb-3 text-xs text-[var(--color-text-main)]">
 Reembolsos posteriores a la liquidación. Se descuentan solos de la siguiente liquidación; si el comercio no vuelve a vender,
 se cobra con comprobante o se da por perdido con motivo.
 </p>
 <div className="divide-y divide-[var(--color-border-light)] border-t border-[var(--color-border-light)]">
 {clawbacks.map((c) => (
 <div key={c.id} className="flex flex-wrap items-center justify-between gap-3 py-3.5">
 <div>
 <p className="text-xs font-bold text-[var(--color-text-main)]">{c.businessName ?? 'Comercio'}</p>
 <p className="font-mono text-[10px] text-[var(--color-text-main)]">
 Pedido #{c.orderNumber ?? 'N/A'} ·{' '}
 <span className={c.daysOpen > 14 ? 'font-bold text-[var(--color-danger)]' : ''}>
 {c.daysOpen} días abierto
 </span>
 </p>
 </div>
 <div className="flex items-center gap-3">
 <span className="text-xs font-bold text-[var(--color-warning)]">{money(Math.abs(c.netAmount || c.amount))}</span>
 {canManage && (<>
 <button
 onClick={() => openClawback(c, 'collect')}
 className="cursor-pointer rounded-md bg-[var(--color-primary)] px-3 py-1 text-xs font-bold uppercase tracking-wider text-white"
 >
 Cobrar
 </button>
 <button
 onClick={() => openClawback(c, 'write-off')}
 className="cursor-pointer rounded-md border border-[var(--color-border)] px-3 py-1 text-xs font-semibold text-[var(--color-text-main)]"
 >
 Dar por perdido
 </button>
 </>)}
 </div>
 </div>
 ))}
 </div>
 </div>
 )}

 {/* Cash settlement table */}
 <div className="border-t border-[var(--color-border-light)] pt-6">
 <div className="flex flex-wrap items-end justify-between gap-3 pb-3">
 <div>
 <h3 className="text-sm font-bold text-[var(--color-text-main)]">Conciliación de efectivo por domiciliario</h3>
 <p className="text-xs text-[var(--color-text-main)]">
 Verificar exige la referencia de la consignación, el comprobante y que el monto consignado coincida
 </p>
 </div>
 <div className="flex flex-wrap gap-1.5">
 {Object.entries(ESTADO_EFECTIVO).map(([status, estado]) => (
 <button
 key={status}
 onClick={() => { setCashStatus(status); setCashPage(1); }}
 className={`px-3 py-1.5 text-xs font-semibold whitespace-nowrap cursor-pointer border-b-2 ${
 cashStatus === status
 ? 'border-[var(--color-primary)] text-[var(--color-primary)] font-bold'
 : 'border-transparent text-[var(--color-text-main)] hover:text-[var(--color-text-main)]'
 }`}
 >
 {estado.texto} ({cashTotals[status]?.count ?? 0})
 </button>
 ))}
 </div>
 </div>

 <div className="divide-y divide-[var(--color-border-light)] border-t border-[var(--color-border-light)]">
 {cash.map((row) => {
 const estado = ESTADO_EFECTIVO[row.status] ?? ESTADO_EFECTIVO.pending;
 return (
 <div key={row._id} className="flex items-center justify-between py-3.5 hover:bg-[var(--color-bg)] transition-colors">
 <div>
 <p className="text-xs font-bold text-[var(--color-text-main)]">{row.driverId?.userId?.name || 'Domiciliario'}</p>
 <p className="text-[10px] text-[var(--color-text-main)] font-mono">
 Pedido #{row.orderId?.orderNumber ?? 'N/A'} • <span className={`font-semibold ${estado.clase}`}>{estado.texto}</span>
 </p>
 </div>

 <div className="flex items-center gap-3">
 <span className="text-xs font-bold text-[var(--color-warning)]">{money(row.amount)}</span>
 {canManage && (row.status === 'verified' ? (
 <button
 onClick={() => liquidar([row._id])}
 className="px-3 py-1 rounded-md text-xs font-bold bg-[var(--color-primary)] text-white uppercase tracking-wider hover:bg-[#8A5D08] cursor-pointer shadow-xs"
 >
 Liquidar
 </button>
 ) : row.status !== 'settled' ? (
 <button
 onClick={() => {
 setVerifying(row);
 setVerifyForm({ reference: '', receiptUrl: '' });
 setVerifyError('');
 }}
 className="px-3 py-1 rounded-md text-xs font-bold bg-[var(--color-primary)] text-white uppercase tracking-wider hover:bg-[#8A5D08] cursor-pointer shadow-xs"
 >
 Verificar
 </button>
 ) : null)}
 </div>
 </div>
 );
 })}

 {cash.length === 0 && (
 <div className="p-10 text-center text-[var(--color-text-main)] text-xs font-medium">
 No hay efectivo en este estado.
 </div>
 )}
 </div>
 <Pagination
 page={cashPage} totalPages={cashMeta.totalPages}
 total={cashMeta.total} limit={cashMeta.limit}
 onPageChange={setCashPage}
 />
 </div>
 </>
 )}

 {clawbackAction && (
 <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-xs animate-fade-in">
 <div className="zipp-modal w-full max-w-sm space-y-3 rounded-2xl p-6">
 <div className="flex items-start justify-between gap-3">
 <div>
 <h3 className="text-base font-bold text-[var(--color-text-main)]">
 {clawbackAction.kind === 'collect' ? 'Cobrar saldo en contra' : 'Dar por perdido'}
 </h3>
 <p className="text-xs text-[var(--color-text-main)]">
 {clawbackAction.item.businessName ?? 'Comercio'} · {money(Math.abs(clawbackAction.item.netAmount || clawbackAction.item.amount))}
 </p>
 </div>
 <button onClick={() => setClawbackAction(null)} aria-label="Cerrar" className="cursor-pointer p-1 text-[var(--color-text-main)]">
 <X className="h-4 w-4" />
 </button>
 </div>
 {clawbackAction.kind === 'collect' ? (
 <>
 <label className="block space-y-1">
 <span className="text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-main)]">Referencia del pago</span>
 <input
 value={clawbackForm.reference}
 onChange={(e) => setClawbackForm((f) => ({ ...f, reference: e.target.value }))}
 maxLength={120}
 className="h-10 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 text-xs outline-none focus:border-[var(--color-primary)]"
 />
 </label>
 <label className="block space-y-1">
 <span className="text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-main)]">Enlace del comprobante</span>
 <input
 value={clawbackForm.receiptUrl}
 onChange={(e) => setClawbackForm((f) => ({ ...f, receiptUrl: e.target.value }))}
 placeholder="https://..."
 className="h-10 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 text-xs outline-none focus:border-[var(--color-primary)]"
 />
 </label>
 </>
 ) : (
 <label className="block space-y-1">
 <span className="text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-main)]">Motivo (queda en el libro)</span>
 <textarea
 value={clawbackForm.reason}
 onChange={(e) => setClawbackForm((f) => ({ ...f, reason: e.target.value }))}
 rows={2}
 maxLength={500}
 placeholder="Ej. el comercio cerró y no responde desde hace 60 días"
 className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-xs outline-none focus:border-[var(--color-primary)]"
 />
 </label>
 )}
 {clawbackError && <p className="text-xs font-semibold text-[var(--color-danger)]">{clawbackError}</p>}
 <button
 onClick={runClawback}
 className={`h-10 w-full cursor-pointer rounded-lg text-xs font-bold uppercase tracking-wider text-white ${
 clawbackAction.kind === 'collect' ? 'bg-[var(--color-primary)]' : 'bg-[var(--color-danger)]'
 }`}
 >
 {clawbackAction.kind === 'collect' ? 'Registrar cobro' : 'Registrar pérdida'}
 </button>
 </div>
 </div>
 )}

 {verifying && (
 <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4 animate-fade-in">
 <div className="zipp-modal w-full max-w-sm rounded-2xl p-6 space-y-3">
 <div className="flex items-start justify-between gap-3">
 <div>
 <h3 className="text-base font-bold text-[var(--color-text-main)]">Verificar efectivo</h3>
 <p className="text-xs text-[var(--color-text-main)]">
 {verifying.driverId?.userId?.name ?? 'Domiciliario'} · {money(verifying.amount)} · pedido #{verifying.orderId?.orderNumber ?? 'N/A'}
 </p>
 </div>
 <button onClick={() => setVerifying(null)} aria-label="Cerrar" className="p-1 text-[var(--color-text-main)] cursor-pointer">
 <X className="w-4 h-4" />
 </button>
 </div>
 <label className="block space-y-1">
 <span className="text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-main)]">Referencia de la consignación</span>
 <input
 value={verifyForm.reference}
 onChange={(e) => setVerifyForm((f) => ({ ...f, reference: e.target.value }))}
 maxLength={120}
 placeholder="Ej. Nequi 123456789"
 className="w-full h-10 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] px-3 text-xs outline-none focus:border-[var(--color-primary)]"
 />
 </label>
 <label className="block space-y-1">
 <span className="text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-main)]">Enlace del comprobante</span>
 <input
 value={verifyForm.receiptUrl}
 onChange={(e) => setVerifyForm((f) => ({ ...f, receiptUrl: e.target.value }))}
 placeholder="https://..."
 className="w-full h-10 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] px-3 text-xs outline-none focus:border-[var(--color-primary)]"
 />
 </label>
 <p className="text-[11px] text-[var(--color-text-main)]">
 Monto que debe coincidir con la consignación: <strong className="text-[var(--color-text-main)]">{money(verifying.amount)}</strong>. Si no coincide, el servidor lo rechaza.
 </p>
 {verifyError && <p className="text-xs font-semibold text-[var(--color-danger)]">{verifyError}</p>}
 <button
 onClick={verificar}
 className="w-full h-10 bg-[var(--color-primary)] hover:bg-[#8A5D08] text-white font-bold text-xs uppercase tracking-wider rounded-lg cursor-pointer"
 >
 Verificar
 </button>
 </div>
 </div>
 )}
 </div>
 );
}

