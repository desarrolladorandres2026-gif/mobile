import { ArrowRight, BellRing } from 'lucide-react';
import { money, orderTag, type BusinessOrder } from '../lib/orderFlow';

/**
 * La tarjeta de pedido nuevo: lo único del panel que no puede pasar
 * desapercibido. Entra con rebote, la campana suena y la tarjeta late con un
 * halo; si el pedido lleva demasiado sin aceptar (`urgent`) todo se vuelve
 * rojo. El movimiento vive en `index.css` (`.order-card`) y se apaga con
 * `prefers-reduced-motion`.
 */

const ITEMS_SHOWN = 3;

interface Props {
  order: BusinessOrder;
  /** Cuántos pedidos esperan en total (el que se enseña es el más antiguo). */
  count: number;
  minutes: number;
  urgent: boolean;
  onView: () => void;
}

export default function NewOrderCard({ order, count, minutes, urgent, onView }: Props) {
  const items = order.items ?? [];
  const extra = items.length - ITEMS_SHOWN;
  const accent = urgent ? 'var(--color-danger)' : 'var(--zipp-gold)';
  const title = urgent
    ? `Sin aceptar hace ${minutes} min`
    : count > 1 ? `${count} pedidos nuevos` : '¡Nuevo pedido!';

  return (
    <div
      role="alert"
      data-urgent={urgent || undefined}
      className="order-card overflow-hidden rounded-2xl border-2 bg-[var(--color-surface)]"
      style={{ borderColor: accent }}
    >
      <div className="flex items-center gap-4 p-5">
        <span className="relative grid h-14 w-14 shrink-0 place-items-center">
          <span aria-hidden className="order-ring absolute inset-0 rounded-full" style={{ background: accent }} />
          <span aria-hidden className="order-ring order-ring-late absolute inset-0 rounded-full" style={{ background: accent }} />
          <span
            className="relative grid h-14 w-14 place-items-center rounded-full text-[var(--zipp-obsidian)]"
            style={{ background: accent, color: urgent ? '#fff' : undefined }}
          >
            <BellRing className="order-bell h-7 w-7" strokeWidth={2} />
          </span>
        </span>

        <div className="min-w-0 flex-1">
          <p className="text-lg font-bold leading-tight text-[var(--color-text-main)]">{title}</p>
          <p className="mt-0.5 text-sm text-[var(--color-text-secondary)] tabular">
            {orderTag(order)} · hace {minutes} min
          </p>
        </div>

        <p className="shrink-0 text-xl font-bold tabular" style={{ color: accent }}>
          {money(order.total)}
        </p>
      </div>

      {items.length > 0 && (
        <ul className="space-y-1 px-5 pb-4 text-sm text-[var(--color-text-main)]">
          {items.slice(0, ITEMS_SHOWN).map((item, index) => (
            <li key={item._id ?? `${item.productName}-${index}`} className="flex gap-2">
              <span className="w-8 shrink-0 font-semibold tabular" style={{ color: accent }}>{item.quantity}×</span>
              <span className="min-w-0 truncate">{item.productName}</span>
            </li>
          ))}
          {extra > 0 && <li className="pl-10 text-xs text-[var(--color-text-secondary)]">y {extra} más</li>}
        </ul>
      )}

      <button
        type="button"
        onClick={onView}
        className="order-cta flex w-full cursor-pointer items-center justify-center gap-2 py-3.5 text-sm font-bold text-[var(--zipp-obsidian)] transition-[filter] hover:brightness-110"
        style={{ background: accent, color: urgent ? '#fff' : undefined }}
      >
        Ver pedido
        <ArrowRight className="h-4 w-4" />
      </button>
    </div>
  );
}
