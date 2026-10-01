import { useCallback, useEffect, useState } from 'react';
import { useLiveReload } from '../hooks/useLiveReload';
import { AlertCircle } from 'lucide-react';
import api from '../services/api';
import { apiMessage } from '../lib/apiError';
import SummaryGrid from '../components/SummaryGrid';

/**
 * Zipp Pro visto desde el negocio. Solo lectura: el precio y los beneficios
 * viven en `backend/src/config/pro.ts` (TODO(negocio) pendiente), no aquí.
 */

interface Data {
 plan: {
 name: string; price: number; periodDays: number;
 freeDelivery: { enabled: boolean; minSubtotal: number };
 serviceFeeWaived: { enabled: boolean };
 };
 members: { active: number; renewing: number; cancelledStillValid: number; expired: number; pending: number };
 monthlyRecurringGross: number;
 last30Days: {
 collected: number;
 payments: number;
 gatewayFee: number;
 gatewayFeeConfigured: boolean;
 benefitsCost: { delivery: number; serviceFee: number; total: number; orders: number };
 ordersWithoutData: number;
 margin: number;
 complete: boolean;
 };
 atRisk: { name: string; renewalFailures: number; lastAttemptAt: string | null; validUntil: string | null }[];
 recent: { name: string; status: string; price: number; since: string | null; validUntil: string | null; autoRenew: boolean }[];
}

const cop = (n: number) => `$${n.toLocaleString('es-CO')}`;
const day = (d: string | null) => (d ? new Date(d).toLocaleDateString('es-CO') : '–');

const STATUS_LABEL: Record<string, string> = {
 active: 'Activa',
 cancelled: 'Cancelada (vigente)',
 expired: 'Vencida',
 pending: 'Cobro en curso',
};

export default function ProMembership() {
 const [data, setData] = useState<Data | null>(null);
 const [loading, setLoading] = useState(true);
 const [error, setError] = useState('');

 const load = useCallback(async () => {
 try {
 setLoading(true); setError('');
 const { data: res } = await api.get('/admin/growth/pro');
 setData(res.data);
 } catch (err) {
 setError(apiMessage(err, 'No se pudo cargar Zipp Pro.'));
 } finally {
 setLoading(false);
 }
 }, []);

 useLiveReload(['pro'], load);
 useEffect(() => { load(); }, [load]);

 return (
 <div className="space-y-6 animate-fade-in">
 <div className="page-header">
 <div>
 <h1 className="page-title">Zipp Pro</h1>
 <p className="page-subtitle">Miembros, margen del plan y renovaciones que fallan.</p>
 </div>
 </div>

 {error && (
 <p className="flex items-center gap-2 text-xs font-semibold text-[var(--color-danger)]">
 <AlertCircle className="h-4 w-4" /> {error}
 </p>
 )}

 {loading && !data ? (
 <p className="py-10 text-center text-xs font-semibold text-[var(--color-text-main)]">Cargando…</p>
 ) : data && (
 <>
 <p className="text-xs text-[var(--color-text-main)]">
 Plan vigente: <strong>{data.plan.name}</strong> a {cop(data.plan.price)} cada {data.plan.periodDays} días
 {data.plan.freeDelivery.enabled && ` · envío gratis desde ${cop(data.plan.freeDelivery.minSubtotal)}`}
 {data.plan.serviceFeeWaived.enabled && ' · sin tarifa de servicio'}.
 Estos valores son una propuesta de arranque: se cambian en <code>config/pro.ts</code>.
 </p>

 <SummaryGrid
 items={[
 { label: 'Miembros vigentes', value: data.members.active },
 { label: 'Se renuevan', value: data.members.renewing },
 { label: 'Cancelaron, aún vigentes', value: data.members.cancelledStillValid },
 { label: 'Vencidos', value: data.members.expired },
 { label: 'Ingreso mensual bruto', value: cop(data.monthlyRecurringGross) },
 ]}
 />

 <div>
 <h2 className="mb-2 text-sm font-bold text-[var(--color-text-main)]">Últimos 30 días</h2>
 <div className="table-container">
 <div className="overflow-x-auto">
 <table className="data-grid">
 <thead>
 <tr className="text-left">
 <th className="table-header-cell">Concepto</th>
 <th className="table-header-cell">Valor</th>
 </tr>
 </thead>
 <tbody>
 {[
 ['Cobrado en membresías', `${cop(data.last30Days.collected)} · ${data.last30Days.payments} ${data.last30Days.payments === 1 ? 'cobro' : 'cobros'}`],
 ['Comisión estimada de Wompi', `− ${cop(data.last30Days.gatewayFee)}`],
 ['Envíos que regaló la membresía', `− ${cop(data.last30Days.benefitsCost.delivery)}`],
 ['Tarifas de servicio perdonadas', `− ${cop(data.last30Days.benefitsCost.serviceFee)}`],
 ].map(([label, value]) => (
 <tr key={label}>
 <td className="table-body-cell text-[var(--color-text-main)]">{label}</td>
 <td className="table-body-cell text-[var(--color-text-main)]">{value}</td>
 </tr>
 ))}
 <tr>
 <td className="table-body-cell text-[var(--color-text-main)]">Margen del plan</td>
 <td className={`table-body-cell ${data.last30Days.margin < 0 ? 'text-[var(--color-danger)]' : 'text-[var(--color-text-main)]'}`}>
 {data.last30Days.margin < 0 ? `− ${cop(-data.last30Days.margin)}` : cop(data.last30Days.margin)}
 </td>
 </tr>
 </tbody>
 </table>
 </div>
 </div>
 <p className="mt-1 text-xs text-[var(--color-text-main)]">
 Beneficios usados en {data.last30Days.benefitsCost.orders} {data.last30Days.benefitsCost.orders === 1 ? 'pedido entregado' : 'pedidos entregados'}.
 La comisión es la estimada con la tarifa de Tarifas y Precios; la real sale del reporte de Wompi.
 </p>
 {!data.last30Days.complete && (
 <p className="mt-2 text-xs text-[var(--color-text-main)]">
 El margen sale inflado:
 {!data.last30Days.gatewayFeeConfigured && ' la tarifa de Wompi sigue en 0 (llénala en Tarifas y Precios con tu contrato)'}
 {!data.last30Days.gatewayFeeConfigured && data.last30Days.ordersWithoutData > 0 && ' y'}
 {data.last30Days.ordersWithoutData > 0 &&
 ` ${data.last30Days.ordersWithoutData} ${data.last30Days.ordersWithoutData === 1 ? 'pedido entregado es anterior' : 'pedidos entregados son anteriores'} a guardar el descuento de Pro, así que su coste no se cuenta`}
 .
 </p>
 )}
 </div>

 {data.atRisk.length > 0 && (
 <div>
 <h2 className="mb-2 text-sm font-bold text-[var(--color-text-main)]">Renovaciones que fallaron</h2>
 <div className="table-container">
 <div className="overflow-x-auto">
 <table className="data-grid">
 <thead>
 <tr className="text-left">
 <th className="table-header-cell">Cliente</th>
 <th className="table-header-cell">Rechazos seguidos</th>
 <th className="table-header-cell">Vigente hasta</th>
 </tr>
 </thead>
 <tbody>
 {data.atRisk.map((a, i) => (
 <tr key={i}>
 <td className="table-body-cell text-[var(--color-text-main)]">{a.name}</td>
 <td className="table-body-cell text-[var(--color-danger)]">{a.renewalFailures}</td>
 <td className="table-body-cell text-[var(--color-text-main)]">{day(a.validUntil)}</td>
 </tr>
 ))}
 </tbody>
 </table>
 </div>
 </div>
 </div>
 )}

 <div>
 <h2 className="mb-2 text-sm font-bold text-[var(--color-text-main)]">Últimas suscripciones</h2>
 {data.recent.length === 0 ? (
 <p className="py-8 text-center text-xs font-semibold text-[var(--color-text-main)]">Nadie se ha suscrito todavía.</p>
 ) : (
 <div className="table-container">
 <div className="overflow-x-auto">
 <table className="data-grid">
 <thead>
 <tr className="text-left">
 <th className="table-header-cell">Cliente</th>
 <th className="table-header-cell">Estado</th>
 <th className="table-header-cell">Precio</th>
 <th className="table-header-cell">Desde</th>
 <th className="table-header-cell">Hasta</th>
 </tr>
 </thead>
 <tbody>
 {data.recent.map((r, i) => (
 <tr key={i}>
 <td className="table-body-cell text-[var(--color-text-main)]">{r.name}</td>
 <td className="table-body-cell text-[var(--color-text-main)]">{STATUS_LABEL[r.status] ?? r.status}</td>
 <td className="table-body-cell text-[var(--color-text-main)]">{cop(r.price)}</td>
 <td className="table-body-cell text-[var(--color-text-main)]">{day(r.since)}</td>
 <td className="table-body-cell text-[var(--color-text-main)]">{day(r.validUntil)}</td>
 </tr>
 ))}
 </tbody>
 </table>
 </div>
 </div>
 )}
 </div>
 </>
 )}
 </div>
 );
}
