/**
 * Hasta cuándo el cliente puede cancelar por su cuenta.
 *
 * Vive aparte de `CancelOrderSheet` a propósito: es lógica de negocio pura
 * —sin React, sin estilos, sin nada nativo— y el componente la reexporta.
 * Meterla en el componente hacía que cualquier prueba de esta regla tuviera
 * que arrastrar toda la UI (Reanimated incluido) solo para comprobar una
 * función que compara un texto contra una lista.
 *
 * La línea es "¿se ha consumido algo ya?", y coincide con la máquina de
 * estados: hasta que el negocio no pasa a `preparing` nadie ha gastado
 * ingredientes ni tiempo de cocina, así que la cancelación no le cuesta nada
 * a nadie y no hay razón para poner a un humano en medio.
 *
 * A partir de ahí sí hay comida hecha —y en `on_way`, comida hecha sobre una
 * moto—, y el reembolso completo que emite el servidor se lo come alguien.
 * Esa repartición no la puede decidir un botón: se manda a soporte, que sí
 * puede mirar el caso.
 *
 * El servidor acepta cancelar en los cinco estados. Este límite es de
 * producto, no técnico, y es el único sitio donde hay que tocarlo.
 */
const SELF_SERVICE_STATUSES = ['pending', 'accepted'];

export function canCancelBySelf(status: string): boolean {
  return SELF_SERVICE_STATUSES.includes(status);
}

/** Estados en los que todavía hay algo que ofrecer, aunque sea soporte. */
export function isCancellable(status: string): boolean {
  return ['pending', 'accepted', 'preparing', 'ready', 'on_way'].includes(status);
}
