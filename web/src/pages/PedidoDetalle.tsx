import { useEffect, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { PlainButton } from '../components/Button';
import { FormStatus, SelectField } from '../components/Form';
import { StateMessage } from '../components/StateMessage';
import { OrderTracking } from '../components/OrderTracking';
import { canCancelBySelf } from '../lib/cancelPolicy';
import { orderApi, paymentApi } from '../lib/commerceApi';
import { money } from '../lib/format';
import { ApiError } from '../lib/http';
import { isWompiUrl } from '../lib/payUrl';
import { setPageMeta } from '../lib/meta';
import { describeExtras } from '../lib/modifiers';
import {
  isActiveStatus, needsPayment, ORDER_STATUS_DETAIL, ORDER_STATUS_LABELS, PAYMENT_STATUS_LABELS,
} from '../lib/orderStatus';

const CANCEL_REASONS = [
  { value: 'client_changed_mind', label: 'Cambié de opinión' },
  { value: 'client_ordered_by_mistake', label: 'Pedí por error' },
  { value: 'client_wrong_address', label: 'La dirección es incorrecta' },
  { value: 'client_too_slow', label: 'Está tardando demasiado' },
  { value: 'other', label: 'Otro motivo' },
];

export default function PedidoDetalle() {
  const { id = '' } = useParams<{ id: string }>();
  const location = useLocation();
  const queryClient = useQueryClient();
  const [payError, setPayError] = useState<string | null>((location.state as { payError?: string } | null)?.payError ?? null);
  const [paying, setPaying] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState(CANCEL_REASONS[0].value);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const orderQuery = useQuery({
    queryKey: ['order', id],
    queryFn: () => orderApi.get(id),
    // El socket avisa cada cambio (ver OrderTracking); esto es el respaldo si no está conectado.
    refetchInterval: (q) => (q.state.data && isActiveStatus(q.state.data.status) ? 45_000 : false),
  });
  const order = orderQuery.data;

  useEffect(() => {
    setPageMeta({ title: order?.orderNumber ? `Pedido #${order.orderNumber} | ZIPP` : 'Tu pedido | ZIPP' });
  }, [order?.orderNumber]);

  if (orderQuery.isPending) return <div className="mx-auto max-w-2xl px-6 sm:px-10"><StateMessage kind="loading" title="Cargando tu pedido" /></div>;
  if (orderQuery.isError || !order) {
    const notFound = orderQuery.error instanceof ApiError && (orderQuery.error.status === 404 || orderQuery.error.status === 403);
    return (
      <div className="mx-auto max-w-2xl px-6 sm:px-10">
        <StateMessage kind="error" title={notFound ? 'No encontramos este pedido' : 'No pudimos cargar tu pedido'}>
          <Link to="/pedidos" className="underline underline-offset-4">Ver mis pedidos</Link>
        </StateMessage>
      </div>
    );
  }

  const business = typeof order.businessId === 'object' && order.businessId ? order.businessId : null;
  const f = order.finance;

  const payNow = async () => {
    setPaying(true);
    setPayError(null);
    try {
      const redirectUrl = `${window.location.origin}/pago/retorno?pedido=${encodeURIComponent(order._id)}`;
      const intent = await paymentApi.pay(order._id, redirectUrl);
      if (intent.checkoutUrl && isWompiUrl(intent.checkoutUrl)) {
        window.location.assign(intent.checkoutUrl);
        return;
      }
      await queryClient.invalidateQueries({ queryKey: ['order', id] });
    } catch (err) {
      setPayError(err instanceof ApiError ? err.message : 'No pudimos iniciar el cobro.');
    } finally {
      setPaying(false);
    }
  };

  const cancel = async () => {
    setBusy(true);
    setCancelError(null);
    try {
      await orderApi.cancel(order._id, reason);
      await queryClient.invalidateQueries({ queryKey: ['order', id] });
      await queryClient.invalidateQueries({ queryKey: ['orders', 'mine'] });
      setCancelling(false);
    } catch (err) {
      setCancelError(err instanceof ApiError ? err.message : 'No pudimos cancelar el pedido.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-2xl px-6 py-10 sm:px-10">
      <p className="text-sm text-text-secondary"><Link to="/pedidos" className="underline underline-offset-4">Mis pedidos</Link></p>
      <h1 className="mt-2 text-2xl font-semibold text-text-main">
        {business?.name ?? 'Tu pedido'}{order.orderNumber ? ` · #${order.orderNumber}` : ''}
      </h1>

      <section className="mt-6 border-t border-border pt-6" aria-live="polite">
        <p className="text-xl font-semibold text-text-main">{ORDER_STATUS_LABELS[order.status] ?? order.status}</p>
        <p className="mt-1 text-base text-text-secondary">{ORDER_STATUS_DETAIL[order.status]}</p>
        {isActiveStatus(order.status) && order.estimatedDelivery && (
          <p className="mt-1 text-base text-text-main">
            Llega aproximadamente a las {new Date(order.estimatedDelivery).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' })}.
          </p>
        )}
        {order.status === 'cancelled' && order.cancellationReason && (
          <p className="mt-1 text-base text-text-secondary">{order.cancellationReason}</p>
        )}
      </section>

      {needsPayment(order) && (
        <section className="mt-6 border-t border-border pt-6">
          <p className="text-base text-text-main">Tu pedido está creado, pero el comercio no lo verá hasta que se confirme el pago.</p>
          <div className="mt-3"><PlainButton type="button" onClick={payNow} disabled={paying}>{paying ? 'Abriendo el pago…' : 'Pagar ahora'}</PlainButton></div>
        </section>
      )}
      <div className="mt-4"><FormStatus error={payError} /></div>

      <OrderTracking key={order._id} order={order} />

      <section className="mt-6 border-t border-border pt-6">
        <h2 className="text-xl font-semibold text-text-main">Productos</h2>
        <ul>
          {order.items.map((item, i) => (
            <li key={`${item.productId}-${i}`} className="flex justify-between gap-4 border-b border-border py-3 text-base">
              <span>
                {item.quantity} × {item.productName}
                {item.selectedExtras && item.selectedExtras.length > 0 && (
                  <span className="block text-sm text-text-secondary">{describeExtras(item.selectedExtras)}</span>
                )}
                {item.notes && <span className="block text-sm text-text-secondary">Nota: {item.notes}</span>}
              </span>
              <span className="tabular-nums">{money(item.totalPrice)}</span>
            </li>
          ))}
        </ul>
        {f && (
          <dl className="mt-3">
            {f.productSubtotal != null && <div className="flex justify-between py-1 text-base"><dt>Productos</dt><dd className="tabular-nums">{money(f.productSubtotal)}</dd></div>}
            {f.deliveryCustomerFee != null && <div className="flex justify-between py-1 text-base"><dt>Domicilio</dt><dd className="tabular-nums">{money(f.deliveryCustomerFee)}</dd></div>}
            {f.customerServiceFee ? <div className="flex justify-between py-1 text-base"><dt>Tarifa de servicio</dt><dd className="tabular-nums">{money(f.customerServiceFee)}</dd></div> : null}
            {f.tip ? <div className="flex justify-between py-1 text-base"><dt>Propina</dt><dd className="tabular-nums">{money(f.tip)}</dd></div> : null}
            {f.customerTotal != null && <div className="flex justify-between py-1 text-base font-semibold"><dt>Total</dt><dd className="tabular-nums">{money(f.customerTotal)}</dd></div>}
          </dl>
        )}
        <p className="mt-3 text-base text-text-secondary">
          {order.paymentMethod === 'online' ? 'Pago en línea' : 'Efectivo al recibir'}
          {order.paymentStatus ? ` · ${PAYMENT_STATUS_LABELS[order.paymentStatus] ?? order.paymentStatus}` : ''}
        </p>
        {order.deliveryAddress && <p className="mt-1 text-base text-text-secondary">Entrega en {order.deliveryAddress}</p>}
      </section>

      {isActiveStatus(order.status) && (
        <section className="mt-6 border-t border-border pt-6">
          {canCancelBySelf(order.status) ? (
            cancelling ? (
              <div className="flex max-w-sm flex-col gap-4">
                <SelectField label="Motivo" value={reason} onChange={(e) => setReason(e.target.value)} options={CANCEL_REASONS} />
                <FormStatus error={cancelError} />
                <div className="flex flex-wrap gap-3">
                  <PlainButton type="button" onClick={cancel} disabled={busy}>{busy ? 'Cancelando…' : 'Cancelar pedido'}</PlainButton>
                  <PlainButton type="button" variant="tertiary" onClick={() => setCancelling(false)}>No cancelar</PlainButton>
                </div>
              </div>
            ) : (
              <PlainButton type="button" variant="secondary" onClick={() => setCancelling(true)}>Cancelar pedido</PlainButton>
            )
          ) : (
            <p className="text-base text-text-secondary">
              Tu pedido ya está en preparación. Para cancelarlo, escríbenos desde{' '}
              <Link to="/soporte" className="font-semibold underline underline-offset-4">Soporte</Link>.
            </p>
          )}
        </section>
      )}
    </div>
  );
}
