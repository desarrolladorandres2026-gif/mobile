/**
 * ¿Es un buen momento para recargar el panel o reiniciar la app de
 * escritorio? Lo usan `checkForUpdates.ts` (deploy del panel) y el
 * contenedor (`desktop/src/main/updater.ts`, vía `report-status`) para no
 * interrumpir a media cocina.
 *
 * TODO(usuario): decide qué cuenta como "tranquilo". Es una decisión de
 * negocio, no técnica — piensa en qué tan molesto es un parpadeo de 1-2 s
 * de la pantalla completa con pedidos esperando, contra dejar una
 * actualización pendiente horas. Puedes usar solo `ringingCount`, o
 * también la hora (de madrugada casi siempre es tranquilo) o cuánto lleva
 * inactivo el mostrador (`idleSeconds`, sin clics ni teclas).
 *
 * Mientras no la ajustes, el criterio es el más conservador posible: sin
 * nada esperando sonar.
 */
export interface QuietMomentInput {
  /** Pedidos sonando ahora mismo (ver `orderAlarm.waitingOrders`). */
  ringingCount: number;
}

export function isQuietMoment(input: QuietMomentInput): boolean {
  return input.ringingCount === 0;
}
