import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { GripVertical } from 'lucide-react';
import PickupHandoff from './PickupHandoff';
import {
  ACTIVE_STATUSES, ORDER_STATUS, money, shortId, clock, nextBusinessStep,
  type BusinessOrder, type OrderItem, type OrderStatus,
} from '../lib/orderFlow';

/**
 * Tablero de comandas: una columna por estado activo.
 *
 * El pedido avanza de dos formas equivalentes —arrastrándolo a la columna
 * siguiente o con el botón de la fila— porque el arrastre nativo no existe
 * en pantallas táctiles y la cocina también usa tableta. Ambas pasan por
 * `onAdvance`, así que la regla de qué transición le toca al comercio vive
 * en un solo sitio (`nextBusinessStep`): soltar en una columna que el
 * backend rechazaría ni siquiera se ofrece como destino.
 *
 * Sin tarjetas: las columnas se separan con una línea fina y cada pedido es
 * una fila plana. El estado lo dice la columna, no una pastilla.
 */

/** Minutos desde que entró el pedido a partir de los cuales pide atención. */
const WARN_MINUTES = 10;
const LATE_MINUTES = 20;

const minutesSince = (iso: string, now: number) =>
  Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60_000));

const elapsedLabel = (minutes: number) =>
  minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;

const timerTone = (minutes: number) =>
  minutes >= LATE_MINUTES
    ? 'text-[var(--color-danger)]'
    : minutes >= WARN_MINUTES
      ? 'text-[var(--color-warning)]'
      : 'text-[var(--color-text-secondary)]';

interface Props {
  orders: BusinessOrder[];
  /** Pedido a enseñar (viene del aviso "Ver pedido"): se centra y se marca. */
  focusId?: string | null;
  busyOrderId: string | null;
  handoffTick: number;
  onAdvance: (order: BusinessOrder, status: OrderStatus) => void;
  onReject: (order: BusinessOrder) => void;
  /** ¿Puede esta persona rechazar este pedido? Si no, el botón ni aparece. */
  canReject: (order: BusinessOrder) => boolean;
  onOpen: (order: BusinessOrder) => void;
}

export default function OrderBoard({ orders, focusId, busyOrderId, handoffTick, onAdvance, onReject, canReject, onOpen }: Props) {
  const [dragging, setDragging] = useState<BusinessOrder | null>(null);
  const [overColumn, setOverColumn] = useState<OrderStatus | null>(null);

  // Centra el pedido una sola vez por aviso: sin el `ref`, cada recarga de
  // la lista (cada 30 s) volvería a mover la pantalla.
  const scrolledFor = useRef<string | null>(null);
  useEffect(() => {
    if (!focusId || scrolledFor.current === focusId) return;
    const row = document.getElementById(`pedido-${focusId}`);
    if (!row) return; // aún no cargó: se reintenta cuando lleguen los pedidos
    scrolledFor.current = focusId;
    row.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [focusId, orders]);

  // Los minutos avanzan solos: sin este pulso el temporizador se quedaría
  // congelado hasta que llegara un evento del socket.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  // Dentro de cada columna, primero el que lleva más tiempo esperando.
  const columns = useMemo(
    () =>
      ACTIVE_STATUSES.map((status) => ({
        status,
        items: orders
          .filter((order) => order.status === status)
          .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()),
      })),
    [orders],
  );

  const targetOf = (order: BusinessOrder | null) => (order ? nextBusinessStep(order.status)?.status ?? null : null);
  const validTarget = targetOf(dragging);

  const onDrop = (event: DragEvent, column: OrderStatus) => {
    event.preventDefault();
    const order = dragging;
    setDragging(null);
    setOverColumn(null);
    if (order && column === targetOf(order)) onAdvance(order, column);
  };

  const waiting = orders.length;
  const oldest = waiting
    ? Math.max(...orders.map((order) => minutesSince(order.createdAt, now)))
    : 0;

  return (
    <div className="relative">
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 md:divide-x divide-[var(--color-border)]">
      {columns.map(({ status, items }) => {
        const isTarget = validTarget === status;
        const isOver = isTarget && overColumn === status;
        return (
          <section
            key={status}
            aria-label={ORDER_STATUS[status].label}
            onDragOver={(event) => {
              if (!isTarget) return;
              event.preventDefault();
              setOverColumn(status);
            }}
            onDragLeave={() => setOverColumn((current) => (current === status ? null : current))}
            onDrop={(event) => onDrop(event, status)}
            className={`min-h-[16rem] px-4 pb-4 border-t-2 transition-colors ${
              isOver
                ? 'border-[var(--color-primary)]'
                : isTarget
                  ? 'border-[var(--color-primary)]/40'
                  : 'border-transparent'
            }`}
          >
            <header className="flex items-baseline justify-between py-4 border-b border-[var(--color-border)]">
              <h3 className="flex items-center gap-2 text-sm font-semibold text-[var(--color-text-main)]">
                <span aria-hidden className={`w-2 h-2 rounded-full ${ORDER_STATUS[status].dot}`} />
                {ORDER_STATUS[status].label}
              </h3>
              <span className="text-lg font-semibold tabular text-[var(--color-text-main)]">{items.length}</span>
            </header>

            {items.length === 0 ? (
              <p className="py-10 text-sm font-medium text-[var(--color-text-secondary)]">
                {isTarget ? 'Suéltalo aquí' : 'Sin pedidos'}
              </p>
            ) : (
              <ul className="divide-y divide-[var(--color-border)]">
                {items.map((order) => {
                  const step = nextBusinessStep(order.status);
                  const busy = busyOrderId === order._id;
                  const minutes = minutesSince(order.createdAt, now);
                  return (
                    <li
                      key={order._id}
                      id={`pedido-${order._id}`}
                      draggable={!!step && !busy}
                      onDragStart={(event) => {
                        event.dataTransfer.effectAllowed = 'move';
                        event.dataTransfer.setData('text/plain', order._id);
                        setDragging(order);
                      }}
                      onDragEnd={() => { setDragging(null); setOverColumn(null); }}
                      className={`relative pl-4 py-4 space-y-3 scroll-mt-28 transition-opacity ${step ? 'md:cursor-grab md:active:cursor-grabbing' : ''} ${
                        dragging?._id === order._id ? 'opacity-40' : ''
                      }`}
                    >
                      {/* La franja dice el estado y el retraso; en el pedido
                          que viene de un aviso se engrosa para encontrarlo. */}
                      <span
                        aria-hidden
                        className={`absolute left-0 top-4 bottom-4 rounded-full ${
                          focusId === order._id ? 'w-1.5 bg-[var(--color-primary)]' : `w-1 ${ORDER_STATUS[order.status].dot}`
                        }`}
                      />
                      <button
                        type="button"
                        onClick={() => onOpen(order)}
                        aria-label={`Ver el detalle del pedido ${order.orderNumber ?? ''}`}
                        className="w-full text-left cursor-pointer group"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="flex items-center gap-1.5 text-base font-semibold tabular text-[var(--color-text-main)]">
                            {step && <GripVertical className="hidden md:block w-4 h-4 text-[var(--color-text-secondary)]" aria-hidden />}
                            {order.orderNumber ?? shortId(order._id)}
                          </span>
                          <span className={`text-sm font-semibold tabular ${timerTone(minutes)}`} title={`Llegó a las ${clock(order.createdAt)}`}>
                            {elapsedLabel(minutes)}
                          </span>
                        </div>
                        <p className="mt-1 text-sm font-medium text-[var(--color-text-main)] group-hover:underline underline-offset-2">
                          {order.clientId?.name ?? 'Cliente'}
                        </p>
                        <p className="mt-1 text-sm font-medium text-[var(--color-text-secondary)] line-clamp-3">
                          {(order.items ?? [])
                            .map((item: OrderItem) => `${item.quantity}× ${item.productName}`)
                            .join(' · ')}
                        </p>
                        <p className="mt-1.5 text-base font-semibold tabular text-[var(--color-text-main)]">{money(order.total)}</p>
                      </button>

                      {order.status === 'ready' && <PickupHandoff order={order} refreshKey={handoffTick} />}

                      {(step || (order.status === 'pending' && canReject(order))) && (
                        <div className="flex items-center gap-3">
                          {step && (
                            <button
                              type="button"
                              onClick={() => onAdvance(order, step.status)}
                              disabled={busy}
                              className="h-11 flex-1 px-4 rounded-lg text-sm font-semibold text-[var(--zipp-obsidian)] bg-[var(--color-primary)] hover:bg-[var(--color-primary-light)] active:scale-[0.98] transition cursor-pointer disabled:opacity-50"
                            >
                              {busy ? 'Un momento…' : step.label}
                            </button>
                          )}
                          {order.status === 'pending' && canReject(order) && (
                            <button
                              type="button"
                              onClick={() => onReject(order)}
                              disabled={busy}
                              className="h-11 px-4 text-sm font-medium text-[var(--color-danger)] hover:underline cursor-pointer disabled:opacity-50"
                            >
                              Rechazar
                            </button>
                          )}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        );
      })}
    </div>

      {/* Resumen siempre a la vista, como el contador de la tableta del
          mostrador: cuántos esperan y cuánto lleva el más antiguo. */}
      {waiting > 0 && (
        <p
          aria-live="polite"
          className="sticky bottom-4 ml-auto mt-4 w-fit rounded-full bg-[var(--color-primary)] px-4 py-2 text-sm font-semibold tabular text-[var(--zipp-obsidian)] shadow-lg"
        >
          {waiting} {waiting === 1 ? 'pedido' : 'pedidos'} · el más antiguo, {elapsedLabel(oldest)}
        </p>
      )}
    </div>
  );
}
