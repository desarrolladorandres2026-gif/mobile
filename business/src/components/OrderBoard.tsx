import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { Banknote, Clock3, GripVertical, StickyNote } from 'lucide-react';
import { WompiLogo } from './WompiLogo';
import PickupHandoff from './PickupHandoff';
import { waitingSince } from '../lib/orderAlarm';
import {
  ACTIVE_STATUSES, ORDER_STATUS, money, clock, nextBusinessStep, describeExtras, orderTag,
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
 * Cada pedido es una tarjeta redondeada (decisión 2026-10-13: antes eran filas
 * planas) y las columnas se separan con una línea fina. La presencia la dan la
 * jerarquía (número y total grandes, en peso normal), el tiempo de espera y
 * la franja del color del botón de su paso, que respira mientras el pedido espera.
 */


const minutesSince = (since: number, now: number) =>
  Math.max(0, Math.floor((now - since) / 60_000));

/** El comercio puede rechazar hasta que sale del local (`BUSINESS_CANCELLABLE_STATUSES` en el backend). */
const REJECTABLE: ReadonlySet<string> = new Set(['pending', 'accepted', 'preparing', 'ready']);

const elapsedLabel = (minutes: number) =>
  minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;

/** Color neutro de respaldo: el de los pedidos que no tienen un paso propio (listo para recoger). */
const INK = 'bg-[var(--color-text-main)]';

/**
 * El botón de avanzar toma el color del paso que ofrece: aceptar en verde,
 * empezar cocina en ámbar y marcar listo en coral (`--color-danger`). Tinta
 * obsidiana sobre verde y ámbar (blanco sobre ellos no llega al contraste).
 */
const STEP_BG: Partial<Record<OrderStatus, string>> = {
  pending: 'bg-[var(--color-success)]',
  accepted: 'bg-[var(--color-warning)]',
  preparing: 'bg-[var(--color-danger)]',
};

const STEP_BUTTON: Partial<Record<OrderStatus, string>> = {
  pending: `${STEP_BG.pending} text-[var(--zipp-obsidian)]`,
  accepted: `${STEP_BG.accepted} text-[var(--zipp-obsidian)]`,
  preparing: `${STEP_BG.preparing} text-white`,
};

/** Líneas de producto que se enseñan antes del "y N más". */
const ITEMS_SHOWN = 8;

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
    ? Math.max(...orders.map((order) => minutesSince(waitingSince(order), now)))
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
                ? 'border-[var(--color-text-main)]'
                : isTarget
                  ? 'border-[var(--color-text-main)]/40'
                  : 'border-transparent'
            }`}
          >
            <header className="flex items-baseline justify-between py-4 border-b border-[var(--color-border)]">
              <h3 className="flex items-center gap-2 text-sm font-semibold text-[var(--color-text-main)]">
                <span aria-hidden className={`w-2 h-2 rounded-full ${STEP_BG[status] ?? INK}`} />
                {ORDER_STATUS[status].label}
              </h3>
              <span className="text-lg font-semibold tabular text-[var(--color-text-main)]">{items.length}</span>
            </header>

            {items.length === 0 ? (
              <p className="py-10 text-sm font-medium text-[var(--color-text-secondary)]">
                {isTarget ? 'Suéltalo aquí' : 'Sin pedidos'}
              </p>
            ) : (
              <ul className="space-y-3">
                {items.map((order) => {
                  const step = nextBusinessStep(order.status);
                  const busy = busyOrderId === order._id;
                  const minutes = minutesSince(waitingSince(order), now);
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
                      className={`order-row relative rounded-2xl border bg-[var(--color-surface)] pl-7 pr-4 py-4 space-y-4 scroll-mt-28 transition-opacity border-[var(--color-border)] ${step ? 'md:cursor-grab md:active:cursor-grabbing' : ''} ${
                        dragging?._id === order._id ? 'opacity-40' : ''
                      }`}
                    >
                      {/* La franja dice el estado; respira mientras el pedido espera
                          respuesta y se engrosa en el que viene de un aviso. */}
                      <span
                        aria-hidden
                        className={`absolute left-3 top-5 bottom-5 rounded-full ${order.status === 'pending' ? 'order-stripe-live' : ''} ${
                          `w-1 ${STEP_BG[order.status] ?? INK}`
                        }`}
                      />
                      <button
                        type="button"
                        onClick={() => onOpen(order)}
                        aria-label={`Ver el detalle del pedido ${orderTag(order)}`}
                        className="w-full text-left cursor-pointer group space-y-3"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <span className="flex items-center gap-1.5 text-xl font-normal tabular leading-tight text-[var(--color-text-main)]">
                              {step && <GripVertical className="hidden md:block w-4 h-4 text-[var(--color-text-secondary)]" aria-hidden />}
                              {orderTag(order)}
                            </span>
                            <p className="mt-0.5 truncate text-sm font-normal text-[var(--color-text-main)] group-hover:underline underline-offset-2">
                              {order.clientId?.name ?? 'Cliente'}
                            </p>
                          </div>
                          <div className="shrink-0 text-right">
                            <p className="text-xl font-normal tabular leading-tight text-[var(--color-text-main)]">{money(order.total)}</p>
                            <p className="mt-0.5 flex items-center justify-end gap-1 text-xs font-normal text-[var(--color-text-secondary)]">
                              {order.paymentMethod === 'cash_on_delivery'
                                ? <><Banknote className="w-3.5 h-3.5" aria-hidden /> Efectivo</>
                                : <>Pagado · <WompiLogo height={10} /></>}
                            </p>
                          </div>
                        </div>

                        <span className="block space-y-1">
                          {(order.items ?? []).slice(0, ITEMS_SHOWN).map((item: OrderItem, index) => {
                            const extras = describeExtras(item.selectedExtras);
                            return (
                              <span key={item._id ?? `${item.productName}-${index}`} className="flex gap-2 text-sm text-[var(--color-text-main)]">
                                <span className="w-7 shrink-0 font-normal tabular text-[var(--color-text-main)]">{item.quantity}×</span>
                                <span className="min-w-0">
                                  <span className="font-normal">{item.productName}</span>
                                  {extras && <span className="block text-xs text-[var(--color-text-secondary)]">{extras}</span>}
                                  {item.notes && <span className="block text-xs italic text-[var(--color-text-main)]">“{item.notes}”</span>}
                                </span>
                              </span>
                            );
                          })}
                          {(order.items?.length ?? 0) > ITEMS_SHOWN && (
                            <span className="block pl-9 text-xs font-normal text-[var(--color-text-secondary)]">
                              y {(order.items?.length ?? 0) - ITEMS_SHOWN} más
                            </span>
                          )}
                        </span>

                        {order.notes && (
                          <p className="flex items-start gap-1.5 text-xs font-normal text-[var(--color-text-secondary)]">
                            <StickyNote className="mt-px w-3.5 h-3.5 shrink-0" aria-hidden />
                            <span className="line-clamp-2">{order.notes}</span>
                          </p>
                        )}

                        {/* La espera: cuánto lleva el pedido en el local. */}
                        <div title={order.scheduledFor ? `Programado para las ${clock(order.scheduledFor)}` : `Llegó a las ${clock(order.createdAt)}`}>
                          <p className="flex items-center gap-1.5 text-sm font-normal tabular text-[var(--color-text-main)]">
                            <Clock3 className="w-4 h-4" aria-hidden />
                            {elapsedLabel(minutes)}
                          </p>
                        </div>
                      </button>

                      {order.status === 'ready' && <PickupHandoff order={order} refreshKey={handoffTick} />}

                      {(step || (REJECTABLE.has(order.status) && canReject(order))) && (
                        <div className="flex items-center gap-3">
                          {step && (
                            <button
                              type="button"
                              onClick={() => onAdvance(order, step.status)}
                              disabled={busy}
                              className={`h-12 flex-1 px-4 rounded-xl text-sm font-normal hover:brightness-110 active:scale-[0.97] transition cursor-pointer disabled:opacity-50 ${STEP_BUTTON[order.status] ?? 'bg-[var(--color-text-main)] text-[var(--color-surface)]'}`}
                            >
                              {busy ? 'Un momento…' : step.label}
                            </button>
                          )}
                          {REJECTABLE.has(order.status) && canReject(order) && (
                            <button
                              type="button"
                              onClick={() => onReject(order)}
                              disabled={busy}
                              className="h-12 px-3 text-sm font-normal text-[var(--color-text-secondary)] hover:text-[var(--color-text-main)] hover:underline cursor-pointer disabled:opacity-50"
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
          className="sticky bottom-4 ml-auto mt-4 w-fit rounded-full bg-[var(--color-text-main)] px-4 py-2 text-sm font-semibold tabular text-[var(--color-surface)] shadow-lg"
        >
          {waiting} {waiting === 1 ? 'pedido' : 'pedidos'} · el más antiguo, {elapsedLabel(oldest)}
        </p>
      )}
    </div>
  );
}
