/**
 * El texto bajo un pago no aprobado.
 *
 * "No se hizo ningún cobro" va siempre, con o sin motivo: es lo primero que
 * quiere saber quien acaba de ver un rechazo, y el motivo que manda el
 * servidor ("La tarjeta está vencida.") no lo dice por sí solo. Vive aquí y
 * no en cada pantalla para que el cobro de un pedido, el de la membresía y
 * el Web Checkout digan lo mismo.
 */
export function declinedMessage(reason: string | null | undefined, retryHint: string): string {
  const clean = reason?.trim();
  if (!clean) return `No se hizo ningún cobro. ${retryHint}`;
  const sentence = /[.!?]$/.test(clean) ? clean : `${clean}.`;
  return `${sentence} No se hizo ningún cobro.`;
}
