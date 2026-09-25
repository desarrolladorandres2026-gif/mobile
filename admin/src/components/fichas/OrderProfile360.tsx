import { useCallback, useEffect, useState } from 'react';
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
  Fact,
  Row,
  Section,
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

function CodeState({ label, code }: { label: string; code: CodeStatusView | null }) {
  if (!code) return <Fact label={label} value="Sin código" />;
  const parts = [codeStatusLabels[code.status] ?? code.status];
  if (code.attempts > 0) parts.push(`${code.attempts} intento${code.attempts === 1 ? '' : 's'}`);
  if (code.usedAt) parts.push(dateTime(code.usedAt));
  else if (code.lockedUntil) parts.push(`bloqueado hasta ${dateTime(code.lockedUntil)}`);
  return <Fact label={label} value={parts.join(' · ')} />;
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
      setCancelFormError('Con "Otro" escribe el motivo (mínimo 10 caracteres).');
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
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={onClose}>
      <div
        className="h-full w-full max-w-2xl overflow-y-auto bg-[var(--color-surface)] p-7"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="truncate text-lg font-bold text-[var(--color-text-main)]">
              {order ? `Pedido ${order.orderNumber ?? order._id.slice(-8).toUpperCase()}` : 'Ficha del pedido'}
            </h2>
            {order && status && (
              <p className="flex flex-wrap items-center gap-x-3 text-[11px] font-bold uppercase tracking-wide">
                <span className={status.text}>{status.label}</span>
                <span className="text-[var(--color-text-muted)]">
                  {order.kind === 'errand' ? 'Mandado' : 'Domicilio'} · {dateTime(order.createdAt)}
                </span>
              </p>
            )}
          </div>
          <button
            onClick={onClose}
            aria-label="Cerrar"
            className="shrink-0 cursor-pointer rounded-lg border border-[var(--color-border)] p-1.5 text-[var(--color-text-muted)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {error ? (
          <p className="mt-6 flex items-center gap-1.5 text-sm text-[var(--color-danger)]">
            <AlertTriangle className="h-4 w-4" /> {error}
          </p>
        ) : !data || !order || !allowed ? (
          <p className="mt-6 text-sm text-[var(--color-text-muted)]">Cargando…</p>
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
                  <button onClick={() => setPanel(panel === 'notify' ? null : 'notify')} className={actionButtonClass}>
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
                    className={`${actionButtonClass} !border-[var(--color-danger)] !text-[var(--color-danger)]`}
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
                    <p className="text-[var(--color-text-muted)]">Buscando…</p>
                  ) : candidates.length === 0 ? (
                    <p className="text-[var(--color-text-muted)]">No hay domiciliarios disponibles cerca.</p>
                  ) : (
                    <ul className="divide-y divide-[var(--color-border-light)]">
                      {candidates.map((c) => (
                        <li key={c.driverId} className="flex items-center justify-between gap-3 py-2">
                          <span className="min-w-0 text-[var(--color-text-main)]">
                            <span className="font-semibold">{c.name}</span>{' '}
                            <span className="text-[var(--color-text-muted)]">
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
                  <p className="text-[11px] text-[var(--color-text-muted)]">
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

            <Section title="Resumen">
              <div className="grid grid-cols-2 gap-x-6 gap-y-4 md:grid-cols-3">
                <Fact label="Estado" value={<span className={status?.text}>{status?.label}</span>} />
                <Fact label="Pago" value={paymentMethodLabels[order.paymentMethod ?? ''] ?? order.paymentMethod} />
                <Fact
                  label="Estado del cobro"
                  value={paymentStatusLabels[order.paymentStatus ?? ''] ?? order.paymentStatus}
                />
                <Fact label="Creado" value={dateTime(order.createdAt)} />
                <Fact label="Aceptado" value={order.acceptedAt ? dateTime(order.acceptedAt) : ''} />
                <Fact label="Entregado" value={order.deliveredAt ? dateTime(order.deliveredAt) : ''} />
                {order.scheduledFor && <Fact label="Programado para" value={dateTime(order.scheduledFor)} />}
                <Fact label="Ciudad" value={order.city} />
              </div>

              {order.status === 'cancelled' && (
                <Sub title="Cancelación">
                  <p className="text-[var(--color-text-secondary)]">
                    {cancellationLabel(order.cancellationCode) || 'Sin motivo registrado'}
                    {order.cancelledBy ? ` · por ${order.cancelledBy}` : ''}
                    {order.cancellationReason ? ` — ${order.cancellationReason}` : ''}
                  </p>
                </Sub>
              )}

              <Sub title="Dirección de entrega" empty="Sin dirección.">
                {address ? (
                  <div className="space-y-0.5 text-[var(--color-text-secondary)]">
                    <p>{address}</p>
                    {typeof order.deliveryAddress === 'object' && order.deliveryAddress?.notes && (
                      <p className="text-[var(--color-text-muted)]">{order.deliveryAddress.notes}</p>
                    )}
                    {data.masked.sensitive && (
                      <p className="text-[var(--color-text-muted)]">
                        Dirección exacta oculta: hace falta permiso de datos sensibles.
                      </p>
                    )}
                  </div>
                ) : undefined}
              </Sub>

              {order.kind === 'errand' && order.errand ? (
                <Sub title="Mandado">
                  <div className="space-y-0.5 text-[var(--color-text-secondary)]">
                    {order.errand.description && <p>{order.errand.description}</p>}
                    {order.errand.pickupAddress && <p>Recoger en {order.errand.pickupAddress}</p>}
                    <p>
                      Estimado {money(order.errand.estimatedCost)} · tope {money(order.errand.maxCost)}
                      {order.errand.actualCost != null ? ` · real ${money(order.errand.actualCost)}` : ''}
                    </p>
                  </div>
                </Sub>
              ) : (
                <Sub title="Productos" empty="Sin productos.">
                  {order.items?.length ? (
                    <ul className="space-y-1.5">
                      {order.items.map((item, i) => (
                        <Row
                          key={`${item.name}-${i}`}
                          left={`${item.quantity} × ${item.name}`}
                          right={item.price != null ? money(item.price * item.quantity) : undefined}
                        />
                      ))}
                    </ul>
                  ) : undefined}
                </Sub>
              )}

              {finance && (
                <Sub title="Lo que pagó el cliente">
                  <ul className="space-y-1.5">
                    {finance.productSubtotal != null && <Row left="Productos" right={money(finance.productSubtotal)} />}
                    {finance.deliveryCustomerFee != null && <Row left="Domicilio" right={money(finance.deliveryCustomerFee)} />}
                    {finance.customerServiceFee != null && <Row left="Tarifa de servicio" right={money(finance.customerServiceFee)} />}
                    {finance.tip != null && finance.tip > 0 && <Row left="Propina" right={money(finance.tip)} />}
                    {(finance.merchantFundedDiscount ?? 0) + (finance.platformFundedDiscount ?? 0) > 0 && (
                      <Row
                        left="Descuentos"
                        right={`-${money((finance.merchantFundedDiscount ?? 0) + (finance.platformFundedDiscount ?? 0))}`}
                      />
                    )}
                    {finance.customerTotal != null && <Row left="Total" right={money(finance.customerTotal)} />}
                    {!data.masked.commissions && finance.merchantCommission != null && (
                      <Row left="Comisión al comercio" right={money(finance.merchantCommission)} />
                    )}
                    {!data.masked.commissions && finance.platformNetRevenue != null && (
                      <Row left="Ingreso neto de ZIPP" right={money(finance.platformNetRevenue)} />
                    )}
                  </ul>
                </Sub>
              )}
            </Section>

            <Section title="Partes">
              <div className="grid grid-cols-1 gap-x-6 gap-y-4 md:grid-cols-3">
                <Fact
                  label="Cliente"
                  value={
                    data.parties.client ? (
                      <EntityLink type="user" id={data.parties.client._id}>
                        {data.parties.client.name}
                      </EntityLink>
                    ) : undefined
                  }
                />
                <Fact
                  label="Comercio"
                  value={
                    data.parties.business ? (
                      <EntityLink type="business" id={data.parties.business._id}>
                        {data.parties.business.name}
                      </EntityLink>
                    ) : order.kind === 'errand' ? 'Mandado, sin comercio' : undefined
                  }
                />
                <Fact
                  label="Domiciliario"
                  value={
                    data.parties.driver ? (
                      <EntityLink type="driver" id={data.parties.driver._id}>
                        {data.parties.driver.name}
                      </EntityLink>
                    ) : 'Sin asignar'
                  }
                />
              </div>
              {data.parties.client?.phoneMasked && (
                <p className="text-[var(--color-text-muted)]">Teléfono del cliente: {data.parties.client.phoneMasked}</p>
              )}
            </Section>

            <Section title="Línea de tiempo">
              {data.timeline.length ? (
                <ul className="space-y-2">
                  {data.timeline.map((t, i) => (
                    <li key={`${t.action}-${t.at}-${i}`} className="flex justify-between gap-3">
                      <span
                        className={`min-w-0 ${
                          t.incident ? 'font-semibold text-[var(--color-danger)]' : 'text-[var(--color-text-secondary)]'
                        }`}
                      >
                        {t.label}
                        {t.actor?.name ? ` · ${t.actor.name}` : t.actor?.role ? ` · ${t.actor.role}` : ''}
                        {t.derived ? ' (deducido)' : ''}
                      </span>
                      <span className="shrink-0 text-[var(--color-text-muted)]">{dateTime(t.at)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-[var(--color-text-muted)]">Sin eventos registrados.</p>
              )}
            </Section>

            <Section title="Despacho">
              <div className="grid grid-cols-2 gap-x-6 gap-y-4 md:grid-cols-3">
                <Fact label="Ronda" value={data.dispatch.round != null ? String(data.dispatch.round) : ''} />
                <Fact label="Ciclo" value={data.dispatch.cycle != null ? String(data.dispatch.cycle) : ''} />
                <Fact
                  label="Oferta vigente hasta"
                  value={data.dispatch.expiresAt ? dateTime(data.dispatch.expiresAt) : ''}
                />
              </div>
              <Sub title="Ofertas" empty="Todavía no se ofreció a ningún domiciliario.">
                {data.dispatch.offers.length ? (
                  <ul className="space-y-1.5">
                    {data.dispatch.offers.map((o, i) => (
                      <Row
                        key={`${o.driverId}-${o.round}-${i}`}
                        left={
                          <>
                            <EntityLink type="driver" id={o.driverId}>
                              {o.driverName ?? 'Domiciliario'}
                            </EntityLink>
                            {o.round != null ? ` · ronda ${o.round}` : ''}
                            {o.reason ? ` · ${offerReasonLabels[o.reason] ?? o.reason}` : ''}
                            {o.offeredAt ? ` · ${dateTime(o.offeredAt)}` : ''}
                          </>
                        }
                        right={outcomeLabels[o.outcome] ?? o.outcome}
                      />
                    ))}
                  </ul>
                ) : undefined}
              </Sub>
            </Section>

            <Section title="Conversación">
              <div className="grid grid-cols-2 gap-x-6 gap-y-4">
                <Fact label="Mensajes" value={String(data.conversation.messages)} />
                <Fact label="Llamadas" value={String(data.conversation.calls)} />
              </div>
            </Section>

            {data.handoff && (
              <Section title="Traspaso">
                <div className="grid grid-cols-1 gap-x-6 gap-y-4 md:grid-cols-3">
                  <CodeState label="Recogida" code={data.handoff.pickup} />
                  <CodeState label="Entrega" code={data.handoff.delivery} />
                  <Fact label="Evidencias" value={String(data.handoff.evidences)} />
                </div>
                <p className="text-[var(--color-text-muted)]">
                  Los códigos nunca se muestran aquí: solo su estado.
                </p>
              </Section>
            )}

            {data.money && (
              <Section title="Dinero">
                <Sub title="Pagos" empty="Sin pagos registrados.">
                  {data.money.payments.length ? (
                    <ul className="space-y-1.5">
                      {data.money.payments.map((p) => (
                        <Row
                          key={p._id}
                          left={`${dateTime(p.createdAt)} · ${p.status}${p.method ? ` · ${p.method}` : ''}`}
                          right={money(p.amount)}
                        />
                      ))}
                    </ul>
                  ) : undefined}
                </Sub>
                {data.money.refunds && (
                  <Sub title="Reembolsos" empty="Sin reembolsos.">
                    {data.money.refunds.length ? (
                      <ul className="space-y-1.5">
                        {data.money.refunds.map((r) => (
                          <Row
                            key={r._id}
                            left={`${dateTime(r.createdAt)} · ${r.status}${r.reason ? ` — ${r.reason}` : ''}`}
                            right={money(r.amount)}
                          />
                        ))}
                      </ul>
                    ) : undefined}
                  </Sub>
                )}
                <Sub title="Pagos a comercio y domiciliario" empty="Sin pagos generados.">
                  {data.money.payouts.length ? (
                    <ul className="space-y-1.5">
                      {data.money.payouts.map((p) => (
                        <Row
                          key={p._id}
                          left={`${p.beneficiary ?? 'Beneficiario'} · ${p.status}`}
                          right={money(p.netAmount ?? p.amount)}
                        />
                      ))}
                    </ul>
                  ) : undefined}
                </Sub>
              </Section>
            )}

            <Section title="Después del pedido">
              <Sub title="Reseña" empty="Sin reseña.">
                {data.after.review ? (
                  <p className="text-[var(--color-text-secondary)]">
                    {data.after.review.rating > 0 ? `${data.after.review.rating}★` : 'Sin calificación'}
                    {data.after.review.comment ? ` — ${data.after.review.comment}` : ''}
                  </p>
                ) : undefined}
              </Sub>
              <Sub title="PQRS" empty="Sin PQRS.">
                {data.after.pqrs.length ? (
                  <ul className="space-y-1.5">
                    {data.after.pqrs.map((p) => (
                      <Row key={p._id} left={`${p.subject ?? 'PQRS'} · ${dateTime(p.createdAt)}`} right={p.status} />
                    ))}
                  </ul>
                ) : undefined}
              </Sub>
              {data.after.cashIncidents && (
                <Sub title="Incidentes de efectivo" empty="Sin incidentes de efectivo.">
                  {data.after.cashIncidents.length ? (
                    <ul className="space-y-1.5">
                      {data.after.cashIncidents.map((c) => (
                        <Row
                          key={c._id}
                          left={dateTime(c.createdAt)}
                          right={`${c.amount != null ? `${money(c.amount)} · ` : ''}${c.status}`}
                        />
                      ))}
                    </ul>
                  ) : undefined}
                </Sub>
              )}
              {data.after.sos && (
                <Sub title="Alertas SOS" empty="Sin alertas SOS.">
                  {data.after.sos.length ? (
                    <ul className="space-y-1.5">
                      {data.after.sos.map((s) => (
                        <Row
                          key={s._id}
                          left={`${dateTime(s.createdAt)}${s.note ? ` — ${s.note}` : ''}`}
                          right={s.status}
                        />
                      ))}
                    </ul>
                  ) : undefined}
                </Sub>
              )}
            </Section>

            {allowed.note && (
              <Section title="Notas internas">
                <InternalNotes entityType="order" entityId={orderId} />
              </Section>
            )}
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
