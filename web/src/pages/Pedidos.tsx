import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { LinkButton } from '../components/Button';
import { StateMessage } from '../components/StateMessage';
import { orderApi, type Order } from '../lib/commerceApi';
import { money } from '../lib/format';
import { setPageMeta } from '../lib/meta';
import { isActiveStatus, ORDER_STATUS_LABELS } from '../lib/orderStatus';

function businessName(order: Order): string {
  return typeof order.businessId === 'object' && order.businessId ? order.businessId.name : 'Comercio';
}

function OrderLine({ order }: { order: Order }) {
  const total = order.finance?.customerTotal;
  return (
    <li className="border-b border-border">
      <Link to={`/pedidos/${order._id}`} className="flex min-h-11 flex-wrap items-center justify-between gap-x-6 gap-y-1 py-3 text-base text-text-main hover:text-primary-text">
        <span>
          <span className="font-semibold">{businessName(order)}</span>
          <span className="block text-sm text-text-secondary">
            {order.orderNumber ? `#${order.orderNumber} · ` : ''}
            {new Date(order.createdAt).toLocaleDateString('es-CO', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
          </span>
        </span>
        <span className="text-right">
          <span className="font-semibold">{ORDER_STATUS_LABELS[order.status] ?? order.status}</span>
          {total != null && <span className="block text-sm tabular-nums text-text-secondary">{money(total)}</span>}
        </span>
      </Link>
    </li>
  );
}

export default function Pedidos() {
  useEffect(() => {
    setPageMeta({ title: 'Mis pedidos | ZIPP' });
  }, []);

  const orders = useQuery({ queryKey: ['orders', 'mine'], queryFn: () => orderApi.mine(1, 30), refetchInterval: 30_000 });
  const list = orders.data ?? [];
  const active = list.filter((o) => isActiveStatus(o.status));
  const past = list.filter((o) => !isActiveStatus(o.status));

  return (
    <div className="mx-auto max-w-2xl px-6 py-10 sm:px-10">
      <h1 className="text-2xl font-semibold text-text-main">Mis pedidos</h1>

      {orders.isPending ? (
        <StateMessage kind="loading" title="Cargando tus pedidos" />
      ) : orders.isError ? (
        <StateMessage kind="error" title="No pudimos cargar tus pedidos">Revisa tu conexión y recarga la página.</StateMessage>
      ) : list.length === 0 ? (
        <>
          <StateMessage kind="empty" title="Todavía no has pedido">Elige un comercio y haz tu primer pedido.</StateMessage>
          <LinkButton href="/comercios" variant="primary">Ver comercios</LinkButton>
        </>
      ) : (
        <>
          {active.length > 0 && (
            <section className="mt-6">
              <h2 className="text-xl font-semibold text-text-main">En curso</h2>
              <ul>{active.map((o) => <OrderLine key={o._id} order={o} />)}</ul>
            </section>
          )}
          {past.length > 0 && (
            <section className="mt-8">
              <h2 className="text-xl font-semibold text-text-main">Anteriores</h2>
              <ul>{past.map((o) => <OrderLine key={o._id} order={o} />)}</ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}
