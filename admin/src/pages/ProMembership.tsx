import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, RotateCw } from 'lucide-react';
import api from '../services/api';
import { apiMessage } from '../lib/apiError';

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

 useEffect(() => { load(); }, [load]);

 return (
 <div className="space-y-6 animate-fade-in">
 <div className="page-header">
 <div>
 <h1 className="page-title">Zipp Pro</h1>
 <p className="page-subtitle">Miembros, margen del plan y renovaciones que fallan.</p>
 </div>
 <button
 onClick={load}
 className="flex cursor-pointer items-center gap-2 rounded-lg border border-[var(--color-border)] px-4 py-2 text-xs font-semibold text-[var(--color-text-main)]"
 >
 <RotateCw className="h-4 w-4 text-[var(--color-primary)]" /> Actualizar
 </button>
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

 <div className="flex flex-wrap gap-x-8 gap-y-3 border-b border-[var(--color-border-light)] pb-4">
 {[
 ['Miembros vigentes', data.members.active],
 ['Se renuevan', data.members.renewing],
 ['Cancelaron, aún vigentes', data.members.cancelledStillValid],
 ['Vencidos', data.members.expired],
 ['Ingreso mensual bruto', cop(data.monthlyRecurringGross)],
 ].map(([label, value]) => (
 <div key={label as string}>
 <p className="text-2xl font-bold text-[var(--color-text-main)]">{value}</p>
 <p className="text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-main)]">{label}</p>
 </div>
 ))}
 </div>

 <div>
 <h2 className="mb-2 text-sm font-bold text-[var(--color-text-main)]">Últimos 30 días</h2>
 <dl className="text-sm">
 {[
 ['Cobrado en membresías', `${cop(data.last30Days.collected)} · ${data.last30Days.payments} ${data.last30Days.payments === 1 ? 'cobro' : 'cobros'}`],
 ['Comisión estimada de Wompi', `− ${cop(data.last30Days.gatewayFee)}`],
 ['Envíos que regaló la membresía', `− ${cop(data.last30Days.benefitsCost.delivery)}`],
 ['Tarifas de servicio perdonadas', `− ${cop(data.last30Days.benefitsCost.serviceFee)}`],
 ].map(([label, value]) => (
 <div key={label} className="flex justify-between gap-6 border-b border-[var(--color-border-light)] py-2">
 <dt className="text-[var(--color-text-main)]">{label}</dt>
 <dd className="font-semibold text-[var(--color-text-main)]">{value}</dd>
 </div>
 ))}
 <div className="flex justify-between gap-6 py-2">
 <dt className="font-bold text-[var(--color-text-main)]">Margen del plan</dt>
 <dd className={`text-lg font-bold ${data.last30Days.margin < 0 ? 'text-[var(--color-danger)]' : 'text-[var(--color-text-main)]'}`}>
 {data.last30Days.margin < 0 ? `− ${cop(-data.last30Days.margin)}` : cop(data.last30Days.margin)}
 </dd>
 </div>
 </dl>
 <p className="mt-1 text-xs text-[var(--color-text-main)]">
 Beneficios usados en {data.last30Days.benefitsCost.orders} {data.last30Days.benefitsCost.orders === 1 ? 'pedido entregado' : 'pedidos entregados'}.
 La comisión es la estimada con la tarifa de Tarifas y Precios; la real sale del reporte de Wompi.
 </p>
 {!data.last30Days.complete && (
 <p className="mt-2 text-xs text-[var(--color-warning)]">
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
 <ul>
 {data.atRisk.map((a, i) => (
 <li key={i} className="flex flex-wrap items-center gap-x-6 border-b border-[var(--color-border-light)] py-2 text-sm">
 <span className="flex-1 font-semibold text-[var(--color-text-main)]">{a.name}</span>
 <span className="text-xs text-[var(--color-danger)]">{a.renewalFailures} {a.renewalFailures === 1 ? 'rechazo' : 'rechazos'} seguidos</span>
 <span className="text-xs text-[var(--color-text-main)]">vigente hasta {day(a.validUntil)}</span>
 </li>
 ))}
 </ul>
 </div>
 )}

 <div>
 <h2 className="mb-2 text-sm font-bold text-[var(--color-text-main)]">Últimas suscripciones</h2>
 {data.recent.length === 0 ? (
 <p className="py-8 text-center text-xs font-semibold text-[var(--color-text-main)]">Nadie se ha suscrito todavía.</p>
 ) : (
 <ul>
 {data.recent.map((r, i) => (
 <li key={i} className="flex flex-wrap items-center gap-x-6 border-b border-[var(--color-border-light)] py-2 text-sm">
 <span className="flex-1 font-semibold text-[var(--color-text-main)]">{r.name}</span>
 <span className="text-xs text-[var(--color-text-main)]">{STATUS_LABEL[r.status] ?? r.status}</span>
 <span className="text-xs text-[var(--color-text-main)]">{cop(r.price)} · desde {day(r.since)} · hasta {day(r.validUntil)}</span>
 </li>
 ))}
 </ul>
 )}
 </div>
 </>
 )}
 </div>
 );
}
