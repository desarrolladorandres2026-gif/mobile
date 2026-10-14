import { IPlatformPricingConfig } from '../models';
import { PRO_PLAN } from '../config/pro';
import { estimateGatewayFee } from '../utils/gatewayFee';
import { clampMoney, applyBps, assertMoney, LatLng } from '../utils';
import { pricingConfigService } from './pricingConfig.service';
import { pricingService } from './pricing.service';
import type { ProBenefitsSnapshot } from './pro.service';

/**
 * Simulación de rentabilidad de Zipp Pro, ANTES de abrir la venta.
 *
 * No es una segunda calculadora: el coste de cada pedido sale de
 * `pricingService.settleDiscounts` —la misma función con la que se cobra— con
 * y sin el trato de la membresía sobre el MISMO carrito, y la tarifa de
 * pasarela de `estimateGatewayFee`. Lo único que este archivo añade es
 * multiplicar por volúmenes y dividir entre el precio.
 *
 * Lo que la simulación NO sabe se dice en `missingData`, y lo que supone se
 * dice en `assumptions`: ninguna cifra de aquí es una decisión. Es el mapa de
 * lo que hay que medir para tomarla.
 */

export interface ProSimulationInput {
  /** Pedidos al mes de un socio a comparar (p. ej. 2, 4, 8, 12, 20). */
  ordersPerMonth: number[];
  /** Subtotal medio de productos de un pedido del socio, COP. Estimación. */
  averageSubtotal: number;
  /** Distancia media comercio→cliente. Estimación. */
  averageDistanceKm: number;
  /**
   * Fracción de sus pedidos que alcanza el mínimo de compra del plan (0–1).
   * 1 = peor caso: todos los pedidos regalan el domicilio.
   */
  eligibleShare: number;
}

export interface ProSimulationRow {
  ordersPerMonth: number;
  /** Pedidos del mes que sí reciben el beneficio (volumen × participación). */
  benefitOrders: number;
  /** Lo que regala ZIPP en el mes: domicilio + tarifa de servicio. */
  benefitCost: number;
  /** Cuota cobrada − comisión de pasarela de la cuota. */
  netFee: number;
  /**
   * netFee − benefitCost. Es el SUELO optimista: todavía sin reembolsos,
   * impuestos de la cuota ni ningún efecto en ventas (ver `missingData`).
   */
  contributionBeforeUnknowns: number;
}

export interface ProSimulation {
  plan: { price: number; minSubtotal: number; freeDelivery: boolean; serviceFeeWaived: boolean };
  /** Cómo sale UN pedido típico con y sin la membresía, calculado por el motor de precios. */
  perOrder: {
    deliveryFee: number;
    serviceFee: number;
    deliveryDiscount: number;
    serviceFeeDiscount: number;
    /** Lo que ZIPP regala por pedido que recibe el beneficio. */
    benefitCost: number;
    reachesMinimum: boolean;
  };
  /** Cuota mensual: bruto, comisión estimada de la pasarela y neto. */
  fee: { gross: number; gatewayFee: number; net: number; gatewayConfigured: boolean };
  /** Pedidos al mes en que el socio deja de ser rentable (null si el beneficio es 0). */
  breakEvenOrdersPerMonth: number | null;
  rows: ProSimulationRow[];
  /** Cifras que salen del código o de la configuración vigente. */
  confirmed: string[];
  /** Supuestos de esta corrida: cámbialos antes de confiar en el resultado. */
  assumptions: string[];
  /** Lo que falta medir para poder decidir. */
  missingData: string[];
}

/** El plan como lo ve el motor de precios, sin tocar la base. */
function planBenefits(): ProBenefitsSnapshot {
  const { freeDelivery, serviceFeeWaived } = PRO_PLAN.benefits;
  return {
    freeDelivery: freeDelivery.enabled,
    freeDeliveryMinSubtotal: freeDelivery.minSubtotal,
    serviceFeeWaived: serviceFeeWaived.enabled,
  };
}

/** Origen sintético: Garzón. La simulación mide la tarifa, no una calle. */
const REFERENCE_ORIGIN: LatLng = { lat: 2.1958, lng: -75.6258 };

export const proSimulationService = {
  /**
   * Lee la configuración vigente y simula. Es lo que expone el panel.
   */
  async simulate(input: ProSimulationInput): Promise<ProSimulation> {
    const cfg = await pricingConfigService.getCurrent();
    return this.simulateWith(cfg, input);
  },

  async simulateWith(cfg: IPlatformPricingConfig, input: ProSimulationInput): Promise<ProSimulation> {
    assertMoney(input.averageSubtotal, 'subtotal medio');
    if (input.eligibleShare < 0 || input.eligibleShare > 1) {
      throw new RangeError('La participación debe estar entre 0 y 1');
    }

    // La tarifa de domicilio del motor, no una fórmula paralela.
    const km = Math.max(0, Math.min(input.averageDistanceKm, cfg.maxRadiusMeters / 1000));
    const destination: LatLng = { lat: REFERENCE_ORIGIN.lat + km / 111.32, lng: REFERENCE_ORIGIN.lng };
    const delivery = await pricingService.priceRoute(REFERENCE_ORIGIN, destination, 'Garzón', cfg);

    const customerServiceFee = clampMoney(
      cfg.serviceFeeFixed + applyBps(input.averageSubtotal, cfg.serviceFeeBps),
      cfg.serviceFeeMin,
      cfg.serviceFeeMax
    );

    const base = {
      productSubtotal: input.averageSubtotal,
      deliveryCustomerFee: delivery.customerFee,
      deliveryMargin: delivery.margin,
      customerServiceFee,
      appliedCommissionBps: cfg.merchantCommissionBps,
      cfg,
      tip: 0,
      isCash: false,
      coupon: null,
      autoPromotionMerchantFunded: 0,
      freeDeliveryThreshold: 0,
    };

    // El mismo carrito, sin y con membresía.
    const withPro = pricingService.settleDiscounts({ ...base, pro: planBenefits() });

    const benefitCost = withPro.proDeliveryDiscount + withPro.proServiceFeeDiscount;
    const reachesMinimum = withPro.proDeliveryDiscount > 0 || withPro.proServiceFeeDiscount > 0;

    // La cuota: la paga con tarjeta (ver `ProService.subscribe`), así que la
    // tarifa de tarjeta es la que aplica.
    const gatewayFee = estimateGatewayFee(cfg, 'CARD', PRO_PLAN.price);
    const net = PRO_PLAN.price - gatewayFee;
    const gatewayConfigured = estimateGatewayFee(cfg, 'CARD', 100_000) > 0;

    const rows: ProSimulationRow[] = input.ordersPerMonth.map((ordersPerMonth) => {
      const benefitOrders = ordersPerMonth * input.eligibleShare;
      const cost = Math.round(benefitOrders * benefitCost);
      const contributionBeforeUnknowns = net - cost;
      return {
        ordersPerMonth,
        benefitOrders: Number(benefitOrders.toFixed(2)),
        benefitCost: cost,
        netFee: net,
        contributionBeforeUnknowns,
      };
    });

    const perBenefitOrderCost = benefitCost * input.eligibleShare;
    const breakEven = perBenefitOrderCost > 0 ? Math.floor(net / perBenefitOrderCost) : null;

    return {
      plan: {
        price: PRO_PLAN.price,
        minSubtotal: PRO_PLAN.benefits.freeDelivery.minSubtotal,
        freeDelivery: PRO_PLAN.benefits.freeDelivery.enabled,
        serviceFeeWaived: PRO_PLAN.benefits.serviceFeeWaived.enabled,
      },
      perOrder: {
        deliveryFee: delivery.customerFee,
        serviceFee: customerServiceFee,
        deliveryDiscount: withPro.proDeliveryDiscount,
        serviceFeeDiscount: withPro.proServiceFeeDiscount,
        benefitCost,
        reachesMinimum,
      },
      fee: { gross: PRO_PLAN.price, gatewayFee, net, gatewayConfigured },
      breakEvenOrdersPerMonth: breakEven,
      rows,
      confirmed: [
        `Precio de la cuota y mínimo de compra: salen de config/pro.ts ($${PRO_PLAN.price.toLocaleString('es-CO')} y $${PRO_PLAN.benefits.freeDelivery.minSubtotal.toLocaleString('es-CO')}); ambos siguen marcados TODO(negocio).`,
        'La tarifa de domicilio y la de servicio salen del motor de precios con la configuración vigente (priceRoute / settleDiscounts), no de una fórmula aparte.',
        gatewayConfigured
          ? 'La comisión de la pasarela sobre la cuota usa las tarifas configuradas (estimateGatewayFee).'
          : 'Las tarifas de Wompi están en 0 en la configuración: la comisión de la cuota sale como $0 y el neto está INFLADO.',
      ],
      assumptions: [
        `Pedido tipo: subtotal $${input.averageSubtotal.toLocaleString('es-CO')} a ${km} km del comercio (estimación, no medición).`,
        `${Math.round(input.eligibleShare * 100)}% de los pedidos del socio alcanza el mínimo del plan (1 = peor caso).`,
        'La tarifa del domicilio es la de la zona base de la configuración global; las zonas con tarifa propia cambian el coste.',
        'El socio paga con tarjeta (la membresía solo admite tarjeta).',
        'No se modela efecto en ventas: el pedido adicional que la membresía provoca (y su comisión) no se descuenta del coste.',
      ],
      missingData: [
        'Distribución real de pedidos por socio al mes, ticket medio y distancia media (hoy no hay socios con historial).',
        'Qué fracción de los pedidos de un socio alcanzaría el mínimo de $30.000.',
        'Tarifas contratadas con Wompi (porcentaje, fijo e IVA) si siguen en 0 en la configuración.',
        'Tratamiento tributario de la cuota (IVA y retenciones sobre el ingreso de la membresía).',
        'Tasa real de reembolsos, cancelaciones tardías y contracargos de pedidos de socios, y qué parte del beneficio (domicilio ya pagado al domiciliario) no se recupera cuando ocurren. La simulación NO los resta: el resultado es un techo.',
        'Efecto de la membresía en frecuencia de compra y retención (el beneficio puede pagarse solo, o no).',
        'Decisión comercial: tope mensual de envíos gratis por socio, que sigue sin definirse.',
      ],
    };
  },
};
