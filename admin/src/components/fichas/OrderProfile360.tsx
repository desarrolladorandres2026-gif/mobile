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

const paymentStatusLabels: Record<string, string> = {
 pending: 'Pago pendiente',
 pending_cash: 'Cobra al entregar',
 cash_received: 'Efectivo recibido',
 paid: 'Pagado',
 cash_not_received: 'Efectivo NO recibido',
 failed: 'Cobro fallido',
 refunded: 'Reembolsado',
};

const paymentMethodLabels: Record<string, string> = { online: 'En línea', cash: 'Efectivo' };

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
 const [photos, setPhotos] = useState<HandoffPhoto[] | null>(null);
 const [failed, setFailed] = useState(false);
 const [preview, setPreview] = useState<string | null>(null);

 useEffect(() => {
 if (count === 0) return;
 let alive = true;
 api
 .get(`/admin/orders/${orderId}/security`)
 .then(({ data }) => alive && setPhotos(data.data.evidences ?? []))
 .catch(() => alive && setFailed(true));
 return () => {
 alive = false;
 };
 }, [orderId, count]);

 return (
 <Sub title="Evidencias" empty="Sin fotos de recogida ni entrega.">
 {count === 0 ? undefined : failed ? (
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
 {preview &&
 createPortal(
 <div
 className="fixed inset-0 z-[80] flex cursor-zoom-out items-center justify-center bg-black/70 p-4"
 onClick={() => setPreview(null)}
 >
 <img src={preview} alt="Evidencia" className="max-h-full max-w-full rounded-xl" />
 </div>,
 document.body,
 )}
 </Sub>
 );
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
 <div className="mt-5 text-xs">
 {/* Acciones: cada una solo con su bandera del servidor. */}
 <div className="space-y-3 pb-6">
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
 <p className="flex items-start gap-1.5 font-semibold text-[var(--color-warning)]">
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
 <p className="font-semibold text-[var(--color-warning)]">
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
 ['Pago', paymentMethodLabels[order.paymentMethod ?? ''] ?? order.paymentMethod],
 ['Estado del cobro', paymentStatusLabels[order.paymentStatus ?? ''] ?? order.paymentStatus],
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

 <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
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
 item.name,
 item.price != null ? money(item.price * item.quantity) : '',
 ])}
 />
 )}

 {finance && (
 <Grid
 title="Lo que pagó el cliente"
 head={['Concepto', 'Importe']}
 empty="Sin desglose."
 right={[1]}
 rows={[
 ...(finance.productSubtotal != null ? [['Productos', money(finance.productSubtotal)]] : []),
 ...(finance.deliveryCustomerFee != null ? [['Domicilio', money(finance.deliveryCustomerFee)]] : []),
 ...(finance.customerServiceFee != null ? [['Tarifa de servicio', money(finance.customerServiceFee)]] : []),
 ...(finance.tip != null && finance.tip > 0 ? [['Propina', money(finance.tip)]] : []),
 ...((finance.merchantFundedDiscount ?? 0) + (finance.platformFundedDiscount ?? 0) > 0
 ? [['Descuentos', `-${money((finance.merchantFundedDiscount ?? 0) + (finance.platformFundedDiscount ?? 0))}`]]
 : []),
 ...(finance.customerTotal != null ? [['Total', money(finance.customerTotal)]] : []),
 ...(!data.masked.commissions && finance.merchantCommission != null
 ? [['Comisión al comercio', money(finance.merchantCommission)]]
 : []),
 ...(!data.masked.commissions && finance.platformNetRevenue != null
 ? [['Ingreso neto de ZIPP', money(finance.platformNetRevenue)]]
 : []),
 ]}
 />
 )}
 </div>

 <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
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

 <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
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
 <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
 <Grid
 title="Códigos de traspaso"
 head={['Código', 'Estado']}
 empty="Sin códigos."
 rows={[
 ['Recogida', codeSummary(data.handoff.pickup)],
 ['Entrega', codeSummary(data.handoff.delivery)],
 ]}
 />
 <div className="min-w-0">
 <HandoffPhotos orderId={data.order._id} count={data.handoff.evidences} />
 </div>
 </div>
 )}

 {data.money && (
 <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
 <Grid
 title="Pagos"
 head={['Fecha', 'Estado', 'Importe']}
 empty="Sin pagos registrados."
 right={[2]}
 rows={data.money.payments.map((p) => [
 dateTime(p.createdAt),
 `${p.status}${p.method ? ` · ${p.method}` : ''}`,
 money(p.amount),
 ])}
 />
 {data.money.refunds && (
 <Grid
 title="Reembolsos"
 head={['Fecha', 'Estado', 'Importe']}
 empty="Sin reembolsos."
 right={[2]}
 rows={data.money.refunds.map((r) => [
 dateTime(r.createdAt),
 `${r.status}${r.reason ? ` — ${r.reason}` : ''}`,
 money(r.amount),
 ])}
 />
 )}
 <Grid
 title="Pagos a comercio y domiciliario"
 head={['Beneficiario', 'Estado', 'Neto']}
 empty="Sin pagos generados."
 right={[2]}
 rows={data.money.payouts.map((p) => [
 p.beneficiary ?? 'Beneficiario',
 p.status,
 money(p.netAmount ?? p.amount),
 ])}
 />
 </div>
 )}

 <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
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
 <Grid
 title="PQRS"
 head={['Asunto', 'Fecha', 'Estado']}
 empty="Sin PQRS."
 rows={data.after.pqrs.map((p) => [p.subject ?? 'PQRS', dateTime(p.createdAt), p.status])}
 />
 {data.after.cashIncidents && (
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
 )}
 {data.after.sos && (
 <Grid
 title="Alertas SOS"
 head={['Fecha', 'Nota', 'Estado']}
 empty="Sin alertas SOS."
 rows={data.after.sos.map((s) => [dateTime(s.createdAt), s.note ?? '', s.status])}
 />
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
