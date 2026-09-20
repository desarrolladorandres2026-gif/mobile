/**
 * Zipp Pro: el plan, en un solo archivo.
 *
 * Todo lo que un día habrá que negociar —precio, duración, qué incluye y
 * desde cuánto— vive aquí y en ningún otro sitio. La pantalla de la app no
 * conoce ninguno de estos números: los pide a `GET /pro`. Cambiar el precio
 * es editar una línea de este archivo y reiniciar, sin tocar el móvil ni
 * publicar una versión nueva.
 *
 * Los beneficios no son texto decorativo: cada uno de los que están en
 * `benefits` lo aplica de verdad el motor de precios (ver
 * `PricingService.settleDiscounts`). Si alguno se apaga aquí, deja de
 * cobrarse y deja de prometerse a la vez — que es justo lo que evita
 * cobrar por algo que no se entrega.
 */

export interface ProPlan {
  /** Identificador estable. Queda grabado en la suscripción que se cobra. */
  id: string;
  name: string;
  /** Precio del periodo, en pesos enteros. Wompi cobra en COP sin centavos. */
  price: number;
  currency: string;
  /** Cuánto dura lo pagado. La renovación vuelve a cobrar al terminar. */
  periodDays: number;
  benefits: ProBenefits;
}

export interface ProBenefits {
  /** Envío gratis, lo financia ZIPP (no el comercio). */
  freeDelivery: {
    enabled: boolean;
    /** Compra mínima en producto para que aplique. 0 = siempre. */
    minSubtotal: number;
  };
  /** La tarifa de servicio del pedido queda en cero. */
  serviceFeeWaived: {
    enabled: boolean;
  };
}

/**
 * El plan vigente.
 *
 * TODO(negocio): estos valores son una propuesta de arranque, no una
 * decisión tomada. Antes de abrir la suscripción al público hay que fijar:
 *   · `price`        — cuánto cuesta el mes.
 *   · `periodDays`   — 30 días o mes natural.
 *   · `minSubtotal`  — desde cuánto regalamos el envío sin perder dinero.
 *   · `serviceFeeWaived` — si la tarifa de servicio entra o no en el trato.
 */
export const PRO_PLAN: ProPlan = {
  id: 'pro-mensual-v1',
  name: 'Zipp Pro',
  price: 14_900,
  currency: 'COP',
  periodDays: 30,
  benefits: {
    freeDelivery: { enabled: true, minSubtotal: 30_000 },
    serviceFeeWaived: { enabled: true },
  },
};

/**
 * Cuántas veces se reintenta un cobro de renovación antes de dar la
 * membresía por vencida.
 *
 * Un rechazo no es una baja: un cupo copado o una tarjeta que el banco
 * bloqueó un martes se resuelven solos al día siguiente. Cortar el acceso
 * al primer "no" convierte un problema del banco en una cancelación
 * nuestra.
 */
export const PRO_RENEWAL_MAX_ATTEMPTS = 3;

/** Cuánto se espera entre un reintento de renovación y el siguiente. */
export const PRO_RENEWAL_RETRY_HOURS = 24;

/**
 * Cuánto antes del vencimiento se intenta cobrar la renovación.
 *
 * Sin adelanto, entre que el periodo vence y el cobro se confirma hay un
 * rato —minutos con tarjeta, más si el banco tarda— en el que la persona
 * ya pagó su mes siguiente y la app le dice que no es Pro. Cobrar un día
 * antes hace que ese hueco no exista, y lo cobrado se encadena al final
 * del periodo vigente, así que no se pierde ni un día.
 */
export const PRO_RENEWAL_LEAD_HOURS = 24;
