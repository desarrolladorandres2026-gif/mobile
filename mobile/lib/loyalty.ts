/**
 * Cuántos puntos canjear en un pedido.
 *
 * Un canje se convierte en un cupón de un solo uso, y el servidor recorta su
 * descuento a lo que el pedido puede absorber: el subtotal de productos y el
 * tope de subsidio por pedido. Lo que exceda se pierde con el cupón. Por eso
 * no se canjea "todo el saldo" sino exactamente lo que este pedido puede
 * usar, y el resto se queda en la cuenta para el siguiente.
 *
 * Un punto vale un peso (ver `POINT_VALUE_COP` en el backend), así que aquí
 * puntos y pesos son el mismo número.
 */
export type RedeemPlan =
  /** Se pueden canjear `points` en este pedido. */
  | { kind: 'redeem'; points: number }
  /** El saldo aún no llega al canje mínimo. */
  | { kind: 'below-minimum'; missing: number }
  /** Hay saldo, pero este pedido no alcanza a absorber el canje mínimo. */
  | { kind: 'order-too-small'; minRedeem: number }
  /** Sin puntos. */
  | { kind: 'none' };

export function planRedemption({
  balance, minRedeem, maxPerOrder, subtotal,
}: {
  balance: number;
  minRedeem: number;
  /** Tope de subsidio por pedido. 0 = sin tope. */
  maxPerOrder: number;
  /** Subtotal de productos: el descuento de un canje solo aplica sobre él. */
  subtotal: number;
}): RedeemPlan {
  if (balance <= 0) return { kind: 'none' };
  if (balance < minRedeem) return { kind: 'below-minimum', missing: minRedeem - balance };

  const ceiling = maxPerOrder > 0 ? Math.min(subtotal, maxPerOrder) : subtotal;
  const points = Math.floor(Math.min(balance, ceiling));

  if (points <= 0 || points < minRedeem) return { kind: 'order-too-small', minRedeem };
  return { kind: 'redeem', points };
}

/**
 * Cantidades para canjear fuera del checkout.
 *
 * Antes solo existía "canjear todo", y un cupón de un solo uso por todo el
 * saldo es justo lo que quema puntos en un pedido pequeño. El mínimo, un
 * cuarto, la mitad y todo, redondeados a cientos para que se lean de un
 * vistazo, y sin repetir cifras cuando el saldo es corto.
 */
export function redeemOptions(balance: number, minRedeem: number): number[] {
  if (balance <= 0 || balance < minRedeem) return [];

  const floor100 = (n: number) => Math.floor(n / 100) * 100;
  const candidates = [minRedeem, floor100(balance / 4), floor100(balance / 2), balance];

  return [...new Set(candidates)]
    .filter((n) => n > 0 && n >= minRedeem && n <= balance)
    .sort((a, b) => a - b);
}
