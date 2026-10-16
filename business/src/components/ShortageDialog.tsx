import { useState } from 'react';
import { createPortal } from 'react-dom';
import { Minus, Plus, X } from 'lucide-react';
import { money, type BusinessOrder } from '../lib/orderFlow';
import { SHORTAGE_REASONS, buildShortageBody, type ShortageReason } from '../lib/shortage';

/**
 * «Me falta un producto»: el comercio marca qué no puede entregar y el
 * cliente decide si sigue con el resto o cancela.
 *
 * No reemplaza a «rechazar»: rechazar cancela todo el pedido. Esto es para
 * cuando falta una línea y lo demás se puede entregar. El cliente tiene unos
 * minutos para responder, y mientras tanto el pedido no puede marcarse listo.
 */

interface Props {
  order: BusinessOrder;
  busy: boolean;
  error?: string;
  onConfirm: (body: ReturnType<typeof buildShortageBody>) => void;
  onCancel: () => void;
}

export default function ShortageDialog({ order, busy, error, onConfirm, onCancel }: Props) {
  const [missing, setMissing] = useState<Record<string, number>>({});
  const [reason, setReason] = useState<ShortageReason>('out_of_stock');

  const lines = (order.items ?? []).filter((item) => item._id);
  const body = buildShortageBody(order.items ?? [], missing, reason);
  const everything = body.items.length > 0 && body.items.every((entry) => {
    const line = lines.find((item) => item._id === entry.itemId);
    return line && entry.missingQty >= line.quantity;
  }) && body.items.length === lines.length;
  const ready = body.items.length > 0 && !everything;

  const change = (itemId: string, quantity: number, delta: number) =>
    setMissing((current) => ({
      ...current,
      [itemId]: Math.min(quantity, Math.max(0, (current[itemId] ?? 0) + delta)),
    }));

  return createPortal(
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="Cancelar"
        onClick={onCancel}
        className="absolute inset-0 cursor-default bg-black/50"
      />
      <div role="dialog" aria-label="Producto que falta" className="zipp-modal relative w-full max-w-md">
        <div className="space-y-3 p-5">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <h3 className="text-sm font-semibold text-[var(--color-text-main)]">Me falta un producto</h3>
              <p className="mt-1 text-xs leading-relaxed text-[var(--color-text-secondary)]">
                Marca lo que no puedes entregar. El cliente decide si sigue con el resto: si acepta, paga menos; si no,
                el pedido se cancela. Solo en pedidos en efectivo.
              </p>
            </div>
            <button
              type="button"
              onClick={onCancel}
              aria-label="Cerrar"
              className="shrink-0 cursor-pointer rounded-md p-1 text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-main)]"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <ul className="divide-y divide-[var(--color-border)]">
            {lines.map((item) => {
              const itemId = item._id as string;
              const value = missing[itemId] ?? 0;
              return (
                <li key={itemId} className="flex items-center gap-3 py-2 text-sm">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium text-[var(--color-text-main)]">{item.productName}</p>
                    <p className="text-xs tabular text-[var(--color-text-secondary)]">
                      {item.quantity} {item.quantity === 1 ? 'unidad' : 'unidades'} ·{' '}
                      {money(item.totalPrice ?? item.unitPrice * item.quantity)}
                    </p>
                  </div>
                  <div className="flex items-center gap-1" role="group" aria-label={`Faltan de ${item.productName}`}>
                    <button
                      type="button"
                      onClick={() => change(itemId, item.quantity, -1)}
                      disabled={value === 0}
                      aria-label="Una menos"
                      className="grid h-7 w-7 cursor-pointer place-items-center rounded-md border border-[var(--color-border)] text-[var(--color-text-main)] hover:bg-[var(--color-surface-hover)] disabled:cursor-default disabled:opacity-30"
                    >
                      <Minus className="h-3.5 w-3.5" />
                    </button>
                    <span className="w-6 text-center tabular text-sm font-semibold">{value}</span>
                    <button
                      type="button"
                      onClick={() => change(itemId, item.quantity, 1)}
                      disabled={value >= item.quantity}
                      aria-label="Una más"
                      className="grid h-7 w-7 cursor-pointer place-items-center rounded-md border border-[var(--color-border)] text-[var(--color-text-main)] hover:bg-[var(--color-surface-hover)] disabled:cursor-default disabled:opacity-30"
                    >
                      <Plus className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>

          <div role="radiogroup" aria-label="Motivo" className="flex flex-wrap gap-x-4 gap-y-1">
            {SHORTAGE_REASONS.map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={reason === option.value}
                onClick={() => setReason(option.value)}
                className={`cursor-pointer py-1 text-xs ${
                  reason === option.value
                    ? 'font-semibold text-[var(--color-primary)] underline underline-offset-4'
                    : 'font-medium text-[var(--color-text-main)] hover:underline'
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>

          {everything ? (
            <p className="text-xs text-[var(--color-warning)]">
              Si falta todo, rechaza el pedido: no queda nada que entregar.
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="text-xs font-semibold text-[var(--color-danger)]">
              {error}
            </p>
          ) : null}

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onCancel}
              className="h-8 cursor-pointer rounded-md border border-[var(--color-border)] px-4 text-xs font-medium text-[var(--color-text-main)] hover:bg-[var(--color-surface-hover)]"
            >
              Cancelar
            </button>
            <button
              type="button"
              disabled={busy || !ready}
              onClick={() => onConfirm(body)}
              className="h-8 cursor-pointer rounded-md bg-[var(--color-primary)] px-4 text-xs font-semibold text-[var(--zipp-obsidian)] hover:bg-[var(--color-primary-light)] disabled:cursor-default disabled:opacity-40"
            >
              {busy ? 'Enviando…' : 'Avisar al cliente'}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
