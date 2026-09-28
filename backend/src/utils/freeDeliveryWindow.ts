import type { CouponTiming } from './couponWindow';
import { couponAvailability } from './couponWindow';

/**
 * El envío gratis por compra mínima ahora puede tener vigencia (fecha y
 * franja horaria), igual que un cupón. En vez de duplicar la lógica de
 * "¿está abierto ahora mismo?", se construye un `CouponTiming` sintético a
 * partir de los campos de `Business` y se reutiliza `couponAvailability()`
 * tal cual — la misma función que ya decide si un cupón está activo,
 * programado o agotado.
 */

interface FreeDeliveryTimingSource {
  freeDeliveryThreshold: number;
  freeDeliveryValidFrom: Date;
  freeDeliveryValidUntil: Date;
  freeDeliveryValidDays: number[];
  freeDeliveryValidFromTime?: string;
  freeDeliveryValidUntilTime?: string;
}

export function freeDeliveryTiming(business: FreeDeliveryTimingSource): CouponTiming {
  return {
    // Un umbral en 0 significa "desactivado", no "sin uso ni presupuesto
    // todavía": se trata como si el beneficio ya no existiera.
    isActive: business.freeDeliveryThreshold > 0,
    validFrom: business.freeDeliveryValidFrom,
    validUntil: business.freeDeliveryValidUntil,
    // El envío gratis no tiene cupo ni presupuesto propio: el gasto real ya
    // lo cuenta `merchantFundedDiscount` en cada pedido, no un contador aquí.
    usageLimit: 0,
    usedCount: 0,
    budgetLimit: 0,
    budgetSpent: 0,
    validDays: business.freeDeliveryValidDays,
    validFromTime: business.freeDeliveryValidFromTime,
    validUntilTime: business.freeDeliveryValidUntilTime,
  };
}

/**
 * El umbral de envío gratis tal y como aplica ahora mismo: el configurado,
 * o 0 si está fuera de su ventana de fecha/horario. Ningún sitio de lectura
 * (checkout, listados, `/offers`) debe leer `business.freeDeliveryThreshold`
 * directamente — todos pasan por aquí.
 */
export function effectiveFreeDeliveryThreshold(
  business: FreeDeliveryTimingSource,
  now: Date,
  timeZone: string
): number {
  if (business.freeDeliveryThreshold <= 0) return 0;
  const availability = couponAvailability(freeDeliveryTiming(business), now, timeZone);
  return availability.state === 'active' ? business.freeDeliveryThreshold : 0;
}
