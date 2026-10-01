import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X, AlertTriangle, UserPlus, UserMinus, RefreshCw, Ban, RotateCcw, BellRing } from 'lucide-react';
import api from '../../services/api';
import { apiErrorCode, apiMessage } from '../../lib/apiError';
import { dateTime, money } from '../../lib/drivers';
import type {
 CodeStatusView,
 NotifyAudience,
 NotifyTemplate,
 OrderMoneySummary,
 OrderProfile360Data,
} from '../../lib/fichaTypes';
import ConfirmDialog from '../ConfirmDialog';
import EntityLink from '../EntityLink';
import InternalNotes from '../InternalNotes';
import RefundPanel from '../RefundPanel';
import {
 ErrorLine,
 Facts,
 Grid,
 Sub,
 actionButtonClass,
 fieldLabelClass,
 inputClass,
 primaryButtonClass,
 secondaryButtonClass,
} from './ui';

/**
 * Ficha del pedido: todo lo que se sabe de un pedido en un solo panel.
 *
 * Reúne partes, línea de tiempo, despacho, traspaso, dinero y lo que pasó
 * después, y deja actuar desde ahí. Cada acción solo aparece si el servidor la
 * marca en `allowedActions`; lo que no se puede ver llega `null` o enmascarado
 * y aquí no se muestra. Los códigos de traspaso nunca viajan: solo su estado.
 */

const statusLabels: Record<string, { label: string; text: string }> = {
 pending: { label: 'Pendiente', text: 'text-[#B45309]' },
 accepted: { label: 'Aceptado', text: 'text-[var(--color-chart-purple)]' },
 preparing: { label: 'Preparando', text: 'text-[#B45309]' },
 ready: { label: 'Listo', text: 'text-[var(--color-chart-purple)]' },
 picked_up: { label: 'En camino', text: 'text-[#8A5D08]' },
 on_way: { label: 'En camino', text: 'text-[#8A5D08]' },
 delivered: { label: 'Entregado', text: 'text-[#047857]' },
 cancelled: { label: 'Cancelado', text: 'text-[var(--color-danger)]' },
};

const paymentMethodLabels: Record<string, string> = {
 online: 'Pago en línea',
 cash_on_delivery: 'Efectivo',
 cash: 'Efectivo',
};

const railLabels: Record<string, string> = {
 CARD: 'Tarjeta',
 NEQUI: 'Nequi',
 PSE: 'PSE',
 BANCOLOMBIA_TRANSFER: 'Bancolombia',
 BANCOLOMBIA_COLLECT: 'Bancolombia',
 DAVIPLATA: 'DaviPlata',
};
const railLabel = (raw?: string | null) => (raw ? railLabels[raw.toUpperCase()] ?? raw : '');

/** El mismo estado se lee distinto según se cobre en la puerta o por la pasarela. */
const cashStatusLabels: Record<string, string> = {
 pending_cash: 'Pendiente de cobro',
 cash_received: 'Cobrado por el domiciliario',
 paid: 'Confirmado',
 cash_not_received: 'Efectivo NO recibido',
 failed: 'Cancelado sin cobrar',
 refunded: 'Reembolsado',
};
const onlineStatusLabels: Record<string, string> = {
 pending: 'Pendiente',
 paid: 'Pagado',
 failed: 'Fallido',
 refunded: 'Reembolsado',
};
const paymentStateLabel = (method: string | undefined, status: string | undefined) => {
 const s = status ?? '';
 return (method === 'cash_on_delivery' || method === 'cash' ? cashStatusLabels : onlineStatusLabels)[s] ?? s;
};

const feeSourceNote: Record<string, string> = {
 ledger: '',
 estimate: ' (estimado con la tarifa vigente)',
 unconfigured: ' (tarifa de Wompi sin configurar)',
};

const outcomeLabels: Record<string, string> = {
 pending: 'Esperando respuesta',
 accepted: 'Aceptó',
 declined: 'Rechazó',
 expired: 'No respondió',
 taken_by_other: 'Lo tomó otro',
};

const offerReasonLabels: Record<string, string> = {
 too_far: 'muy lejos',
 busy: 'ocupado',
 low_pay: 'poca paga',
 other: 'otro',
};

const codeStatusLabels: Record<string, string> = {
 pending: 'Sin usar',
 used: 'Verificado',
 expired: 'Vencido',
 blocked: 'Bloqueado por intentos',
 void: 'Anulado',
};

const cancellationCodes: Array<{ value: string; label: string }> = [
 { value: 'client_changed_mind', label: 'El cliente cambió de opinión' },
 { value: 'client_ordered_by_mistake', label: 'El cliente pidió por error' },
 { value: 'client_too_slow', label: 'El cliente esperó demasiado' },
 { value: 'client_wrong_address', label: 'Dirección equivocada del cliente' },
 { value: 'client_unreachable', label: 'Cliente ilocalizable' },
 { value: 'business_out_of_stock', label: 'Comercio sin existencias' },
 { value: 'business_closed', label: 'Comercio cerrado' },
 { value: 'business_too_busy', label: 'Comercio saturado' },
 { value: 'no_driver_available', label: 'Sin domiciliario disponible' },
 { value: 'driver_incident', label: 'Incidente del domiciliario' },
 { value: 'payment_failed', label: 'Pago fallido' },
 { value: 'suspected_fraud', label: 'Sospecha de fraude' },
 { value: 'other', label: 'Otro (exige motivo)' },
];
const cancellationLabel = (code?: string | null) =>
 cancellationCodes.find((c) => c.value === code)?.label ?? code ?? '';

const audienceLabels: Record<NotifyAudience, string> = {
 client: 'Cliente',
 business: 'Comercio',
 driver: 'Domiciliario',
};

const templateLabels: Record<NotifyTemplate, string> = {
 status: 'Estado del pedido',
 driver_assigned: 'Domiciliario asignado',
 delayed: 'El pedido se demora',
};

interface Candidate {
 driverId: string;
 name: string;
 etaSeconds: number;
 roadMeters: number;
}

type Panel = 'assign' | 'cancel' | 'refund' | 'notify' | null;

function codeSummary(code: CodeStatusView | null): string {
 if (!code) return 'Sin código';
 const parts = [codeStatusLabels[code.status] ?? code.status];
 if (code.attempts > 0) parts.push(`${code.attempts} intento${code.attempts === 1 ? '' : 's'}`);
 if (code.usedAt) parts.push(dateTime(code.usedAt));
 else if (code.lockedUntil) parts.push(`bloqueado hasta ${dateTime(code.lockedUntil)}`);
 return parts.join(' · ');
}

interface HandoffPhoto {
 id: string;
 type: 'pickup_evidence' | 'delivery_evidence';
 url: string;
 uploadedAt: string;
}

/**
 * Fotos de recogida y entrega del pedido. Las URLs llegan firmadas del
 * servidor en el momento de abrir la ficha; aquí no se guardan. Se piden
 * aparte de la ficha porque son lo único pesado del traspaso.
 */
function HandoffPhotos({ orderId, count }: { orderId: string; count: number }) {
 const [open, setOpen] = useState(false);
 const [photos, setPhotos] = useState<HandoffPhoto[] | null>(null);
 const [failed, setFailed] = useState(false);
 const [preview, setPreview] = useState<string | null>(null);

 useEffect(() => {
 if (!open || photos !== null) return;
 let alive = true;
 api
 .get(`/admin/orders/${orderId}/security`)
 .then(({ data }) => alive && setPhotos(data.data.evidences ?? []))
 .catch(() => alive && setFailed(true));
 return () => {
 alive = false;
 };
 }, [open, orderId, photos]);

 return (
 <Sub title="Evidencias" empty="Sin fotos de recogida ni entrega.">
 {count === 0 ? undefined : (
 <>
 <button type="button" onClick={() => setOpen(true)} className={actionButtonClass}>
 Ver evidencias ({count})
 </button>
 {open &&
 createPortal(
 <div
 className="fixed inset-0 z-[80] flex items-center justify-center bg-black/70 p-4"
 onClick={() => setOpen(false)}
 >
 <div
 className="max-h-full w-full max-w-2xl overflow-y-auto bg-[var(--color-bg)] p-6"
 onClick={(e) => e.stopPropagation()}
 >
 <div className="mb-4 flex items-center justify-between">
 <h3 className="text-sm font-bold text-[var(--color-text-main)]">Evidencias</h3>
 <button type="button" onClick={() => setOpen(false)} className={actionButtonClass}>
 Cerrar
 </button>
 </div>
 {failed ? (
 <ErrorLine>No se pudieron cargar las fotos.</ErrorLine>
 ) : photos === null ? (
 <p className="text-[var(--color-text-main)]">Cargando fotos…</p>
 ) : (
 <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
 {photos.map((ev) => (
 <button key={ev.id} onClick={() => setPreview(ev.url)} className="cursor-zoom-in text-left">
 <img src={ev.url} alt="" loading="lazy" decoding="async" className="h-32 w-full rounded-lg object-cover" />
 <p className="mt-1 text-[10px] font-semibold text-[var(--color-text-main)]">
 {ev.type === 'pickup_evidence' ? 'Recogida' : 'Entrega'} · {dateTime(ev.uploadedAt)}
 </p>
 </button>
 ))}
 </div>
 )}
 </div>
 </div>,
 document.body,
 )}
 {preview &&
 createPortal(
 <div
 className="fixed inset-0 z-[90] flex cursor-zoom-out items-center justify-center bg-black/70 p-4"
 onClick={() => setPreview(null)}
 >
 <img src={preview} alt="Evidencia" className="max-h-full max-w-full rounded-xl" />
 </div>,
 document.body,
 )}
 </>
 )}
 </Sub>
 );
}

const noFeeReason = (status?: string) =>
 status === 'failed' ? 'el cobro falló' : status === 'refunded' ? 'cobro reembolsado' : 'el cobro aún no se ha capturado';

const refundPolicyLabel = (bps?: number | null) =>
 bps == null
 ? 'Sin definir: falta confirmar con Wompi'
 : bps === 0
 ? 'No reembolsable'
 : bps === 10000
 ? 'Reembolsable'
 : `Parcial: ${bps / 100}% reembolsable`;

interface PaymentRef {
 paymentId: string;
 method: string;
 status: string;
 transactionId: string | null;
 reference: string | null;
 paymentMethodType: string | null;
 createdAt: string;
}

/** ID de transacción y referencia: solo para auditoría y conciliación, aparte del resumen. */
function PaymentRefs({ orderId }: { orderId: string }) {
 const [refs, setRefs] = useState<PaymentRef[] | null>(null);
 const [failed, setFailed] = useState(false);

 useEffect(() => {
 let alive = true;
 api
 .get(`/admin/orders/${orderId}/payment-refs`)
 .then(({ data }) => alive && setRefs(data.data ?? []))
 .catch(() => alive && setFailed(true));
 return () => {
 alive = false;
 };
 }, [orderId]);

 if (failed) return <ErrorLine>No se pudieron cargar las referencias de pago.</ErrorLine>;
 return (
 <Grid
 title="Referencias de pago (auditoría)"
 head={['Fecha', 'Intento', 'ID de transacción', 'Referencia']}
 empty={refs === null ? 'Cargando…' : 'Sin referencias.'}
 rows={(refs ?? []).map((r) => [
 dateTime(r.createdAt),
 `${railLabel(r.paymentMethodType) || (r.method === 'cash_on_delivery' ? 'Efectivo' : 'En línea')} · ${paymentStateLabel(r.method, r.status)}`,
 <span className="font-mono text-[11px]">{r.transactionId ?? '—'}</span>,
 <span className="font-mono text-[11px]">{r.reference ?? '—'}</span>,
 ])}
 />
 );
}

/**
 * Filas del resumen interno de ZIPP. No es lo que pagó el cliente: aquí se ve
 * a dónde fue el dinero y cuánto queda. Todas las cifras las arma el servidor
 * según el método de pago real; esta función solo las presenta.
 */
function financialSummaryRows(summary: OrderMoneySummary, masked: boolean): Array<[string, ReactNode]> {
 const s = summary;
 const rows: Array<[string, string]> = [];
 const add = (label: string, value: number | null | undefined, negative = false) => {
 if (value == null) return;
 rows.push([label, `${negative && value > 0 ? '-' : ''}${money(value)}`]);
 };
 add(s.collected ? 'Total cobrado al cliente' : 'Total del pedido (aún sin cobrar)', s.customerTotal);
 if (!masked) add('Comisión ZIPP (al comercio)', s.merchantCommission);
 add('Pago al domiciliario', s.driverPayout);
 add(
 s.kind === 'cash' ? 'Costo de procesamiento de pago' : 'Costo de procesamiento Wompi',
 s.gatewayFee,
 true,
 );
 if (!masked) {
 add('Neto para el comercio', s.merchantNet);
 add('Ingreso bruto de ZIPP', s.platformGross);
 if (s.platformResult != null) add('Resultado neto de ZIPP', s.platformResult);
 }
 return [
 ...rows,
 ...(!masked && s.platformResult == null
 ? ([['Resultado neto de ZIPP', 'Sin asientos en el libro todavía']] as Array<[string, string]>)
 : []),
 ...(s.gatewayFeeApplies && s.paymentStatus === 'refunded'
 ? ([['Comisión Wompi en el reembolso', refundPolicyLabel(s.gatewayFeeRefundBps)]] as Array<[string, string]>)
 : []),
 ...(s.kind === 'online' && !s.gatewayFeeApplies
 ? ([['Nota', `Sin costo Wompi: ${noFeeReason(s.paymentStatus)}`]] as Array<[string, string]>)
 : []),
 ];
}

export default function OrderProfile360({
 orderId,
 onClose,
}: {
 orderId: string;
 onClose: () => void;
}) {
 const [data, setData] = useState<OrderProfile360Data | null>(null);
 const [error, setError] = useState('');
 const [notice, setNotice] = useState('');
 const [warning, setWarning] = useState('');
 const [actionError, setActionError] = useState('');
 const [panel, setPanel] = useState<Panel>(null);
 const [working, setWorking] = useState(false);

 // Asignar
 const [candidates, setCandidates] = useState<Candidate[] | null>(null);
 const [candidatesError, setCandidatesError] = useState('');

 // Desasignar / reasignar
 const [unassignMode, setUnassignMode] = useState<'release' | 'redispatch' | null>(null);

 // Cancelar
 const [cancelCode, setCancelCode] = useState('');
 const [cancelReason, setCancelReason] = useState('');
 const [cancelFormError, setCancelFormError] = useState('');
 const [confirmCancel, setConfirmCancel] = useState(false);

 // Reenviar aviso
 const [audience, setAudience] = useState<NotifyAudience>('client');
 const [template, setTemplate] = useState<NotifyTemplate>('status');

 const load = useCallback(async () => {
 try {
 const res = await api.get(`/admin/orders/${orderId}/profile-360`);
 setData(res.data.data);
 setError('');
 } catch (err) {
 setError(apiMessage(err, 'No se pudo cargar la ficha del pedido.'));
 }
 }, [orderId]);

 useEffect(() => {
 setData(null);
 setPanel(null);
 setNotice('');
 setWarning('');
 setActionError('');
 void load();
 }, [load]);

 const closePanel = () => {
 setPanel(null);
 setCandidates(null);
 setCandidatesError('');
 setCancelFormError('');
 };

 const run = async (fn: () => Promise<unknown>, done: string, fallback: string) => {
 try {
 setWorking(true);
 setActionError('');
 setNotice('');
 setWarning('');
 const res = (await fn()) as { data?: { message?: string } } | undefined;
 setNotice(done);
 // Cancelar un pedido pagado puede salir bien y fallar la reversión del cobro.
 const message = res?.data?.message;
 if (message && /pendiente para Finanzas/i.test(message)) setWarning(message);
 closePanel();
 await load();
 } catch (err) {
 const code = apiErrorCode(err);
 const text = apiMessage(err, fallback);
 if (code === 'DRIVER_PAYOUT_LOCKED') {
 setActionError(`${text} El pago del domiciliario ya está liquidado o tiene reversiones, por eso no se puede reasignar ni retirar.`);
 } else if (code === 'ERRAND_ALREADY_PURCHASED') {
 setActionError(`${text} El domiciliario ya compró el mandado, por eso no se puede reasignar ni retirar.`);
 } else if (code === 'REFUND_PERMISSION_REQUIRED') {
 setActionError('Este pedido ya está pagado y en preparación: cancelarlo devuelve el dinero al cliente y solo Finanzas puede hacerlo.');
 } else {
 setActionError(text);
 }
 } finally {
 setWorking(false);
 }
 };

 const openAssign = async () => {
 setPanel('assign');
 setCandidates(null);
 setCandidatesError('');
 try {
 const res = await api.get('/tracking/nearest', { params: { orderId } });
 setCandidates((res.data.data ?? []) as Candidate[]);
 } catch (err) {
 setCandidatesError(apiMessage(err, 'No se pudo consultar a los domiciliarios cercanos.'));
 }
 };

 const assign = (driverId: string) =>
 run(
 () => api.patch(`/orders/${orderId}/assign-driver`, { driverId }),
 'Domiciliario asignado.',
 'No se pudo asignar el domiciliario.',
 );

 const unassign = (reason: string | undefined, redispatch: boolean) =>
 run(
 () => api.post(`/admin/orders/${orderId}/unassign-driver`, { reason, redispatch }),
 redispatch ? 'Domiciliario retirado. Se busca otro.' : 'Domiciliario retirado.',
 'No se pudo retirar al domiciliario.',
 );

 const requestCancel = () => {
 if (!cancelCode) {
 setCancelFormError('Elige el motivo de la cancelación.');
 return;
 }
 if (cancelCode === 'other' && cancelReason.trim().length < 10) {
 setCancelFormError('Con"Otro" escribe el motivo (mínimo 10 caracteres).');
 return;
 }
 setCancelFormError('');
 setConfirmCancel(true);
 };

 const cancelOrder = () => {
 setConfirmCancel(false);
 void run(
 () =>
 api.patch(`/orders/${orderId}/status`, {
 status: 'cancelled',
 cancellationCode: cancelCode,
 ...(cancelReason.trim() ? { cancellationReason: cancelReason.trim() } : {}),
 }),
 'Pedido cancelado.',
 'No se pudo cancelar el pedido.',
 );
 };

 const notify = () =>
 run(
 () => api.post(`/admin/orders/${orderId}/notify`, { audience, template }),
 'Aviso enviado.',
 'No se pudo enviar el aviso.',
 );

 const order = data?.order;
 const allowed = data?.allowedActions;
 const status = order ? statusLabels[order.status] ?? { label: order.status, text: '' } : null;
 const isPaid = order?.paymentStatus === 'paid';
 const customerTotal = order?.finance?.customerTotal;
 const paidTotal = data?.money?.payments
 .filter((p) => p.status === 'completed' || p.status === 'approved' || p.status === 'paid')
 .reduce((sum, p) => sum + p.amount, 0);
 const refundBase = customerTotal ?? paidTotal ?? 0;
 const hasDriver = Boolean(data?.parties.driver);
 const address =
 typeof order?.deliveryAddress === 'string'
 ? order.deliveryAddress
 : order?.deliveryAddress?.address;
 const finance = order?.finance;
 const money360 = data?.money ?? null;

 return (
 <>
 {/* Pantalla completa dentro del área de contenido: deja a la vista la
 cabecera (h-20) y la barra lateral (w-30, fija desde lg). */}
 <div className="fixed bottom-0 left-0 right-0 top-20 z-30 lg:left-30">
 <div className="h-full w-full overflow-y-auto bg-[var(--color-bg)] p-6 lg:p-8">
 <div className="flex items-start justify-between gap-4">
 <div className="min-w-0">
 <h2 className="truncate text-lg font-bold text-[var(--color-text-main)]">
 {order ? `Pedido ${order.orderNumber ?? order._id.slice(-8).toUpperCase()}` : 'Ficha del pedido'}
 </h2>
 {order && status && (
 <p className="flex flex-wrap items-center gap-x-3 text-[11px] font-bold uppercase tracking-wide">
 <span className={status.text}>{status.label}</span>
 <span className="text-[var(--color-text-main)]">
 {order.kind === 'errand' ? 'Mandado' : 'Domicilio'} · {dateTime(order.createdAt)}
 </span>
 </p>
 )}
 </div>
 <button
 onClick={onClose}
 aria-label="Cerrar"
 className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-[var(--color-text-main)]"
 >
 <X className="h-4 w-4" /> Volver a pedidos
 </button>
 </div>

 {error ? (
 <p className="mt-6 flex items-center gap-1.5 text-sm text-[var(--color-danger)]">
 <AlertTriangle className="h-4 w-4" /> {error}
 </p>
 ) : !data || !order || !allowed ? (
 <p className="mt-6 text-sm text-[var(--color-text-main)]">Cargando…</p>
 ) : (
 <div className="mt-3 text-xs">
 {/* Acciones: cada una solo con su bandera del servidor. */}
 <div className="space-y-3 pb-3">
 <div className="flex flex-wrap items-center gap-2.5">
 {allowed.assign && !hasDriver && (
 <button onClick={openAssign} className={actionButtonClass}>
 <UserPlus className="h-4 w-4" /> Asignar
 </button>
 )}
 {allowed.unassign && hasDriver && (
 <>
 <button onClick={() => setUnassignMode('redispatch')} className={actionButtonClass}>
 <RefreshCw className="h-4 w-4" /> Reasignar
 </button>
 <button onClick={() => setUnassignMode('release')} className={actionButtonClass}>
 <UserMinus className="h-4 w-4" /> Desasignar
 </button>
 </>
 )}
 {allowed.notify && (
 <button onClick={() => setPanel(panel === 'notify' ? null : 'notify')} className={`${actionButtonClass} !border-transparent !px-1`}>
 <BellRing className="h-4 w-4" /> Reenviar aviso
 </button>
 )}
 {allowed.refund && (
 <button onClick={() => setPanel(panel === 'refund' ? null : 'refund')} className={actionButtonClass}>
 <RotateCcw className="h-4 w-4" /> Reembolsar
 </button>
 )}
 {allowed.cancel && (
 <button
 onClick={() => setPanel(panel === 'cancel' ? null : 'cancel')}
 className={`${actionButtonClass} !border-transparent !px-1 !text-[var(--color-danger)]`}
 >
 <Ban className="h-4 w-4" /> Cancelar
 </button>
 )}
 </div>

 {notice && <p className="font-semibold text-[#047857]">{notice}</p>}
 {warning && (
 <p className="flex items-start gap-1.5 font-semibold text-[var(--color-text-main)]">
 <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {warning}
 </p>
 )}
 {actionError && <ErrorLine>{actionError}</ErrorLine>}

 {panel === 'assign' && (
 <div className="space-y-2 border-t border-[var(--color-border-light)] pt-3">
 <p className={fieldLabelClass}>Domiciliarios cercanos al comercio</p>
 {candidatesError ? (
 <ErrorLine>{candidatesError}</ErrorLine>
 ) : !candidates ? (
 <p className="text-[var(--color-text-main)]">Buscando…</p>
 ) : candidates.length === 0 ? (
 <p className="text-[var(--color-text-main)]">No hay domiciliarios disponibles cerca.</p>
 ) : (
 <ul className="divide-y divide-[var(--color-border-light)]">
 {candidates.map((c) => (
 <li key={c.driverId} className="flex items-center justify-between gap-3 py-2">
 <span className="min-w-0 text-[var(--color-text-main)]">
 <span className="font-semibold">{c.name}</span>{' '}
 <span className="text-[var(--color-text-main)]">
 · {Math.max(1, Math.round(c.etaSeconds / 60))} min ·{' '}
 {(c.roadMeters / 1000).toFixed(1)} km
 </span>
 </span>
 <button
 onClick={() => assign(c.driverId)}
 disabled={working}
 className={primaryButtonClass}
 >
 Asignar
 </button>
 </li>
 ))}
 </ul>
 )}
 <div className="flex justify-end">
 <button onClick={closePanel} className={secondaryButtonClass}>
 Cerrar
 </button>
 </div>
 </div>
 )}

 {panel === 'notify' && (
 <div className="space-y-2 border-t border-[var(--color-border-light)] pt-3">
 <div className="grid grid-cols-2 gap-3">
 <label className="block space-y-1">
 <span className={fieldLabelClass}>Avisar a</span>
 <select
 value={audience}
 onChange={(e) => setAudience(e.target.value as NotifyAudience)}
 className={inputClass}
 >
 {(Object.keys(audienceLabels) as NotifyAudience[]).map((a) => (
 <option key={a} value={a}>
 {audienceLabels[a]}
 </option>
 ))}
 </select>
 </label>
 <label className="block space-y-1">
 <span className={fieldLabelClass}>Aviso</span>
 <select
 value={template}
 onChange={(e) => setTemplate(e.target.value as NotifyTemplate)}
 className={inputClass}
 >
 {(Object.keys(templateLabels) as NotifyTemplate[]).map((t) => (
 <option key={t} value={t}>
 {templateLabels[t]}
 </option>
 ))}
 </select>
 </label>
 </div>
 <p className="text-[11px] text-[var(--color-text-main)]">
 Solo avisos fijos: no admite texto libre. Máximo 3 por pedido cada 10 minutos.
 </p>
 <div className="flex justify-end gap-2">
 <button onClick={closePanel} className={secondaryButtonClass}>
 Cancelar
 </button>
 <button onClick={notify} disabled={working} className={primaryButtonClass}>
 {working ? 'Enviando…' : 'Enviar aviso'}
 </button>
 </div>
 </div>
 )}

 {panel === 'refund' && (
 <div className="border-t border-[var(--color-border-light)]">
 <RefundPanel
 orderId={orderId}
 orderTotal={refundBase}
 onDone={() => {
 setNotice('Reembolso registrado.');
 void load();
 }}
 />
 </div>
 )}

 {panel === 'cancel' && (
 <div className="space-y-2 border-t border-[var(--color-border-light)] pt-3">
 <label className="block space-y-1">
 <span className={fieldLabelClass}>Motivo de la cancelación</span>
 <select
 value={cancelCode}
 onChange={(e) => {
 setCancelCode(e.target.value);
 setCancelFormError('');
 }}
 className={inputClass}
 >
 <option value="">Elige un motivo…</option>
 {cancellationCodes.map((c) => (
 <option key={c.value} value={c.value}>
 {c.label}
 </option>
 ))}
 </select>
 </label>
 <label className="block space-y-1">
 <span className={fieldLabelClass}>
 Detalle {cancelCode === 'other' ? '(obligatorio, mínimo 10 caracteres)' : '(opcional)'}
 </span>
 <textarea
 value={cancelReason}
 onChange={(e) => {
 setCancelReason(e.target.value);
 setCancelFormError('');
 }}
 rows={2}
 maxLength={200}
 className={inputClass}
 />
 </label>
 {isPaid && (
 <p className="font-semibold text-[var(--color-text-main)]">
 Este pedido está pagado: cancelarlo reembolsa
 {customerTotal != null ? ` ${money(customerTotal)}` : ' el total'} al cliente.
 </p>
 )}
 {cancelFormError && <ErrorLine>{cancelFormError}</ErrorLine>}
 <div className="flex justify-end gap-2">
 <button onClick={closePanel} className={secondaryButtonClass}>
 Volver
 </button>
 <button
 onClick={requestCancel}
 disabled={working}
 className="cursor-pointer rounded-lg bg-[var(--color-danger)] px-3.5 py-1.5 text-xs font-bold text-white disabled:opacity-60"
 >
 Cancelar pedido
 </button>
 </div>
 </div>
 )}
 </div>

 <div className="space-y-6 pb-8">
 <Facts
 title="Resumen"
 items={[
 ['Estado', <span className={status?.text}>{status?.label}</span>],
 ['Método de pago', paymentMethodLabels[order.paymentMethod ?? ''] ?? order.paymentMethod],
 ['Cobro', order.paymentMethod === 'cash_on_delivery' ? 'Contraentrega' : 'Por la pasarela'],
 ...(money360?.summary?.provider ? ([['Proveedor', money360.summary.provider]] as Array<[string, ReactNode]>) : []),
 ...(money360?.summary?.railRaw ? ([['Medio', railLabel(money360.summary.railRaw)]] as Array<[string, ReactNode]>) : []),
 ['Estado del pago', paymentStateLabel(order.paymentMethod, order.paymentStatus)],
 ['Creado', dateTime(order.createdAt)],
 ['Aceptado', order.acceptedAt ? dateTime(order.acceptedAt) : ''],
 ['Entregado', order.deliveredAt ? dateTime(order.deliveredAt) : ''],
 ...(order.scheduledFor ? ([['Programado para', dateTime(order.scheduledFor)]] as Array<[string, ReactNode]>) : []),
 ['Ciudad', order.city],
 ]}
 />

 <Facts
 title="Partes"
 items={[
 [
 'Cliente',
 data.parties.client ? (
 <EntityLink type="user" id={data.parties.client._id}>
 {data.parties.client.name}
 </EntityLink>
 ) : undefined,
 ],
 ['Teléfono del cliente', data.parties.client?.phoneMasked],
 [
 'Comercio',
 data.parties.business ? (
 <EntityLink type="business" id={data.parties.business._id}>
 {data.parties.business.name}
 </EntityLink>
 ) : order.kind === 'errand' ? 'Mandado, sin comercio' : undefined,
 ],
 [
 'Domiciliario',
 data.parties.driver ? (
 <EntityLink type="driver" id={data.parties.driver._id}>
 {data.parties.driver.name}
 </EntityLink>
 ) : 'Sin asignar',
 ],
 ]}
 />

 <div className="columns-1 gap-6 xl:columns-2">
 <div className="mb-6 break-inside-avoid">
 {order.kind === 'errand' && order.errand ? (
 <Grid
 title="Mandado"
 head={['Detalle', 'Valor']}
 empty="Sin detalle."
 right={[1]}
 rows={[
 ...(order.errand.description ? [['Descripción', order.errand.description]] : []),
 ...(order.errand.pickupAddress ? [['Recoger en', order.errand.pickupAddress]] : []),
 ['Costo estimado', money(order.errand.estimatedCost)],
 ['Tope', money(order.errand.maxCost)],
 ...(order.errand.actualCost != null ? [['Costo real', money(order.errand.actualCost)]] : []),
 ]}
 />
 ) : (
 <Grid
 title="Productos"
 head={['Cant.', 'Producto', 'Subtotal']}
 empty="Sin productos."
 right={[2]}
 rows={(order.items ?? []).map((item) => [
 item.quantity,
 <div key="producto" className="min-w-0 space-y-0.5">
 <p>{item.name}</p>
 {item.extras && item.extras.length > 0 && (
 <p className="text-xs text-[var(--color-text-main)]">
 {item.extras.map((e) => `${e.name}${e.quantity > 1 ? ` x${e.quantity}` : ''}`).join(', ')}
 </p>
 )}
 {item.notes && <p className="text-xs italic text-[var(--color-text-main)]">"{item.notes}"</p>}
 </div>,
 item.totalPrice != null
 ? money(item.totalPrice)
 : item.price != null
 ? money(item.price * item.quantity)
 : '',
 ])}
 />
 )}
 </div>

 <div className="mb-6 break-inside-avoid">
 <Grid
 title="Entrega"
 head={['Dato', 'Valor']}
 empty="Sin dirección."
 rows={[
 ...(address ? [['Dirección', address]] : []),
 ...(typeof order.deliveryAddress === 'object' && order.deliveryAddress?.notes
 ? [['Notas', order.deliveryAddress.notes]]
 : []),
 ...(data.masked.sensitive ? [['Aviso', 'Dirección exacta oculta: hace falta permiso de datos sensibles.']] : []),
 ...(order.status === 'cancelled'
 ? [
 [
 'Cancelación',
 `${cancellationLabel(order.cancellationCode) || 'Sin motivo registrado'}${
 order.cancelledBy ? ` · por ${order.cancelledBy}` : ''
 }${order.cancellationReason ? ` — ${order.cancellationReason}` : ''}`,
 ],
 ]
 : []),
 ]}
 />
 </div>

 <div className="mb-6 break-inside-avoid">
 <Facts
 title="Despacho y conversación"
 items={[
 ['Ronda', data.dispatch.round != null ? String(data.dispatch.round) : ''],
 ['Ciclo', data.dispatch.cycle != null ? String(data.dispatch.cycle) : ''],
 ['Oferta vigente hasta', data.dispatch.expiresAt ? dateTime(data.dispatch.expiresAt) : ''],
 ['Mensajes', String(data.conversation.messages)],
 ['Llamadas', String(data.conversation.calls)],
 ]}
 />
 </div>

 <div className="mb-6 break-inside-avoid">
 <Grid
 title="Línea de tiempo"
 head={['Cuándo', 'Evento', 'Quién']}
 empty="Sin eventos registrados."
 rows={data.timeline.map((t) => [
 dateTime(t.at),
 <span className={t.incident ? 'text-[var(--color-danger)]' : ''}>
 {t.label}
 {t.derived ? ' (deducido)' : ''}
 </span>,
 t.actor?.name ?? t.actor?.role ?? '',
 ])}
 />
 </div>

 <div className="mb-6 break-inside-avoid">
 <Grid
 title="Ofertas de despacho"
 head={['Domiciliario', 'Ronda', 'Ofrecida', 'Resultado']}
 empty="Todavía no se ofreció a ningún domiciliario."
 rows={data.dispatch.offers.map((o) => [
 <>
 <EntityLink type="driver" id={o.driverId}>
 {o.driverName ?? 'Domiciliario'}
 </EntityLink>
 {o.reason ? ` · ${offerReasonLabels[o.reason] ?? o.reason}` : ''}
 </>,
 o.round != null ? String(o.round) : '',
 o.offeredAt ? dateTime(o.offeredAt) : '',
 outcomeLabels[o.outcome] ?? o.outcome,
 ])}
 />
 </div>

 {data.handoff && (
 <div className="mb-6 break-inside-avoid">
 <Grid
 title="Códigos de traspaso"
 head={['Código', 'Estado']}
 empty="Sin códigos."
 rows={[
 ['Recogida', codeSummary(data.handoff.pickup)],
 ['Entrega', codeSummary(data.handoff.delivery)],
 ]}
 />
 </div>
 )}

 {data.handoff && (
 <div className="mb-6 min-w-0 break-inside-avoid">
 <HandoffPhotos orderId={data.order._id} count={data.handoff.evidences} />
 </div>
 )}

 <div className="mb-6 break-inside-avoid">
 {!data.money ? (
 <p className="text-xs font-semibold text-[var(--color-text-main)]">
 Pagos y resumen financiero ocultos: hace falta el permiso de finanzas.
 </p>
 ) : (
 <Grid
 title="Dinero del pedido"
 head={['Concepto', 'Importe']}
 empty="Sin movimientos de dinero."
 right={[1]}
 rows={[
 ...(finance
 ? ([
 ['Lo que pagó el cliente'] as [string],
 ...(finance.productSubtotal != null ? [['Productos', money(finance.productSubtotal)] as [string, string]] : []),
 ...(finance.deliveryCustomerFee != null
 ? [['Domicilio', money(finance.deliveryCustomerFee)] as [string, string]]
 : []),
 ...(finance.customerServiceFee != null
 ? [['Tarifa de servicio', money(finance.customerServiceFee)] as [string, string]]
 : []),
 ...(finance.tip != null && finance.tip > 0 ? [['Propina', money(finance.tip)] as [string, string]] : []),
 ...((finance.merchantFundedDiscount ?? 0) + (finance.platformFundedDiscount ?? 0) > 0
 ? [
 [
 'Descuentos',
 `-${money((finance.merchantFundedDiscount ?? 0) + (finance.platformFundedDiscount ?? 0))}`,
 ] as [string, string],
 ]
 : []),
 ...(finance.customerTotal != null ? [['Total', money(finance.customerTotal)] as [string, string]] : []),
 ] as Array<[string, ReactNode]>)
 : []),
 ...(money360?.summary
 ? ([['Resumen financiero de ZIPP'] as [string], ...financialSummaryRows(money360.summary, data.masked.commissions)] as Array<
 [string, ReactNode]
 >)
 : []),
 ['Pagos'],
 ...data.money.payments.map((p): [ReactNode, ReactNode] => {
 const cash = p.method === 'cash_on_delivery';
 const fee = p.gatewayFee;
 const lines = [
 `Método: ${cash ? 'Efectivo' : 'Pago en línea'}`,
 ...(cash ? [] : ['Proveedor: Wompi']),
 ...(!cash && p.paymentMethodType ? [`Medio: ${railLabel(p.paymentMethodType)}`] : []),
 `Estado: ${paymentStateLabel(p.method, p.status)}`,
 ...(fee
 ? [
 `Costo de procesamiento: ${money(fee.total)}${feeSourceNote[fee.source]}`,
 ...(fee.percentage != null
 ? [`· Porcentaje ${money(fee.percentage)} · Fijo ${money(fee.fixed ?? 0)} · IVA ${money(fee.vat ?? 0)}`]
 : []),
 ]
 : []),
 ...(p.netReceived != null ? [`Neto recibido: ${money(p.netReceived)}`] : []),
 ];
 return [
 <div className="space-y-0.5">
 <p className="font-semibold">{dateTime(p.createdAt)}</p>
 {lines.map((l) => (
 <div key={l}>{l}</div>
 ))}
 </div>,
 money(p.amount),
 ];
 }),
 ...(data.money.refunds && data.money.refunds.length > 0
 ? ([
 ['Reembolsos'] as [string],
 ...data.money.refunds.map(
 (r): [string, string] => [`${dateTime(r.createdAt)} · ${r.status}${r.reason ? ` — ${r.reason}` : ''}`, money(r.amount)],
 ),
 ] as Array<[string, ReactNode]>)
 : []),
 ['Pagos a comercio y domiciliario'],
 ...data.money.payouts.map((p): [string, string] => [
 `${p.beneficiary === 'business' ? 'Comercio' : p.beneficiary === 'driver' ? 'Domiciliario' : (p.beneficiary ?? 'Beneficiario')} · ${p.status}`,
 money(p.netAmount ?? p.amount),
 ]),
 ]}
 />
 )}
 </div>

 {data.money && data.money.payments.some((p) => p.method === 'online') && (
 <div className="mb-6 break-inside-avoid">
 <PaymentRefs orderId={data.order._id} />
 </div>
 )}

 <div className="mb-6 break-inside-avoid">
 <Grid
 title="Reseña"
 head={['Calificación', 'Comentario']}
 empty="Sin reseña."
 rows={
 data.after.review
 ? [[data.after.review.rating > 0 ? `${data.after.review.rating}★` : 'Sin calificación', data.after.review.comment ?? '']]
 : []
 }
 />
 </div>

 <div className="mb-6 break-inside-avoid">
 <Grid
 title="PQRS"
 head={['Asunto', 'Fecha', 'Estado']}
 empty="Sin PQRS."
 rows={data.after.pqrs.map((p) => [p.subject ?? 'PQRS', dateTime(p.createdAt), p.status])}
 />
 </div>

 {data.after.cashIncidents && (
 <div className="mb-6 break-inside-avoid">
 <Grid
 title="Incidentes de efectivo"
 head={['Fecha', 'Importe', 'Estado']}
 empty="Sin incidentes de efectivo."
 right={[1]}
 rows={data.after.cashIncidents.map((c) => [
 dateTime(c.createdAt),
 c.amount != null ? money(c.amount) : '',
 c.status,
 ])}
 />
 </div>
 )}

 {data.after.sos && (
 <div className="mb-6 break-inside-avoid">
 <Grid
 title="Alertas SOS"
 head={['Fecha', 'Nota', 'Estado']}
 empty="Sin alertas SOS."
 rows={data.after.sos.map((s) => [dateTime(s.createdAt), s.note ?? '', s.status])}
 />
 </div>
 )}
 </div>

 {allowed.note && (
 <section className="space-y-2">
 <h3 className="text-sm font-bold text-[var(--color-text-main)]">Notas internas</h3>
 <InternalNotes entityType="order" entityId={orderId} />
 </section>
 )}
 </div>
 </div>
 )}
 </div>
 </div>

 {unassignMode && (
 <ConfirmDialog
 title={unassignMode === 'redispatch' ? 'Reasignar pedido' : 'Desasignar domiciliario'}
 message={
 unassignMode === 'redispatch'
 ? 'Se retira al domiciliario actual y el sistema ofrece el pedido a otros. Si llevaba fondo o efectivo reservado, se le devuelve.'
 : 'Se retira al domiciliario actual y el pedido queda sin asignar. Si llevaba fondo o efectivo reservado, se le devuelve.'
 }
 confirmLabel={unassignMode === 'redispatch' ? 'Reasignar' : 'Desasignar'}
 variant="warning"
 reason={{ label: 'Motivo', placeholder: 'Por qué se le quita el pedido', minLength: 5 }}
 onConfirm={(reason) => {
 const redispatch = unassignMode === 'redispatch';
 setUnassignMode(null);
 void unassign(reason, redispatch);
 }}
 onCancel={() => setUnassignMode(null)}
 />
 )}

 {confirmCancel && (
 <ConfirmDialog
 title="Cancelar pedido"
 message={
 isPaid
 ? `Cancelar el pedido ${order?.orderNumber ?? ''} reembolsa${
 customerTotal != null ? ` ${money(customerTotal)}` : ' el total'
 } al cliente por la pasarela. No se puede deshacer.`
 : `¿Cancelar el pedido ${order?.orderNumber ?? ''}? No se puede deshacer.`
 }
 confirmLabel="Cancelar pedido"
 onConfirm={cancelOrder}
 onCancel={() => setConfirmCancel(false)}
 />
 )}
 </>
 );
}
