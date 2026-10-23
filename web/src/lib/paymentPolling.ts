/**
 * Cada cuánto preguntar por un pago pendiente.
 *
 * Escalonado, no fijo. Una tarjeta se resuelve en segundos y conviene
 * enterarse rápido; un Nequi puede tardar hasta diez minutos mientras la
 * persona abre su app y aprueba. A 3 s fijos, esos diez minutos son 200
 * consultas, y el limitador del backend para este endpoint corta en 150
 * cada 5 minutos: la pantalla de espera acabaría recibiendo su propio 429
 * justo mientras el cliente espera su pedido.
 *
 * El socket (`payment:updated`) es el aviso principal; esto es el respaldo
 * para cuando el socket no está.
 */
export function paymentPollInterval(elapsedMs: number): number {
  if (elapsedMs < 30_000) return 3_000;
  if (elapsedMs < 120_000) return 5_000;
  return 10_000;
}
