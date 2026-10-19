import { Types } from 'mongoose';
import { Business, Product, Zone, Coupon, IBusiness, ICoupon, IPlatformPricingConfig, IOrderFinance } from '../models';
import type { RefundAllocation, PriorAllocation } from './refund.service';
import { resolveModifierSelection } from '../utils/modifierSelection';
import { AppError } from '../middlewares';
import { PaymentMethod, CouponFundedBy, CouponScope, CouponType, SelectedExtra } from '../types';
import { config as envConfig } from '../config';
import {
  haversineMeters,
  isValidCoordinate,
  fromGeoPoint,
  roundToStep,
  applyBps,
  clampMoney,
  assertMoney,
  effectiveFreeDeliveryThreshold,
  LatLng,
} from '../utils';
import { estimateGatewayFee } from '../utils/gatewayFee';
import { estimateRoute } from './mapbox.service';
import { couponService, AppliedCoupon } from './coupon.service';
import { pricingConfigService } from './pricingConfig.service';
import { proService, type ProBenefitsSnapshot } from './pro.service';
import { taxRuleService, type CheckoutTaxPlan } from './taxRule.service';
import type { TaxBase } from '../models/TaxRule';

/** Cocina, cuando el comercio no declaró tiempo. */
const DEFAULT_PREP_MINUTES = 25;
/** Viaje, cuando el negocio no tiene ubicación válida. */
const DEFAULT_TRAVEL_MINUTES = 15;
/** Aparcar, subir y entregar. No sale en ninguna ruta y siempre pasa. */
const HANDOFF_MINUTES = 5;
/** Ancho del rango como fracción del tiempo estimado. */
const SPREAD_RATIO = 0.35;
/** Ancho mínimo del rango: nadie entrega puntual al minuto. */
const SPREAD_FLOOR_MINUTES = 10;

/**
 * Cuánto ahorro extra del cliente (COP enteros) se cede para no gastar de la
 * caja de ZIPP: dentro de esta banda, un cupón que paga el comercio le gana
 * a uno de plataforma aunque descuente algo menos.
 *
 * TODO(negocio): 2000 es un valor conservador, no una decisión. Con 0 el
 * sugeridor vuelve a ser "el que más ahorra, sin más"; más alto, cede más
 * ahorro del cliente a cambio de subsidiar menos.
 */
export const COUPON_FUNDING_TIE_BAND = 2000;

export interface QuoteItemInput {
  productId: string;
  quantity: number;
  /**
   * Adicionales elegidos. Con `optionId` es una opción de un grupo de
   * modificadores; sin él, un `extra` plano elegido por nombre.
   */
  selectedExtras?: Array<{ name?: string; quantity?: number; groupId?: string; optionId?: string }>;
  notes?: string;
}

export interface QuoteInput {
  userId: string;
  businessId: string;
  items: QuoteItemInput[];
  deliveryLatitude: number;
  deliveryLongitude: number;
  paymentMethod: PaymentMethod;
  couponCode?: string;
  tip?: number;
  /**
   * Buscar el mejor cupón para este carrito si no trae ninguno.
   *
   * Encendido por defecto porque la cotización se pide mientras alguien
   * mira el checkout, que es cuando la sugerencia sirve. La creación del
   * pedido lo apaga: ahí ya se decidió, y buscar un cupón que nadie va a
   * leer solo añade consultas en el momento de más prisa.
   */
  suggest?: boolean;
}

export interface PricedItem {
  productId: Types.ObjectId;
  productName: string;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
  selectedExtras: SelectedExtra[];
  notes: string;
}

export interface DeliveryQuote {
  /** What the customer is charged for delivery. */
  customerFee: number;
  /** What the driver is guaranteed, before tip. Never reduced by promos. */
  driverPayout: number;
  /** customerFee − driverPayout. Negative means the platform subsidises. */
  margin: number;
  distanceMeters: number;
  distanceKm: number;
  zoneId: Types.ObjectId | null;
  zoneName: string | null;
  /**
   * Versión de la tarifa de la zona con la que se cotizó (D9). El pedido la
   * guarda junto a `zoneId` para poder explicarse después. `null` sin zona.
   */
  zoneVersion: number | null;
  /** Pedido mínimo de la zona, leído del mismo documento que la tarifa. */
  zoneMinOrder: number;
}

/**
 * El cupón que más ahorraría en este carrito, si hay alguno y el cliente no
 * trajo ninguno puesto.
 */
export interface SuggestedCoupon {
  code: string;
  title: string;
  /** Lo que descontaría, ya calculado contra este carrito. */
  discount: number;
}

/** The complete, auditable money breakdown for a cart. */
export interface Quote {
  items: PricedItem[];
  /**
   * Presente cuando la guarda de margen quitó un beneficio de Zipp Pro de ESTE
   * pedido (M-012). El checkout lo enseña antes de confirmar: ningún beneficio
   * anunciado se pierde en silencio.
   */
  proBenefitNotice?: ProGuardResult | null;
  /**
   * De dónde salió el impuesto (M-014): `definitive` = reglas validadas por
   * concepto; `legacy` = tasa global sin validar; `provisional` = las reglas están
   * encendidas pero falta una vigente y se usó la tasa global.
   */
  taxStatus?: TaxStatus;
  taxBreakdown?: TaxLine[];
  /** Consumer-facing aliases; all values are calculated by this service. */
  precioOriginal?: number;
  descuentoEnvio?: number;
  totalUsuario?: number;
  subsidioPlataforma?: number;
  subsidioComercio?: number;

  // ── Snapshot fields (persisted verbatim onto the order) ──
  productSubtotal: number;
  merchantCommission: number;
  customerServiceFee: number;
  deliveryCustomerFee: number;
  /** Lo que el cliente paga de domicilio tras cupón y envío gratis. */
  deliveryPayable: number;
  /** El comercio regaló el domicilio por haber alcanzado su compra mínima. */
  freeDeliveryApplied: boolean;
  /** Lo que costó ese domicilio regalado (dentro de `merchantFundedDiscount`). */
  freeDeliveryDiscount: number;
  /**
   * Lo que la membresía Zipp Pro le quitó a este pedido. Lo financia ZIPP,
   * así que ya está contado dentro de `platformFundedDiscount`; viaja
   * aparte solo para que el checkout pueda decir de dónde viene el ahorro.
   */
  proDeliveryDiscount: number;
  proServiceFeeDiscount: number;
  driverDeliveryPayout: number;
  deliveryMargin: number;
  tip: number;
  merchantFundedDiscount: number;
  platformFundedDiscount: number;
  taxPayable: number;
  businessPayout: number;
  driverPayout: number;
  platformGrossRevenue: number;
  platformPromotionExpense: number;
  platformNetRevenueBeforeOperatingCosts: number;
  customerTotal: number;
  currency: string;
  pricingConfigVersion: number;
  appliedCommissionBps: number;

  // ── Presentation helpers ──
  /** Extremo optimista de la promesa de entrega, en minutos desde ahora. */
  etaMinutesMin: number;
  /** Extremo que se promete al cliente. Es el que hay que cumplir. */
  etaMinutesMax: number;
  deliveryDistanceKm: number;
  zoneId: Types.ObjectId | null;
  zoneName: string | null;
  zoneVersion: number | null;
  coupon: AppliedCoupon | null;
  /**
   * Solo cuando el carrito no trae cupón: el mejor que podría llevar. Se
   * ofrece, no se aplica — quien decide gastar un cupón de un solo uso es
   * el cliente, no nosotros.
   */
  suggestedCoupon: SuggestedCoupon | null;
  /**
   * Promociones automáticas por producto que aplicaron a este carrito, sin
   * que el cliente escribiera ningún código. `order.service.ts` las canjea
   * una por una tras crear el pedido.
   */
  appliedAutoPromotions: Array<{ couponId: string; discountAmount: number }>;
  /** Suma de `appliedAutoPromotions`, para que el checkout la enseñe sin saber qué es una promoción automática. */
  promotionDiscount: number;
  minOrder: number;
  /** Cash a driver would have to remit. 0 for digital orders. */
  cashToRemit: number;
  /**
   * Hay productos +18 en el carrito. El pedido exige fecha de nacimiento y
   * mayoría de edad (ver `orderService.create`), y el domiciliario pide la
   * cédula en la puerta.
   */
  requiresAgeVerification: boolean;

  // ── Legacy aliases, kept so existing clients keep working ──
  subtotal: number;
  deliveryFee: number;
  discount: number;
  tax: number;
  total: number;
  platformCommission: number;
}

/**
 * Lo que `settleDiscounts` entrega: el reparto completo del dinero de un
 * carrito para un cupón (o ninguno). Es la única fuente de cifras que
 * comparten la cotización, el sugeridor y la previsualización.
 */
export interface SettledDiscounts {
  freeDeliveryDiscount: number;
  payableDelivery: number;
  /** Lo que Zipp Pro le quitó al envío. Sale del bolsillo de ZIPP. */
  proDeliveryDiscount: number;
  /** Lo que Zipp Pro le quitó a la tarifa de servicio. Íd. */
  proServiceFeeDiscount: number;
  merchantFundedDiscount: number;
  merchantCommission: number;
  platformFundedDiscount: number;
  platformGrossRevenue: number;
  platformNetRevenueBeforeOperatingCosts: number;
  /**
   * Lo que el cliente paga por los productos tras los descuentos que los
   * afectan (cupón de producto y promociones automáticas). Es la base del
   * umbral de envío gratis y del mínimo de Zipp Pro: ni el domicilio ni la
   * tarifa de servicio ni sus descuentos entran.
   */
  payableSubtotal: number;
  payableServiceFee: number;
  taxPayable: number;
  customerTotal: number;
  /**
   * Lo que le queda al comercio: productos − lo que financia − comisión.
   * Sin recortar a cero a propósito: un valor negativo es una combinación de
   * descuentos que el comercio no puede pagar, y `assertBalanced` no lo
   * detectaría si se escondiera bajo un `Math.max`.
   */
  merchantPayout: number;
  /**
   * El domicilio ya sale gratis por el umbral del comercio o por Zipp Pro,
   * con independencia de cualquier cupón de domicilio.
   */
  deliveryAlreadyFree: boolean;
  /** Comisión de pasarela estimada del cobro. 0 en efectivo o sin tarifa configurada. */
  estimatedGatewayFee: number;
  taxStatus: TaxStatus;
  taxBreakdown: TaxLine[];
  /**
   * Resultado de la guarda de margen de Zipp Pro (M-012). `null` cuando el
   * trato de Pro se aplicó tal cual o la persona no tiene Pro. Si no es `null`,
   * al menos un beneficio se quitó de ESTE pedido para que ZIPP no lo pagara a
   * pérdida, y aquí está cuál y por qué.
   */
  proGuard: ProGuardResult | null;
}

/**
 * Una línea del impuesto de un pedido (M-014): qué regla, a qué tarifa y sobre qué
 * importe. Con la tasa global (`legacy`) no hay líneas: es una sola cifra sin
 * regla que la respalde.
 */
export interface TaxLine {
  concept: 'products' | 'delivery' | 'service_fee';
  ruleId: string;
  rateBps: number;
  base: TaxBase;
  baseAmount: number;
  amount: number;
}

/** De dónde salió el impuesto de un pedido. */
export type TaxStatus = 'legacy' | 'definitive' | 'provisional';

/**
 * El impuesto de un pedido, concepto por concepto, cuando hay reglas; o la tasa
 * global sobre la suma cuando no. Pura: es la ÚNICA fórmula del impuesto del
 * checkout, y la usan la cotización, el sugeridor, la previsualización y el
 * reprecio de un faltante.
 */
export function computeCheckoutTax(input: {
  plan?: CheckoutTaxPlan | null;
  legacyBps: number;
  /** Lo que el cliente paga por cada concepto tras descuentos. */
  net: { products: number; delivery: number; service_fee: number };
  /** Lo mismo antes de descuentos. */
  gross: { products: number; delivery: number; service_fee: number };
}): { taxPayable: number; lines: TaxLine[]; status: TaxStatus } {
  const { plan, legacyBps, net, gross } = input;
  if (plan?.mode === 'rules') {
    const lines: TaxLine[] = [];
    for (const concept of ['products', 'delivery', 'service_fee'] as const) {
      const rate = plan.rates[concept];
      if (!rate) continue;
      const baseAmount = Math.max(0, rate.base === 'gross' ? gross[concept] : net[concept]);
      lines.push({ concept, ruleId: rate.ruleId, rateBps: rate.bps, base: rate.base, baseAmount, amount: applyBps(baseAmount, rate.bps) });
    }
    return { taxPayable: lines.reduce((sum, l) => sum + l.amount, 0), lines, status: 'definitive' };
  }
  return {
    taxPayable: applyBps(net.products + net.delivery + net.service_fee, legacyBps),
    lines: [],
    status: plan?.status === 'provisional' ? 'provisional' : 'legacy',
  };
}

/** Los beneficios de Zipp Pro que la guarda de margen puede quitar de un pedido. */
export type ProBenefitKey = 'freeDelivery' | 'serviceFeeWaived';

export interface ProGuardResult {
  code: 'PRO_NEGATIVE_MARGIN';
  /** Lo que se quitó, no lo que quedó. */
  skipped: ProBenefitKey[];
  /** Margen del pedido con el trato completo de Pro (negativo: por eso se ajustó). */
  marginWithFullBenefit: number;
  /** Margen del pedido tal como se cobra. */
  marginApplied: number;
  /** Frase para mostrarle al cliente en el checkout. */
  message: string;
}

/**
 * Margen mínimo por pedido para que ZIPP pague un beneficio de Zipp Pro.
 *
 * Es el margen DEL PEDIDO —lo que el pedido deja a ZIPP tras lo que le cuestan
 * los descuentos y la pasarela—, no el del cliente en el mes: la cuota mensual
 * de la membresía es un ingreso aparte que no se reparte entre pedidos, y un
 * beneficio que solo se paga con la cuota de otro mes es un subsidio, no un
 * beneficio autofinanciado. 0 = el pedido nunca puede dar pérdida por culpa de Pro.
 */
export const PRO_MIN_ORDER_MARGIN = 0;

/** Lo que `settleDiscounts` necesita y no depende del cupón ni de las promociones. */
export interface SettleBase {
  /** Subtotal BRUTO de productos, antes de cualquier descuento. */
  productSubtotal: number;
  deliveryCustomerFee: number;
  deliveryMargin: number;
  customerServiceFee: number;
  appliedCommissionBps: number;
  cfg: IPlatformPricingConfig;
  /** El trato de Zipp Pro, si esta persona lo tiene pagado hoy. */
  pro: ProBenefitsSnapshot | null;
  /** Propina ya normalizada. */
  tip: number;
  /** Pago contra entrega: no genera comisión de pasarela. */
  isCash: boolean;
  /** Cómo se calcula el impuesto (M-014). Ausente = tasa global, como siempre. */
  taxPlan?: CheckoutTaxPlan | null;
}

export interface SettleParts extends SettleBase {
  coupon: AppliedCoupon | null;
  /**
   * Lo que descontó una promoción automática por producto, ya resuelto
   * por `applyAutoPromotions`. Siempre financiado por el comercio: el
   * modelo `Coupon` obliga a que `autoApply` sea `scope: PRODUCT` y
   * excluye por eso mismo `fundedBy: PLATFORM` para este modo.
   */
  autoPromotionMerchantFunded: number;
  /** Umbral de envío gratis vigente y financiable; 0 = no se regala. */
  freeDeliveryThreshold: number;
}

/** Una promoción tal como el comercio (o el administrador) la está armando. */
export interface PromotionDraft {
  type: CouponType;
  scope?: CouponScope;
  value: number;
  maxDiscount?: number;
  maxDiscountAmount?: number;
  minOrderAmount?: number;
  autoApply?: boolean;
  firstOrderOnly?: boolean;
  budgetLimit?: number;
  usageLimit?: number;
  perUserLimit?: number;
  validFrom?: Date;
  validUntil?: Date;
  /** Solo lo respeta la previsualización del administrador. */
  fundedBy?: CouponFundedBy;
  minimumContributionMargin?: number;
  campaignApproved?: boolean;
}

export interface PromotionPreviewInput {
  businessId: string;
  /** La promoción a evaluar; sin ella solo se evalúa el envío gratis. */
  draft?: PromotionDraft | null;
  /** Umbral de envío gratis a evaluar en lugar del guardado (borrador). */
  freeDeliveryThreshold?: number;
  /** Subtotales de producto a simular, ya enteros en COP. */
  subtotals: number[];
  distanceKm?: number;
  paymentMethod: PaymentMethod;
  /** El administrador puede simular una campaña financiada por ZIPP; el comercio no. */
  allowPlatformFunding?: boolean;
}

export interface PreviewWarning {
  code: string;
  message: string;
}

export interface PreviewScenario {
  productSubtotal: number;
  promotionApplied: boolean;
  freeDeliveryApplied: boolean;
  productDiscount: number;
  payableSubtotal: number;
  deliveryFee: number;
  deliveryPayable: number;
  serviceFee: number;
  tax: number;
  customerTotal: number;
  customerSaving: number;
  merchantFunded: number;
  platformFunded: number;
  merchantCommission: number;
  merchantPayout: number;
  merchantPayoutWithoutPromotion: number;
  driverPayout: number;
  platformGrossRevenue: number;
  platformNet: number;
  estimatedGatewayFee: number;
  platformNetAfterGateway: number;
  warnings: PreviewWarning[];
}

export interface PromotionPreview {
  valid: boolean;
  errors: string[];
  assumptions: string[];
  scenarios: PreviewScenario[];
}

/** Por qué un cupón no puede combinarse con el resto del pedido. */
export interface CouponConflict {
  code: 'COUPON_EXCEEDS_MERCHANT_PAYOUT' | 'DELIVERY_ALREADY_FREE';
  message: string;
}

/** Raised when the books do not balance. Never surfaced as a price. */
export class QuoteImbalanceError extends Error {
  constructor(
    readonly expected: number,
    readonly actual: number,
    readonly detail: Record<string, number>
  ) {
    super(
      `La cotización no cuadra: cliente+subsidio=${expected} vs ` +
        `payouts+ingresos+impuestos=${actual}`
    );
    this.name = 'QuoteImbalanceError';
  }
}

/**
 * The single source of truth for what an order costs.
 *
 * Both the checkout preview (POST /orders/quote) and order creation run
 * through here, so the price the customer is shown is by construction the
 * price that gets charged. Clients never compute money.
 *
 * Every amount is a whole number of COP and every rate is basis points.
 * The final breakdown is checked against a double-entry identity before it
 * is returned — an unbalanced quote is a bug, and it fails loudly rather
 * than quietly charging someone the wrong amount.
 */
export class PricingService {
  /**
   * Si un pedido con estas cifras puede cobrarse en efectivo.
   *
   * Vive aquí, y no repetido en cada sitio que ofrece el método, porque
   * son dos reglas que se comprueban en momentos muy distintos —al
   * cotizar el carrito y al cambiar de método sobre un pedido ya
   * creado— y una copia desactualizada de cualquiera de las dos abre un
   * agujero silencioso:
   *
   *  · El tope de efectivo limita cuánto dinero ajeno puede acabar en el
   *    bolsillo de una persona en la calle.
   *  · Un `cashToRemit` negativo significa que la promoción se comió el
   *    ingreso de la plataforma: nadie tendría de dónde sacar la comisión,
   *    y el pedido acabaría con una deuda imposible de conciliar.
   */
  async assertCashEligible(params: {
    customerTotal: number;
    businessPayout: number;
    driverPayout: number;
  }): Promise<void> {
    const cfg = await pricingConfigService.getCurrent();

    if (!cfg.cashOnDeliveryEnabled) {
      throw new AppError(
        'El pago contra entrega no está disponible por el momento. Elige pago en línea.',
        422
      );
    }

    const cashToRemit = params.customerTotal - params.businessPayout - params.driverPayout;
    if (cashToRemit < 0) {
      throw new AppError(
        'Este pedido no puede pagarse en efectivo: la promoción supera el ' +
          'ingreso de la plataforma. Elige pago en línea.',
        422
      );
    }

    if (params.customerTotal > cfg.cashOnDeliveryMaxAmount) {
      throw new AppError(
        `El pago contra entrega admite hasta $${cfg.cashOnDeliveryMaxAmount.toLocaleString('es-CO')}. ` +
          'Elige pago en línea.',
        422
      );
    }
  }

  /**
   * Prices the cart items against the database.
   *
   * Every price — product unit price AND extras — is read from the product
   * record. Client-supplied prices are ignored entirely: trusting them let a
   * crafted request send a negative extra price and drive the total to zero.
   * The client only chooses *which* extras, by name, and how many.
   */
  async priceItems(businessId: string, items: QuoteItemInput[]): Promise<{
    pricedItems: PricedItem[];
    subtotal: number;
    /**
     * El más lento de los platos pedidos, o `null` si ninguno declaró uno
     * propio. La cocina no entrega por partes: un pedido con un asado de
     * 40 minutos y una gaseosa no sale en el tiempo de la gaseosa.
     */
    maxPrepMinutes: number | null;
    /** Algún producto es solo para mayores de 18 (licor, cigarrillos). */
    requiresAgeVerification: boolean;
  }> {
    if (!items || items.length === 0) {
      throw new AppError('El pedido debe tener al menos un producto', 400);
    }

    const productIds = items.map((i) => i.productId);
    const products = await Product.find({ _id: { $in: productIds } });
    const productMap = new Map(products.map((p) => [p._id.toString(), p]));

    let subtotal = 0;
    let maxPrepMinutes: number | null = null;
    const pricedItems: PricedItem[] = [];

    for (const item of items) {
      const product = productMap.get(item.productId);

      if (!product) throw new AppError('Uno de los productos ya no existe', 404);
      if (!product.isAvailable) {
        throw new AppError(`"${product.name}" no está disponible en este momento`, 400);
      }
      if (product.businessId.toString() !== businessId) {
        throw new AppError('Un producto no pertenece a este negocio', 400);
      }
      if (!Number.isInteger(item.quantity) || item.quantity < 1) {
        throw new AppError(`Cantidad inválida para "${product.name}"`, 400);
      }

      const unitPrice = Math.round(product.discountPrice ?? product.price);

      if (typeof product.prepTimeMinutes === 'number') {
        maxPrepMinutes = Math.max(maxPrepMinutes ?? 0, product.prepTimeMinutes);
      }

      // Resolve each requested extra against the product's own catalogue.
      const resolvedExtras: PricedItem['selectedExtras'] = [];
      let extrasTotal = 0;

      // Los grupos van por su propia regla (mínimos, máximos, agotados);
      // lo que llega sin `optionId` es un `extra` plano de toda la vida.
      const requestedExtras = item.selectedExtras || [];
      const modifiers = resolveModifierSelection(
        product,
        requestedExtras.filter((e) => e.groupId || e.optionId)
      );
      resolvedExtras.push(...modifiers.lines);
      extrasTotal += modifiers.total;

      for (const requested of requestedExtras) {
        if (requested.groupId || requested.optionId) continue;
        const known = product.extras.find((e) => e.name === requested.name);
        if (!known) {
          throw new AppError(
            `El adicional "${requested.name}" no existe para "${product.name}"`,
            400
          );
        }

        const extraQuantity = requested.quantity ?? 1;
        if (!Number.isInteger(extraQuantity) || extraQuantity < 1) {
          throw new AppError(`Cantidad inválida para el adicional "${known.name}"`, 400);
        }

        const extraPrice = Math.round(known.price); // authoritative, from the DB
        resolvedExtras.push({
          name: known.name,
          price: extraPrice,
          quantity: extraQuantity,
        });
        extrasTotal += extraPrice * extraQuantity;
      }

      const totalPrice = (unitPrice + extrasTotal) * item.quantity;
      subtotal += totalPrice;

      pricedItems.push({
        productId: product._id,
        productName: product.name,
        quantity: item.quantity,
        unitPrice,
        totalPrice,
        selectedExtras: resolvedExtras,
        notes: (item.notes || '').slice(0, 200),
      });
    }

    // Sale de los productos ya cargados: la cotización lo avisa sin otra
    // consulta, y el checkout pide la fecha de nacimiento antes de confirmar.
    const requiresAgeVerification = products.some((p) => p.requiresAgeVerification === true);

    return { pricedItems, subtotal: assertMoney(subtotal, 'subtotal'), maxPrepMinutes, requiresAgeVerification };
  }

  /**
   * Resuelve las promociones automáticas por producto contra el carrito ya
   * cotizado, sin código.
   *
   * A propósito no vive dentro de `priceItems()`: hornear el descuento en
   * `unitPrice` ahí reduciría `productSubtotal`, y `merchantFundedDiscount`
   * lo volvería a restar de `businessPayout` más abajo — cobrándole al
   * comercio el mismo descuento dos veces. En vez de eso, se trata como un
   * descuento paralelo al cupón de código, con la misma aritmética pura
   * (`computeDiscount`) y el mismo reparto financiero.
   *
   * Una promoción puede cubrir varias líneas del carrito (dos productos
   * distintos con la misma promoción): se agrupan por cupón y el
   * porcentaje/valor se calcula contra la suma de esas líneas, no línea por
   * línea, para que un tope (`maxDiscountAmount`) se aplique al conjunto y
   * no se triplique si el cliente pidió tres unidades en líneas separadas.
   */
  private async applyAutoPromotions(
    pricedItems: PricedItem[],
    autoPromotions: Map<string, ICoupon>,
    input: { userId: string; businessId: string },
    cfg: IPlatformPricingConfig,
    /**
     * Si el comercio puede pagar este total de promociones automáticas sin
     * quedar con un pago negativo. Lo resuelve `quote()` con la misma
     * aritmética con la que se cobra: aquí solo se pregunta.
     */
    canFund: (totalAutoDiscount: number) => boolean
  ): Promise<{ appliedAutoPromotions: Array<{ couponId: string; discountAmount: number }>; autoPromotionDiscount: number }> {
    const groups = new Map<string, { coupon: ICoupon; base: number }>();

    for (const item of pricedItems) {
      const promo = autoPromotions.get(item.productId.toString());
      if (!promo) continue;

      const key = promo._id.toString();
      const group = groups.get(key);
      if (group) group.base += item.totalPrice;
      else groups.set(key, { coupon: promo, base: item.totalPrice });
    }

    const appliedAutoPromotions: Array<{ couponId: string; discountAmount: number }> = [];
    let autoPromotionDiscount = 0;

    for (const { coupon, base } of groups.values()) {
      if (!(await couponService.autoPromotionUsableBy(coupon, input.userId, base))) continue;
      const applied = couponService.computeDiscount(
        coupon,
        {
          userId: input.userId,
          businessId: input.businessId,
          subtotal: base,
          deliveryFee: 0,
          serviceFee: 0,
        },
        cfg
      );
      if (applied.productDiscount <= 0) continue;

      // Una promoción que ya no cabe en su presupuesto no se ofrece: de lo
      // contrario la cotización la mostraría y el canje la rechazaría con un
      // 409 al confirmar el pedido.
      if (!couponService.fitsBudget(coupon, applied.merchantFunded)) continue;

      // Una promoción automática nunca debe volver inviable el pedido: si el
      // comercio no puede pagarla junto con las que ya aplican, no se aplica
      // (y por tanto tampoco aparece en el checkout). El cliente no escribió
      // nada que pudiera rechazarse con un error.
      if (!canFund(autoPromotionDiscount + applied.productDiscount)) continue;

      appliedAutoPromotions.push({ couponId: coupon._id.toString(), discountAmount: applied.productDiscount });
      autoPromotionDiscount += applied.productDiscount;
    }

    return {
      appliedAutoPromotions,
      autoPromotionDiscount: assertMoney(autoPromotionDiscount, 'descuento de promociones automáticas'),
    };
  }

  /**
   * Prices delivery from the business to the drop-off point.
   *
   * Two numbers come out of this, and keeping them distinct is the whole
   * point of the redesign:
   *
   *  - `driverPayout` is what the courier is guaranteed. It is a floor, so
   *    promotions, caps and rounding can only ever move it up.
   *  - `customerFee` is what the customer is charged: the driver's fee plus
   *    the platform's configured margin, then clamped to the customer-facing
   *    bounds.
   *
   * When the clamp bites, the margin absorbs it — including going negative,
   * which books as a real platform loss rather than silently shaving the
   * driver's pay.
   *
   * Zone overrides describe the *cost of serving that zone*, so they raise
   * the driver's guarantee; the platform margin then applies on top.
   */
  /**
   * La ventana de entrega que se le promete al cliente antes de pagar.
   *
   * Hasta ahora el checkout no decía ningún tiempo: se pagaba sin saber
   * cuándo llegaba la comida, que es la información que más pesa en la
   * decisión de comprar.
   *
   * Se compone de tres piezas, y ninguna es adivinada:
   *  - **Cocina**: `business.deliveryTime`, los minutos que declara el
   *    comercio. Es un dato blando —lo escribe él y nadie lo contrasta—
   *    pero es el único que existe hoy.
   *  - **Viaje**: `estimateRoute`, que es matemática pura sobre la
   *    distancia con factor de rodeo. **No llama a Mapbox a propósito**:
   *    el quote se recalcula con cada cambio del carrito, y meter una
   *    petición de red ahí sería pagar y esperar por cada tecla.
   *  - **Puerta**: un margen fijo para aparcar, subir y entregar, que no
   *    aparece en ninguna ruta y siempre existe.
   *
   * Se devuelve como rango y no como número exacto porque un número exacto
   * es una promesa que se incumple el 90% de las veces. El extremo alto es
   * el que se enseña y el que hay que cumplir.
   */
  deliveryWindow(
    business: IBusiness,
    destination: LatLng,
    /**
     * El tiempo de cocina del plato más lento del carrito, si alguno lo
     * declaró. Sin esto, la promesa de entrega ignoraba por completo qué se
     * pidió: un asado de 45 minutos prometía lo mismo que una gaseosa.
     */
    prepMinutesOverride?: number | null
  ): { min: number; max: number } {
    const origin = fromGeoPoint(business.location);

    const prepMinutes = Math.max(
      0,
      prepMinutesOverride ?? (business.deliveryTime || DEFAULT_PREP_MINUTES)
    );
    const travelMinutes = origin
      ? Math.round(estimateRoute(origin, destination).durationSeconds / 60)
      : DEFAULT_TRAVEL_MINUTES;

    const min = prepMinutes + travelMinutes + HANDOFF_MINUTES;

    // La incertidumbre crece con el tamaño del viaje: en un pedido de 15
    // minutos un rango de 10 es absurdo, y en uno de una hora un rango de
    // 10 es optimismo. Con suelo, porque ningún pedido es puntual al
    // minuto.
    const spread = Math.max(SPREAD_FLOOR_MINUTES, Math.round(min * SPREAD_RATIO));

    return { min, max: min + spread };
  }

  async priceDelivery(
    business: IBusiness,
    destination: LatLng,
    cfg: IPlatformPricingConfig
  ): Promise<DeliveryQuote> {
    const origin = fromGeoPoint(business.location);
    if (!origin) {
      throw new AppError('Este negocio no tiene una ubicación válida configurada', 409);
    }

    return this.priceRoute(origin, destination, business.city, cfg);
  }

  /**
   * El precio de llevar algo de un punto a otro, sin comercio de por medio.
   *
   * Es el mismo cálculo que `priceDelivery` con el origen desacoplado: un
   * mandado se cobra exactamente igual que un domicilio porque el trabajo
   * del domiciliario es exactamente el mismo — recorrer una distancia. Que
   * en un extremo haya un restaurante afiliado o la casa de la abuela no
   * cambia el esfuerzo ni el combustible.
   *
   * Tener una sola fórmula importa: dos tarifas separadas se desincronizan
   * a la primera subida de gasolina, y entonces el domiciliario cobra menos
   * por el mismo viaje según cómo lo pidieran.
   */
  async priceRoute(
    origin: LatLng,
    destination: LatLng,
    city: string,
    cfg: IPlatformPricingConfig
  ): Promise<DeliveryQuote> {

    const distanceMeters = haversineMeters(origin, destination);

    if (distanceMeters > cfg.maxRadiusMeters) {
      throw new AppError(
        `La dirección está fuera de nuestra cobertura (${(distanceMeters / 1000).toFixed(1)} km). ` +
          `Entregamos hasta ${(cfg.maxRadiusMeters / 1000).toFixed(0)} km.`,
        422
      );
    }

    const zone = await this.findZone(destination, city);

    const baseFee = Math.round(zone?.baseFee ?? cfg.driverBaseFee);
    const perKm = Math.round(zone?.perKm ?? cfg.driverPerKm);
    const surcharge = Math.round(zone?.surcharge ?? 0);

    const billableMeters = Math.max(0, distanceMeters - cfg.freeRadiusMeters);
    const distanceComponent = Math.round((billableMeters * perKm) / 1000);

    // The driver's guarantee: a floor, never a ceiling.
    const driverPayout = roundToStep(
      Math.max(baseFee + distanceComponent + surcharge, cfg.driverMinFee),
      cfg.deliveryRoundingStep
    );

    const margin = cfg.deliveryMarginFixed + applyBps(driverPayout, cfg.deliveryMarginBps);

    const customerFee = roundToStep(
      clampMoney(driverPayout + margin, cfg.deliveryMinFee, cfg.deliveryMaxFee),
      cfg.deliveryRoundingStep
    );

    return {
      customerFee: assertMoney(customerFee, 'domicilio'),
      driverPayout: assertMoney(driverPayout, 'pago al repartidor'),
      margin: customerFee - driverPayout,
      distanceMeters,
      distanceKm: Number((distanceMeters / 1000).toFixed(2)),
      zoneId: zone ? (zone._id as Types.ObjectId) : null,
      zoneName: zone ? zone.name : null,
      // Una zona anterior al versionado no trae `version`: es la 1.
      zoneVersion: zone ? (zone.version ?? 1) : null,
      zoneMinOrder: zone?.minOrder ?? 0,
    };
  }

  /**
   * El piso real del domicilio de un negocio: el "Desde $X" de su ficha.
   *
   * Es `priceRoute` con origen y destino en el propio local. Distancia cero
   * significa que no hay componente por kilómetro, así que lo que queda es
   * la tarifa base de su zona (o la global), el recargo de zona, el mínimo
   * al domiciliario, el margen de la plataforma y el redondeo. Ninguna
   * entrega de ese negocio puede costar menos que esto.
   *
   * Importa que salga de la misma función que cobra el checkout y no de una
   * fórmula paralela: dos cuentas del mismo precio se desincronizan a la
   * primera subida de la gasolina, y entonces la ficha promete una cosa y
   * el carrito cobra otra.
   *
   * Devuelve `null` en vez de lanzar. Es un adorno de la ficha: un negocio
   * sin ubicación válida o una zona mal configurada tienen que dejar la
   * celda vacía, nunca romper la pantalla del cliente.
   */
  async minimumDeliveryFee(business: IBusiness): Promise<number | null> {
    const origin = fromGeoPoint(business.location);
    if (!origin) return null;

    try {
      const cfg = await pricingConfigService.getCurrent();
      const quote = await this.priceRoute(origin, origin, business.city, cfg);
      return quote.customerFee;
    } catch {
      return null;
    }
  }

  /** Finds the active zone containing a point, preferring higher priority. */
  private async findZone(point: LatLng, city?: string) {
    const filter: Record<string, unknown> = {
      isActive: true,
      area: {
        $geoIntersects: {
          $geometry: { type: 'Point', coordinates: [point.lng, point.lat] },
        },
      },
    };
    if (city) filter.city = city;

    return Zone.findOne(filter).sort({ priority: -1 });
  }

  /** Resolves the commission rate: business override → category → global. */
  private resolveCommissionBps(business: IBusiness, cfg: IPlatformPricingConfig): number {
    if (typeof business.commissionRateBps === 'number' && business.commissionRateBps >= 0) {
      return business.commissionRateBps;
    }
    const byCategory = cfg.categoryCommissionBps?.get?.(business.category);
    if (typeof byCategory === 'number') return byCategory;
    return cfg.merchantCommissionBps;
  }

  /** Builds the complete, authoritative quote for a cart. */
  async quote(input: QuoteInput): Promise<Quote> {
    if (!isValidCoordinate(input.deliveryLatitude, input.deliveryLongitude)) {
      throw new AppError(
        'La dirección de entrega no tiene una ubicación válida. Selecciónala en el mapa.',
        400
      );
    }

    const cfg = await pricingConfigService.getCurrent();

    const business = await Business.findById(input.businessId);
    if (!business || !business.isActive) {
      throw new AppError('Negocio no encontrado o inactivo', 404);
    }

    const isCash = input.paymentMethod === PaymentMethod.CASH_ON_DELIVERY;
    if (isCash && !cfg.cashOnDeliveryEnabled) {
      throw new AppError(
        'El pago contra entrega no está disponible por el momento. Elige pago en línea.',
        422
      );
    }

    const destination: LatLng = {
      lat: input.deliveryLatitude,
      lng: input.deliveryLongitude,
    };

    const { pricedItems, subtotal: productSubtotal, maxPrepMinutes, requiresAgeVerification } = await this.priceItems(
      input.businessId,
      input.items
    );

    const delivery = await this.priceDelivery(business, destination, cfg);
    const eta = this.deliveryWindow(business, destination, maxPrepMinutes);

    // Sale del mismo documento de zona que la tarifa y la versión: una
    // segunda lectura podía ver una zona editada a mitad de la cotización.
    const minOrder = Math.max(business.minOrder || 0, delivery.zoneMinOrder);

    if (minOrder && productSubtotal < minOrder) {
      throw new AppError(`El pedido mínimo es $${minOrder.toLocaleString('es-CO')}`, 400);
    }

    // ── Service fee ──
    const customerServiceFee = clampMoney(
      cfg.serviceFeeFixed + applyBps(productSubtotal, cfg.serviceFeeBps),
      cfg.serviceFeeMin,
      cfg.serviceFeeMax
    );

    const appliedCommissionBps = this.resolveCommissionBps(business, cfg);

    // ── Tip ──
    const tip = this.normalizeTip(input.tip, productSubtotal, cfg);

    // ── Zipp Pro ──
    // Una consulta por cotización, contra un documento por persona. Lo que
    // devuelve no es "si pagó", es "qué tiene derecho a descontar hoy": la
    // membresía caducada no llega hasta aquí.
    const pro = await proService.benefitsFor(input.userId);

    // ── Impuesto (M-014) ──
    // Con las reglas apagadas, la tasa global de siempre; encendidas, la regla
    // validada y vigente de cada concepto en este instante.
    const taxPlan = await taxRuleService.checkoutPlan(cfg, new Date());

    // Todo lo que no depende del cupón ni de las promociones, una sola vez.
    // `settleDiscounts` es la misma aritmética con la que se cobra y con la
    // que el sugeridor decide qué ofrecer: no hay una segunda copia que pueda
    // volverse distinta.
    const baseParts = {
      productSubtotal,
      deliveryCustomerFee: delivery.customerFee,
      deliveryMargin: delivery.margin,
      customerServiceFee,
      appliedCommissionBps,
      cfg,
      pro,
      tip,
      isCash,
      taxPlan,
    };

    // ── Promociones automáticas por producto ──
    //
    // Sin código: se resuelven solas contra lo que hay en el carrito, antes
    // de saber si el cliente trae un cupón. `priceItems()` no sabe nada de
    // esto a propósito — ver la nota en `applyAutoPromotions`.
    //
    // Se aplican solo mientras el comercio pueda pagarlas: sin el envío
    // gratis a cuestas (que se decide después, con ellas ya puestas), porque
    // el descuento del producto es la promoción que el comercio eligió.
    const autoPromos = await couponService.autoPromotionsFor(input.businessId, new Date(), {
      includePersonal: true,
    });
    const { appliedAutoPromotions, autoPromotionDiscount } = await this.applyAutoPromotions(
      pricedItems,
      autoPromos,
      input,
      cfg,
      (total) => this.canMerchantFundAutoPromotions(baseParts, total)
    );
    // Forzado por el modelo: `autoApply` solo admite `fundedBy: BUSINESS`.
    const autoPromotionMerchantFunded = autoPromotionDiscount;

    // ── Envío gratis del comercio ──
    //
    // Es automático, así que si el comercio no puede pagarlo junto con sus
    // promociones del pedido, simplemente no se regala: el cliente paga su
    // domicilio y la cotización sigue siendo válida. Se decide aquí, sin
    // cupón, y la misma decisión viaja al sugeridor.
    const freeDeliveryThreshold = this.affordableFreeDeliveryThreshold(
      baseParts,
      autoPromotionMerchantFunded,
      effectiveFreeDeliveryThreshold(business, new Date(), envConfig.settlement.timezone)
    );

    // ── Coupon ──
    //
    // Sobre el subtotal ya neto de las promociones automáticas: un
    // porcentual de código no descuenta dos veces la misma plata, igual que
    // ya pasa hoy con `discountPrice`, que tampoco vuelve a subir la base.
    const subtotalAfterAutoPromotions = Math.max(0, productSubtotal - autoPromotionDiscount);

    let coupon: AppliedCoupon | null = null;
    if (input.couponCode) {
      coupon = await couponService.validate(
        input.couponCode,
        {
          userId: input.userId,
          businessId: input.businessId,
          city: business.city,
          subtotal: subtotalAfterAutoPromotions,
          deliveryFee: delivery.customerFee,
          serviceFee: customerServiceFee,
          zoneId: delivery.zoneId?.toString() ?? null,
          userRole: 'client',
        },
        cfg
      );
    }

    const deliveryDiscount = coupon?.deliveryDiscount ?? 0;

    const settled = this.settleDiscounts({
      ...baseParts,
      coupon,
      autoPromotionMerchantFunded,
      freeDeliveryThreshold,
    });

    // El cupón lo eligió el cliente: si no cabe en el pedido se le dice, con
    // un 422 entendible, en vez de recortar cifras o fallar al cuadrar. Va
    // antes de cualquier canje, así que no consume nada.
    const conflict = this.couponConflict(coupon, settled);
    if (conflict) throw new AppError(conflict.message, 422, conflict.code);

    const {
      freeDeliveryDiscount,
      payableDelivery,
      proDeliveryDiscount,
      proServiceFeeDiscount,
      merchantFundedDiscount,
      merchantCommission,
      platformFundedDiscount,
      platformGrossRevenue,
      platformNetRevenueBeforeOperatingCosts,
      taxPayable,
      customerTotal,
      merchantPayout: businessPayout,
      estimatedGatewayFee,
    } = settled;

    // ── Payouts ──
    const driverPayout = delivery.driverPayout + tip;

    const platformPromotionExpense = platformFundedDiscount;

    // ── Contribution-margin guard ──
    // A platform campaign that costs more than the order earns is only
    // allowed when finance explicitly approved that campaign's budget.
    // El margen se mide con el cobro de la pasarela ya restado (ver
    // `breaksMarginFloor`).
    if (this.breaksMarginFloor(coupon, platformNetRevenueBeforeOperatingCosts, estimatedGatewayFee)) {
      throw new AppError(
        'Este cupón no puede aplicarse a este pedido: el margen resultante ' +
          'queda por debajo del mínimo permitido.',
        422
      );
    }

    // ── Cash to remit ──
    // The driver hands the merchant exactly `businessPayout`, keeps
    // `driverPayout`, and owes the platform the rest. It is derived from
    // the identity below, never from an independent formula.
    const cashToRemit = isCash ? customerTotal - businessPayout - driverPayout : 0;

    if (isCash) {
      await this.assertCashEligible({ customerTotal, businessPayout, driverPayout });
    }

    this.assertBalanced({
      customerTotal,
      platformFundedDiscount,
      businessPayout,
      driverPayout,
      platformGrossRevenue,
      taxPayable,
    });

    // ── El mejor cupón para este carrito ──
    //
    // Solo si no trajo ninguno: si ya eligió, sugerirle otro sería discutir
    // con él. Va después de las guardas para no gastar consultas en un
    // pedido que ni siquiera se va a poder cobrar.
    const suggestedCoupon = coupon || input.suggest === false
      ? null
      : await this.suggestCoupon({
          ...baseParts,
          userId: input.userId,
          businessId: input.businessId,
          city: business.city,
          // Neto de promociones automáticas: lo que sugiere debe ahorrar
          // exactamente lo que ahorraría si de verdad se aplicara.
          netProductSubtotal: subtotalAfterAutoPromotions,
          autoPromotionMerchantFunded,
          zoneId: delivery.zoneId?.toString() ?? null,
          freeDeliveryThreshold,
        });

    return {
      items: pricedItems,

      productSubtotal,
      merchantCommission,
      customerServiceFee,
      deliveryCustomerFee: delivery.customerFee,
      /**
       * Lo que el cliente paga de domicilio de verdad, ya descontado el
       * cupón y el envío gratis del comercio. `deliveryCustomerFee` sigue
       * siendo el bruto: hacen falta los dos para poder enseñar el ahorro.
       */
      deliveryPayable: payableDelivery,
      freeDeliveryApplied: freeDeliveryDiscount > 0,
      freeDeliveryDiscount,
      /**
       * Lo que la membresía le quitó a este pedido, partido en dos porque
       * el checkout los enseña en renglones distintos: uno va junto al
       * envío y el otro junto a la tarifa de servicio.
       */
      proDeliveryDiscount,
      proServiceFeeDiscount,
      driverDeliveryPayout: delivery.driverPayout,
      deliveryMargin: delivery.margin,
      tip,
      merchantFundedDiscount,
      platformFundedDiscount,
      taxPayable,
      businessPayout,
      driverPayout,
      platformGrossRevenue,
      platformPromotionExpense,
      platformNetRevenueBeforeOperatingCosts,
      customerTotal,
      currency: envConfig.payments.currency,
      pricingConfigVersion: cfg.version,
      appliedCommissionBps,

      etaMinutesMin: eta.min,
      etaMinutesMax: eta.max,
      deliveryDistanceKm: delivery.distanceKm,
      zoneId: delivery.zoneId,
      zoneName: delivery.zoneName,
      zoneVersion: delivery.zoneVersion,
      coupon,
      suggestedCoupon,
      appliedAutoPromotions,
      promotionDiscount: autoPromotionDiscount,
      minOrder,
      cashToRemit,
      requiresAgeVerification,

      // Legacy aliases so existing consumers keep working unchanged.
      subtotal: productSubtotal,
      deliveryFee: delivery.customerFee,
      discount: merchantFundedDiscount + platformFundedDiscount,
      tax: taxPayable,
      total: customerTotal,
      platformCommission: merchantCommission,
      precioOriginal: productSubtotal + delivery.customerFee + customerServiceFee + taxPayable + tip,
      proBenefitNotice: settled.proGuard,
      taxStatus: settled.taxStatus,
      taxBreakdown: settled.taxBreakdown,
      descuentoEnvio: deliveryDiscount + freeDeliveryDiscount + proDeliveryDiscount,
      totalUsuario: customerTotal,
      subsidioPlataforma: platformFundedDiscount,
      subsidioComercio: merchantFundedDiscount,
    };
  }

  /**
   * Cómo quedaría el dinero de un pedido con una promoción que todavía no
   * existe (o un umbral de envío gratis que todavía no se guardó).
   *
   * Es la previsualización que el comercio y el administrador ven ANTES de
   * activar nada, y por eso no tiene una calculadora propia: reutiliza
   * `computeDiscount`, `settleDiscounts`, `couponConflict` y
   * `breaksMarginFloor` — las mismas funciones con las que `quote()` cobra y
   * con las que el sugeridor decide —, sobre la tarifa de domicilio real del
   * comercio (`priceRoute`). Si mañana cambia una regla, la previsualización
   * cambia con ella.
   *
   * No escribe nada: la promoción es un documento en memoria que ni siquiera
   * se guarda, no se canjea ningún cupo, no se crea pedido ni asiento.
   *
   * Qué NO modela (y lo dice en `assumptions`): las demás promociones del
   * comercio, la membresía Zipp Pro del cliente y la propina; y asume que todo
   * el carrito está cubierto por la promoción cuando es automática.
   */
  async previewPromotion(input: PromotionPreviewInput): Promise<PromotionPreview> {
    const cfg = await pricingConfigService.getCurrent();

    const business = await Business.findById(input.businessId);
    if (!business) throw new AppError('Negocio no encontrado', 404);
    const origin = fromGeoPoint(business.location);
    if (!origin) {
      throw new AppError('Este negocio no tiene una ubicación válida configurada', 409);
    }

    const isCash = input.paymentMethod === PaymentMethod.CASH_ON_DELIVERY;
    const assumptions: string[] = [
      'Se usa la tarifa de domicilio real de tu zona y la configuración vigente de ZIPP.',
      'No incluye propina, membresía Zipp Pro ni otras promociones tuyas.',
      isCash
        ? 'Pago contra entrega: no genera comisión de pasarela.'
        : 'Pago en línea: se estima la comisión de la pasarela con la tarifa más alta configurada.',
    ];

    // ── El borrador, validado con las reglas reales del modelo ──
    //
    // Un documento sin guardar corre exactamente las mismas validaciones y
    // los mismos `pre('validate')` que correrán al crearlo, así que una
    // combinación imposible se avisa aquí en vez de al pulsar «Crear».
    let draftDoc: ICoupon | null = null;
    const errors: string[] = [];
    if (input.draft) {
      const fundedBy = input.allowPlatformFunding
        ? input.draft.fundedBy ?? CouponFundedBy.BUSINESS
        : CouponFundedBy.BUSINESS;
      const now = new Date();
      draftDoc = new Coupon({
        code: input.draft.autoApply ? undefined : 'VISTAPREVIA',
        title: 'Vista previa',
        ...input.draft,
        fundedBy,
        scope:
          input.draft.type === CouponType.FREE_DELIVERY
            ? CouponScope.DELIVERY
            : input.draft.scope ?? CouponScope.PRODUCT,
        businessId: business._id,
        city: business.city,
        autoApply: input.draft.autoApply === true,
        productIds: input.draft.autoApply ? [new Types.ObjectId()] : [],
        validFrom: input.draft.validFrom ?? now,
        validUntil: input.draft.validUntil ?? new Date(now.getTime() + 30 * 24 * 3600_000),
        campaignApproved: input.allowPlatformFunding ? input.draft.campaignApproved === true : false,
      });
      try {
        await draftDoc.validate();
      } catch (error) {
        const fields = (error as { errors?: Record<string, { message: string }> }).errors;
        errors.push(
          ...(fields
            ? Object.values(fields).map((e) => e.message)
            : [error instanceof Error ? error.message : 'La promoción no es válida'])
        );
        draftDoc = null;
      }
    }
    if (errors.length > 0) return { valid: false, errors, assumptions, scenarios: [] };

    const km = Math.max(0, Math.min(input.distanceKm ?? 2, cfg.maxRadiusMeters / 1000));
    const destination: LatLng = { lat: origin.lat + km / 111.32, lng: origin.lng };
    const delivery = await this.priceRoute(origin, destination, business.city, cfg);
    const minOrder = Math.max(business.minOrder || 0, delivery.zoneMinOrder);
    const appliedCommissionBps = this.resolveCommissionBps(business, cfg);
    const threshold =
      input.freeDeliveryThreshold ??
      effectiveFreeDeliveryThreshold(business, new Date(), envConfig.settlement.timezone);

    // El mismo impuesto que va a cobrar el checkout (M-014).
    const taxPlan = await taxRuleService.checkoutPlan(cfg, new Date());
    const scenarios: PreviewScenario[] = [];
    for (const productSubtotal of input.subtotals) {
      assertMoney(productSubtotal, 'subtotal');
      const warnings: PreviewWarning[] = [];

      const customerServiceFee = clampMoney(
        cfg.serviceFeeFixed + applyBps(productSubtotal, cfg.serviceFeeBps),
        cfg.serviceFeeMin,
        cfg.serviceFeeMax
      );
      const base: SettleBase = {
        productSubtotal,
        deliveryCustomerFee: delivery.customerFee,
        deliveryMargin: delivery.margin,
        customerServiceFee,
        appliedCommissionBps,
        cfg,
        pro: null,
        tip: 0,
        isCash,
        taxPlan,
      };

      if (minOrder && productSubtotal < minOrder) {
        warnings.push({
          code: 'BELOW_MIN_ORDER',
          message: `Este pedido no se podría hacer: el mínimo de tu zona es $${minOrder.toLocaleString('es-CO')}.`,
        });
      }

      // Sin promoción: lo que se cobra hoy, para poder enseñar la diferencia.
      const baselineThreshold = this.affordableFreeDeliveryThreshold(base, 0, threshold);
      const baseline = this.settleDiscounts({
        ...base,
        coupon: null,
        autoPromotionMerchantFunded: 0,
        freeDeliveryThreshold: baselineThreshold,
      });

      let applied: AppliedCoupon | null = null;
      let autoDiscount = 0;
      let promotionApplied = false;

      if (draftDoc) {
        const ctx = {
          userId: 'preview',
          businessId: input.businessId,
          subtotal: productSubtotal,
          deliveryFee: delivery.customerFee,
          serviceFee: customerServiceFee,
        };
        const computed = couponService.computeDiscount(draftDoc, ctx, cfg);

        if (productSubtotal < draftDoc.minOrderAmount) {
          warnings.push({
            code: 'BELOW_PROMOTION_MIN',
            message: 'Con este pedido la promoción no se aplicaría: no llega a su compra mínima.',
          });
        } else if (computed.totalDiscount <= 0) {
          warnings.push({ code: 'NO_DISCOUNT', message: 'La promoción no descontaría nada en este pedido.' });
        } else if (draftDoc.autoApply) {
          if (this.canMerchantFundAutoPromotions(base, computed.productDiscount)) {
            autoDiscount = computed.productDiscount;
            promotionApplied = true;
          } else {
            warnings.push({
              code: 'UNAFFORDABLE_AUTO_PROMOTION',
              message:
                'En este pedido la promoción no se aplicaría: dejaría tu pago en negativo, así que el sistema la omite.',
            });
          }
        } else {
          applied = computed;
          promotionApplied = true;
        }
      }

      const effectiveThreshold = this.affordableFreeDeliveryThreshold(base, autoDiscount, threshold);
      if (threshold > 0 && effectiveThreshold === 0) {
        warnings.push({
          code: 'FREE_DELIVERY_UNAFFORDABLE',
          message:
            'En este pedido no se regalaría el domicilio: junto con la promoción dejaría tu pago en negativo.',
        });
      }

      const outcome = this.settleDiscounts({
        ...base,
        coupon: applied,
        autoPromotionMerchantFunded: autoDiscount,
        freeDeliveryThreshold: effectiveThreshold,
      });

      const conflict = this.couponConflict(applied, outcome);
      if (conflict) {
        warnings.push({ code: conflict.code, message: conflict.message });
        promotionApplied = false;
      }
      if (
        applied &&
        this.breaksMarginFloor(applied, outcome.platformNetRevenueBeforeOperatingCosts, outcome.estimatedGatewayFee)
      ) {
        warnings.push({
          code: 'MARGIN_BELOW_FLOOR',
          message: 'Esta campaña dejaría el pedido por debajo del margen mínimo permitido.',
        });
      }
      const spend = applied ? couponService.budgetSpendOf(applied) : autoDiscount;
      if (draftDoc && draftDoc.budgetLimit > 0 && spend > draftDoc.budgetLimit) {
        warnings.push({
          code: 'EXCEEDS_BUDGET',
          message: 'Un solo pedido ya gastaría más que el presupuesto máximo de la promoción.',
        });
      }

      scenarios.push({
        productSubtotal,
        promotionApplied,
        freeDeliveryApplied: outcome.freeDeliveryDiscount > 0,
        productDiscount: (applied?.productDiscount ?? 0) + autoDiscount,
        payableSubtotal: outcome.payableSubtotal,
        deliveryFee: delivery.customerFee,
        deliveryPayable: outcome.payableDelivery,
        serviceFee: outcome.payableServiceFee,
        tax: outcome.taxPayable,
        customerTotal: outcome.customerTotal,
        customerSaving: baseline.customerTotal - outcome.customerTotal,
        merchantFunded: outcome.merchantFundedDiscount,
        platformFunded: outcome.platformFundedDiscount,
        merchantCommission: outcome.merchantCommission,
        merchantPayout: outcome.merchantPayout,
        merchantPayoutWithoutPromotion: baseline.merchantPayout,
        driverPayout: delivery.driverPayout,
        platformGrossRevenue: outcome.platformGrossRevenue,
        platformNet: outcome.platformNetRevenueBeforeOperatingCosts,
        estimatedGatewayFee: outcome.estimatedGatewayFee,
        platformNetAfterGateway:
          outcome.platformNetRevenueBeforeOperatingCosts - outcome.estimatedGatewayFee,
        warnings,
      });
    }

    return { valid: true, errors: [], assumptions, scenarios };
  }

  /**
   * El cupón que más ahorraría en este carrito.
   *
   * Es la pieza que quita de en medio el paso de memorizar un código: la
   * pantalla de Descuentos enseña el cupón, el checkout lo encuentra solo.
   *
   * "Ahorra más" se mide contra el total real del cliente, no contra el
   * descuento bruto del cupón. `computeDiscount` y `settleDiscounts` son
   * puras y son la misma aritmética con la que se cobra, así que se compara
   * lo que pagaría con y sin el cupón: con Zipp Pro (envío gratis o tarifa
   * perdonada) un cupón que solo descuenta el envío o la tarifa no baja el
   * total, ahorra 0 y se descarta —si no, gastaría cupo y presupuesto de
   * plataforma para regalarle al socio lo que ya tenía.
   *
   * Se ordena de mayor a menor ahorro y se valida contra la base en ese
   * orden, parando en el primero bueno en vez de validar los veinte. Ese
   * primero ya no es siempre el ganador: si lo paga la plataforma, todavía
   * puede haber un cupón del comercio que ahorre casi lo mismo (dentro de
   * `COUPON_FUNDING_TIE_BAND`) y que a ZIPP le cuesta cero; se busca solo
   * entre los que caen en esa banda.
   *
   * Un cupón que no aplica no es un error que haya que propagar: es
   * simplemente uno que no era, y el siguiente de la lista sigue teniendo
   * su oportunidad.
   */
  private async suggestCoupon(
    parts: SettleBase & {
      userId: string;
      businessId: string;
      city?: string;
      /**
       * Subtotal NETO de promociones automáticas: la base sobre la que se
       * calculan los cupones candidatos. `productSubtotal` (heredado de
       * `SettleBase`) es el bruto, que es el que necesita el reparto.
       */
      netProductSubtotal: number;
      /** Constante frente a cualquier cupón candidato. */
      autoPromotionMerchantFunded: number;
      zoneId: string | null;
      /** Ya resuelto por `quote()`: 0 si el comercio no puede pagar el envío gratis. */
      freeDeliveryThreshold: number;
    }
  ): Promise<SuggestedCoupon | null> {
    const { cfg } = parts;

    const ctx = {
      userId: parts.userId,
      businessId: parts.businessId,
      city: parts.city,
      subtotal: parts.netProductSubtotal,
      deliveryFee: parts.deliveryCustomerFee,
      serviceFee: parts.customerServiceFee,
      zoneId: parts.zoneId,
      userRole: 'client',
    };

    const candidates = await couponService.candidatesFor(
      parts.userId,
      parts.city,
      parts.businessId
    );

    // El mismo reparto con el que se cobra (`quote()` pasa exactamente los
    // mismos `parts`), incluido el trato de Zipp Pro y la propina: sin eso,
    // el sugeridor juzgaría un pedido que no es el que se va a hacer.
    const settle = (coupon: AppliedCoupon | null) =>
      this.settleDiscounts({
        ...parts,
        coupon,
        autoPromotionMerchantFunded: parts.autoPromotionMerchantFunded,
        freeDeliveryThreshold: parts.freeDeliveryThreshold,
      });

    // Lo que paga el cliente antes de impuestos y propina —que no dependen
    // del cupón salvo por el redondeo—, con la misma composición que `quote`.
    const payableBeforeTax = (outcome: SettledDiscounts) =>
      outcome.payableSubtotal + outcome.payableDelivery + outcome.payableServiceFee;

    const baseline = payableBeforeTax(settle(null));
    const savingOf = (applied: AppliedCoupon) => baseline - payableBeforeTax(settle(applied));

    const ranked = candidates
      .filter((coupon) => parts.netProductSubtotal >= coupon.minOrderAmount)
      .map((coupon) => {
        const computed = couponService.computeDiscount(coupon, ctx, cfg);
        return { coupon, saving: computed.totalDiscount > 0 ? savingOf(computed) : 0 };
      })
      .filter(({ saving }) => saving > 0)
      .sort((a, b) => b.saving - a.saving);

    const evaluate = async (
      coupon: ICoupon
    ): Promise<{ applied: AppliedCoupon; saving: number } | null> => {
      let applied: AppliedCoupon;
      try {
        applied = await couponService.validate(coupon.code, ctx, cfg);
      } catch {
        return null;
      }

      const outcome = settle(applied);

      // Nunca se ofrece lo que después se va a rechazar: la misma función
      // que decide el 422 de la cotización decide aquí, y el mismo suelo de
      // margen (con la comisión de la pasarela ya restada) también.
      if (this.couponConflict(applied, outcome)) return null;
      if (
        this.breaksMarginFloor(
          applied,
          outcome.platformNetRevenueBeforeOperatingCosts,
          outcome.estimatedGatewayFee
        )
      ) {
        return null;
      }

      const saving = baseline - payableBeforeTax(outcome);
      return saving > 0 ? { applied, saving } : null;
    };

    let best: { applied: AppliedCoupon; saving: number } | null = null;

    for (const [index, { coupon }] of ranked.entries()) {
      const first = await evaluate(coupon);
      if (!first) continue;
      best = first;

      // Desempate por financiador: si el mejor sale de la caja de ZIPP, un
      // cupón del comercio que ahorre casi igual lo reemplaza.
      if (best.applied.fundedBy !== CouponFundedBy.BUSINESS) {
        for (const other of ranked.slice(index + 1)) {
          if (other.saving < first.saving - COUPON_FUNDING_TIE_BAND) break;
          if (other.coupon.fundedBy !== CouponFundedBy.BUSINESS) continue;

          const alt = await evaluate(other.coupon);
          if (alt) {
            best = alt;
            break;
          }
        }
      }
      break;
    }

    if (!best) return null;
    return { code: best.applied.code, title: best.applied.title, discount: best.saving };
  }

  /**
   * Qué queda de la promoción una vez repartida.
   *
   * Vivía suelto dentro de `quote()`. Se sacó para que el sugeridor de
   * cupones —y la previsualización del comercio— puedan preguntar "¿y si
   * aplicara este?" con exactamente la misma aritmética con la que después
   * se va a cobrar: si fueran dos copias, el día que una cambiara la app
   * ofrecería un ahorro que el cobro no da, que es la clase de diferencia
   * que nadie ve hasta que un cliente la reclama.
   *
   * Es pura: no toca la base ni lanza. Decidir si el resultado es aceptable
   * es trabajo de `couponConflict` y `breaksMarginFloor`.
   */
  settleDiscounts(parts: SettleParts): SettledDiscounts {
    const requested = this.settleOnce(parts);
    const pro = parts.pro;
    if (!pro) return requested;

    const deliveryActive = requested.proDeliveryDiscount > 0;
    const feeActive = requested.proServiceFeeDiscount > 0;
    if (!deliveryActive && !feeActive) return requested;

    const marginOf = (outcome: SettledDiscounts) =>
      outcome.platformNetRevenueBeforeOperatingCosts - outcome.estimatedGatewayFee;
    const marginWithFullBenefit = marginOf(requested);
    if (marginWithFullBenefit >= PRO_MIN_ORDER_MARGIN) return requested;

    // ── M-012: el trato de Pro dejaría este pedido en pérdida para ZIPP ──
    //
    // La alternativa es siempre una versión MÁS CHICA del mismo trato que Zipp
    // Pro ya ofrece, nunca un descuento inventado: quitar la tarifa de servicio
    // perdonada, quitar el envío gratis, o quitar ambos. Entre las que dejan el
    // margen en regla gana la que más ahorro le deja al cliente; a igualdad, la
    // que conserva el envío gratis, que es la promesa más visible de la
    // membresía. Si ninguna parcial cabe, el pedido sale sin beneficio de Pro y
    // `proGuard` dice por qué.
    const candidates: Array<{ keep: Partial<ProBenefitsSnapshot>; skipped: ProBenefitKey[] }> = [];
    if (deliveryActive && feeActive) {
      candidates.push({ keep: { serviceFeeWaived: false }, skipped: ['serviceFeeWaived'] });
      candidates.push({ keep: { freeDelivery: false }, skipped: ['freeDelivery'] });
    }
    candidates.push({
      keep: { freeDelivery: false, serviceFeeWaived: false },
      skipped: [...(deliveryActive ? ['freeDelivery' as const] : []), ...(feeActive ? ['serviceFeeWaived' as const] : [])],
    });

    const saving = (o: SettledDiscounts) => o.proDeliveryDiscount + o.proServiceFeeDiscount;
    const evaluated = candidates.map((candidate) => ({
      skipped: candidate.skipped,
      outcome: this.settleOnce({ ...parts, pro: { ...pro, ...candidate.keep } }),
    }));
    // La última alternativa (sin beneficio de Pro) siempre existe: es la que se
    // cobra si ninguna parcial deja el margen en regla.
    const viable = evaluated.filter((e) => marginOf(e.outcome) >= PRO_MIN_ORDER_MARGIN);
    const { outcome, skipped } = viable.length
      ? viable.reduce((best, e) => (saving(e.outcome) > saving(best.outcome) ? e : best))
      : evaluated[evaluated.length - 1];

    const names: Record<ProBenefitKey, string> = {
      freeDelivery: 'el envío gratis',
      serviceFeeWaived: 'la tarifa de servicio sin costo',
    };
    return {
      ...outcome,
      proGuard: {
        code: 'PRO_NEGATIVE_MARGIN',
        skipped,
        marginWithFullBenefit,
        marginApplied: marginOf(outcome),
        message:
          `En este pedido no se aplica ${skipped.map((k) => names[k]).join(' ni ')} de Zipp Pro: ` +
          'con esta compra ZIPP lo pagaría a pérdida. El resto de tu pedido no cambia.',
      },
    };
  }

  /**
   * La aritmética del reparto, tal cual la pide el trato de Pro que le pasen.
   * `settleDiscounts` la llama una vez con el trato completo y, solo si ese
   * trato deja el pedido en pérdida, otra vez con versiones más chicas.
   */
  private settleOnce(parts: SettleParts): SettledDiscounts {
    const { coupon, productSubtotal, cfg } = parts;

    const couponMerchantFunded = coupon?.merchantFunded ?? 0;
    const couponPlatformFunded = coupon?.platformFunded ?? 0;
    const couponServiceFeeDiscount = coupon?.serviceFeeDiscount ?? 0;
    const deliveryAfterCoupon = parts.deliveryCustomerFee - (coupon?.deliveryDiscount ?? 0);

    // ── Lo que el cliente paga por los productos ──
    //
    // Es la base de cualquier umbral por compra: el envío gratis del comercio
    // y el mínimo de Zipp Pro se miden sobre lo que de verdad sale del bolsillo
    // del cliente por los productos, después de los descuentos que los
    // afectan —cupón de producto y promociones automáticas—. Con $30.000 de
    // umbral, una promoción que deja los productos en $20.000 no alcanza,
    // aunque la carta sumara más. El domicilio, la tarifa de servicio y sus
    // descuentos no entran: medir el umbral con ellos sería premiar al cliente
    // por lo que paga de envío.
    const payableSubtotal =
      productSubtotal - (coupon?.productDiscount ?? 0) - parts.autoPromotionMerchantFunded;

    // ── Envío gratis por compra mínima ──
    //
    // No es un mecanismo nuevo: es exactamente un descuento de entrega
    // financiado por el comercio, igual que un cupón suyo. Modelarlo así y
    // no como un caso aparte importa, porque toda la contabilidad —la
    // comisión, la liquidación, el efectivo a rendir— ya sabe tratar un
    // descuento del comercio, y una vía paralela sería una vía por la que
    // se escapa dinero sin que nadie lo cuadre.
    //
    // Se aplica sobre lo que quede del envío tras el cupón, nunca sobre el
    // importe original: si el cliente ya trae un cupón de envío gratis, el
    // negocio no tiene por qué pagar dos veces lo mismo. (Esa combinación ya
    // ni siquiera llega a cobrarse: `couponConflict` la rechaza antes.)
    const qualifiesForFreeDelivery =
      parts.freeDeliveryThreshold > 0 && payableSubtotal >= parts.freeDeliveryThreshold;

    const freeDeliveryDiscount = qualifiesForFreeDelivery
      ? Math.max(0, deliveryAfterCoupon)
      : 0;

    // Lo que el comercio termina financiando: su cupón, el envío que
    // regaló, y cualquier promoción automática por producto que haya
    // aplicado. Sale entero de su liquidación.
    const merchantFundedDiscount =
      couponMerchantFunded + freeDeliveryDiscount + parts.autoPromotionMerchantFunded;

    // ── El trato de Zipp Pro ──
    //
    // Lo paga ZIPP, no el comercio: la persona nos pagó a nosotros una
    // cuota mensual, así que el envío que se le regala es gasto nuestro y
    // se suma al subsidio de plataforma. Modelarlo como descuento del
    // comercio le cobraría a un tercero una promoción que no contrató.
    //
    // Va después del envío gratis por compra mínima y sobre lo que quede:
    // si el comercio ya lo regaló, la membresía no tiene nada que pagar
    // encima. El domiciliario cobra lo mismo en los dos casos —su parte
    // nunca se toca—, y por eso esto reduce margen y no salario.
    const deliveryAfterFree = deliveryAfterCoupon - freeDeliveryDiscount;
    const qualifiesForPro =
      !!parts.pro?.freeDelivery && payableSubtotal >= parts.pro.freeDeliveryMinSubtotal;
    const proDeliveryDiscount = qualifiesForPro ? Math.max(0, deliveryAfterFree) : 0;

    const proServiceFeeDiscount = parts.pro?.serviceFeeWaived
      ? Math.max(0, parts.customerServiceFee - couponServiceFeeDiscount)
      : 0;

    const platformFundedDiscount =
      couponPlatformFunded + proDeliveryDiscount + proServiceFeeDiscount;

    // ── Commission ──
    // A platform-funded discount never shrinks the commission base: the
    // merchant sold at full price and ZIPP paid for the promotion, so ZIPP
    // still earns on the full sale. Only a merchant-funded discount reduces
    // it, and only when finance has configured it that way.
    //
    // Solo el descuento sobre PRODUCTO puede reducir la base: ahí el
    // comercio vendió más barato — el cupón de código y la promoción
    // automática son la misma categoría de descuento, así que restan los
    // dos. El envío que regala lo paga aparte, con los productos vendidos a
    // precio completo, así que descontarlo aquí le rebajaría también la
    // comisión y ZIPP acabaría pagando parte de una promoción que no
    // decidió. Sin este descuento, ZIPP le cobraría al comercio comisión
    // sobre dinero que nunca recibió: la promoción bajó lo que cobró, y la
    // comisión tiene que bajar con ella.
    const commissionBase = cfg.commissionAfterMerchantDiscount
      ? productSubtotal - couponMerchantFunded - parts.autoPromotionMerchantFunded
      : productSubtotal;
    const merchantCommission = applyBps(Math.max(0, commissionBase), parts.appliedCommissionBps);

    const platformGrossRevenue =
      merchantCommission + parts.customerServiceFee + parts.deliveryMargin;

    const payableDelivery = deliveryAfterFree - proDeliveryDiscount;
    const payableServiceFee = parts.customerServiceFee - couponServiceFeeDiscount - proServiceFeeDiscount;

    // ── Tax and total ──
    const tax = computeCheckoutTax({
      plan: parts.taxPlan,
      legacyBps: cfg.taxBps,
      net: { products: payableSubtotal, delivery: payableDelivery, service_fee: payableServiceFee },
      gross: { products: productSubtotal, delivery: parts.deliveryCustomerFee, service_fee: parts.customerServiceFee },
    });
    const taxPayable = tax.taxPayable;
    const customerTotal =
      payableSubtotal + payableDelivery + payableServiceFee + taxPayable + parts.tip;

    // ── Lo que le queda al comercio ──
    // Sin `Math.max(0, …)`: recortar a cero escondería una combinación de
    // descuentos que el comercio no puede pagar y rompería la identidad de
    // `assertBalanced` en silencio.
    const merchantPayout = productSubtotal - merchantFundedDiscount - merchantCommission;

    return {
      freeDeliveryDiscount,
      payableDelivery,
      proDeliveryDiscount,
      proServiceFeeDiscount,
      merchantFundedDiscount,
      merchantCommission,
      platformFundedDiscount,
      platformGrossRevenue,
      platformNetRevenueBeforeOperatingCosts: platformGrossRevenue - platformFundedDiscount,
      payableSubtotal,
      payableServiceFee,
      taxPayable,
      customerTotal,
      merchantPayout,
      deliveryAlreadyFree: qualifiesForFreeDelivery || qualifiesForPro,
      estimatedGatewayFee: this.estimateGatewayCost(cfg, parts.isCash, customerTotal),
      taxStatus: tax.status,
      taxBreakdown: tax.lines,
      proGuard: null,
    };
  }

  /**
   * Si el comercio puede pagar este total de promociones automáticas sin
   * quedar con un pago negativo. Se mide sin el envío gratis a cuestas: el
   * descuento del producto es la promoción que el comercio eligió, y el envío
   * gratis se decide después con ella ya puesta
   * (`affordableFreeDeliveryThreshold`).
   */
  canMerchantFundAutoPromotions(base: SettleBase, totalAutoDiscount: number): boolean {
    return (
      this.settleDiscounts({
        ...base,
        coupon: null,
        autoPromotionMerchantFunded: totalAutoDiscount,
        freeDeliveryThreshold: 0,
      }).merchantPayout >= 0
    );
  }

  /**
   * El umbral de envío gratis que el comercio puede pagar en este pedido: el
   * vigente, o 0 si regalarlo —junto con las promociones automáticas que ya
   * aplican— lo dejaría con un pago negativo.
   *
   * El envío gratis es automático, así que no se rechaza nada: simplemente no
   * se regala en ese pedido y el cliente paga su domicilio. No es apagar el
   * envío gratis: solo cae en el pedido que el comercio no puede costear.
   */
  affordableFreeDeliveryThreshold(
    base: SettleBase,
    autoPromotionMerchantFunded: number,
    threshold: number
  ): number {
    if (threshold <= 0) return 0;
    const outcome = this.settleDiscounts({
      ...base,
      coupon: null,
      autoPromotionMerchantFunded,
      freeDeliveryThreshold: threshold,
    });
    return outcome.merchantPayout < 0 ? 0 : threshold;
  }

  /**
   * Cuánto se llevaría la pasarela de este cobro, para medir el margen.
   *
   * Usa `estimateGatewayFee`, la misma función con la que el libro asienta el
   * gasto al capturar el pago y con la que los informes estiman el resultado
   * neto: una sola fórmula, las tarifas de la configuración vigente y su IVA.
   *
   *  · **Efectivo: 0.** No pasa por Wompi, así que no genera ese coste.
   *  · **En línea, método desconocido.** La cotización se pide antes de saber
   *    si el cliente pagará con tarjeta, PSE o Nequi, así que se toma la
   *    tarifa más alta de las configuradas: la estimación conservadora, que
   *    puede rechazar una campaña límite pero nunca aprobar una que pierda
   *    dinero por culpa de la pasarela.
   *  · **Sin tarifas configuradas: 0**, como en todos los informes. No se
   *    inventa ninguna: el dueño las llena con su contrato.
   *
   * Es una estimación para decidir, no un asiento: el snapshot del pedido
   * (`platformNetRevenueBeforeOperatingCosts`) sigue sin incluirla, porque el
   * libro registra el coste real al capturar el pago y sumarlo en dos sitios
   * lo contaría dos veces.
   */
  private estimateGatewayCost(
    cfg: IPlatformPricingConfig,
    isCash: boolean,
    amount: number
  ): number {
    if (isCash || amount <= 0) return 0;
    return Math.max(
      ...(['CARD', 'PSE', 'NEQUI', 'OTHER'] as const).map((method) =>
        estimateGatewayFee(cfg, method, amount)
      )
    );
  }

  /**
   * Si un cupón no puede combinarse con el resto del pedido.
   *
   * Una sola función para la cotización (que responde 422) y para el
   * sugeridor (que descarta el cupón): si cada uno tuviera su regla, el
   * sugeridor acabaría ofreciendo cupones que el checkout rechaza.
   */
  couponConflict(
    coupon: AppliedCoupon | null,
    outcome: SettledDiscounts
  ): CouponConflict | null {
    if (!coupon) return null;

    // Un cupón de domicilio sobre un pedido que ya sale con envío gratis (por
    // el umbral del comercio o por Zipp Pro) no aporta nada y, de aceptarse,
    // gastaría uno de sus usos —o presupuesto de plataforma— a cambio de
    // cero. La liquidación del domiciliario no se toca: su parte es la misma.
    if (coupon.deliveryDiscount > 0 && outcome.deliveryAlreadyFree) {
      return {
        code: 'DELIVERY_ALREADY_FREE',
        message:
          'Este pedido ya tiene envío gratis, así que este cupón no te daría ningún ahorro adicional.',
      };
    }

    if (outcome.merchantPayout < 0) {
      return {
        code: 'COUPON_EXCEEDS_MERCHANT_PAYOUT',
        message:
          'Este cupón no se puede aplicar junto con las promociones de este pedido. ' +
          'Prueba con otro cupón o quita el que escribiste.',
      };
    }

    return null;
  }

  /**
   * Si una campaña de plataforma deja el pedido por debajo del margen que
   * finanzas fijó.
   *
   * Un cupón del comercio nunca entra: lo paga él, así que no hay margen
   * nuestro que proteger.
   *
   * `gatewayFee` es la comisión estimada de Wompi del cobro (0 en efectivo):
   * el margen que importa es el que queda después de pagarla, igual que el
   * resultado neto que reporta la plataforma (`netAfterGatewayCosts`).
   */
  breaksMarginFloor(
    coupon: AppliedCoupon | null,
    netRevenue: number,
    gatewayFee = 0
  ): boolean {
    return (
      !!coupon &&
      coupon.fundedBy === CouponFundedBy.PLATFORM &&
      netRevenue - gatewayFee < coupon.minimumContributionMargin &&
      !coupon.campaignApproved
    );
  }

  /**
   * The books must balance before any money is quoted.
   *
   * What the customer pays, plus whatever ZIPP explicitly subsidises, has
   * to equal exactly what is owed out: merchant payout, driver payout,
   * platform revenue and tax. A mismatch means a rounding or routing bug,
   * and the only safe response is to refuse to price the order.
   *
   * Un pago negativo al comercio también se rechaza aquí, como última
   * barrera: las guardas de `quote()` deberían haberlo evitado antes, y si
   * aun así llega es mejor un 422 explicable que una liquidación negativa.
   */
  private assertBalanced(parts: {
    customerTotal: number;
    platformFundedDiscount: number;
    businessPayout: number;
    driverPayout: number;
    platformGrossRevenue: number;
    taxPayable: number;
  }): void {
    if (parts.businessPayout < 0) {
      console.error('[PRICING] Pago al comercio negativo', { ...parts });
      throw new AppError(
        'Las promociones de este pedido superan lo que el comercio puede asumir. ' +
          'Quita un cupón o una promoción e inténtalo de nuevo.',
        422,
        'MERCHANT_PAYOUT_NEGATIVE'
      );
    }

    const inflow = parts.customerTotal + parts.platformFundedDiscount;
    const outflow =
      parts.businessPayout +
      parts.driverPayout +
      parts.platformGrossRevenue +
      parts.taxPayable;

    if (inflow !== outflow) {
      const error = new QuoteImbalanceError(inflow, outflow, { ...parts });
      console.error('[PRICING] Cotización descuadrada', {
        inflow,
        outflow,
        difference: inflow - outflow,
        ...parts,
      });
      throw error;
    }
  }

  /** Tips are money: reject nonsense rather than silently coercing it. */
  private normalizeTip(
    tip: number | undefined,
    subtotal: number,
    cfg: IPlatformPricingConfig
  ): number {
    if (tip === undefined || tip === null) return 0;
    if (typeof tip !== 'number' || !Number.isFinite(tip)) {
      throw new AppError('La propina no es válida', 400);
    }
    if (tip < 0) throw new AppError('La propina no puede ser negativa', 400);

    const max = applyBps(subtotal, cfg.maxTipBps);
    const rounded = Math.round(tip);
    if (rounded > max) {
      throw new AppError(
        `La propina no puede superar $${max.toLocaleString('es-CO')}`,
        400
      );
    }
    return rounded;
  }
}

export const pricingService = new PricingService();

// ── Producto que falta con aprobación del cliente (solo efectivo) ──────

/** Una línea del pedido tal como quedó al crearlo: `totalPrice = (unit + extras) × quantity`. */
export interface ShortageLineInput {
  totalPrice: number;
  quantity: number;
}

export interface RepriceShortageInput {
  /** El snapshot INMUTABLE del pedido (`order.finance`). Nunca se reescribe. */
  finance: IOrderFinance;
  /** `order.items`, en el mismo orden que `missing[].index`. */
  items: ShortageLineInput[];
  /** Qué falta: índice de la línea en `items` y cuántas unidades. */
  missing: Array<{ index: number; missingQty: number }>;
  /** La configuración de precios de LA VERSIÓN del pedido, nunca la vigente. */
  cfg: Pick<
    IPlatformPricingConfig,
    'serviceFeeFixed' | 'serviceFeeBps' | 'serviceFeeMin' | 'serviceFeeMax' | 'taxBps' | 'commissionAfterMerchantDiscount'
  >;
  /**
   * Cuánto descontó la promoción automática en CADA línea (mismo orden que
   * `items`). Hoy el pedido no lo guarda: sin esto, un pedido con
   * `autoPromotionDiscount > 0` no admite parcial (ver nota en la función).
   */
  lineProductDiscount?: number[];
  /**
   * Sobre qué línea de la cotización descontaba el cupón de PLATAFORMA del
   * pedido, si lo hubo. `finance` solo guarda el total financiado por ZIPP y
   * no distingue producto / domicilio / tarifa de servicio.
   */
  platformCouponScope?: CouponScope | null;
  /** Lo ya reembolsado: un faltante solo se calcula sobre un pedido íntegro. */
  prior?: PriorAllocation;
}

export interface ShortageRepricing {
  /** Valor bruto de lo que falta: Σ (totalPrice / quantity × missingQty). */
  removedGross: number;
  /** Cifras netas del pedido DESPUÉS del faltante. */
  after: {
    productSubtotal: number;
    customerTotal: number;
    businessPayout: number;
    merchantCommission: number;
    customerServiceFee: number;
    taxPayable: number;
    merchantFundedDiscount: number;
    platformFundedDiscount: number;
    platformGrossRevenue: number;
    cashToRemit: number;
  };
  /** Lo que cada cuenta devuelve: es el `allocation` del `Refund` PARCIAL. */
  allocation: RefundAllocation;
  /** Lo que el cliente deja de pagar. Entero COP, > 0. */
  refundAmount: number;
  /** Lo que el domiciliario deberá rendir tras entregar. */
  cashToRemitAfter: number;
}

/**
 * Recalcula un pedido en efectivo al que le falta parte de un producto.
 *
 * Es PURA: sin base de datos ni reloj. Recibe el snapshot del pedido y la
 * configuración de SU versión de precios, y devuelve cuánto se le descuenta al
 * cliente y qué cuenta paga cuánto. Si algo no cuadra lanza `AppError` 422 y la
 * única salida es cancelar el pedido: es preferible que el comercio cancele a
 * que una cifra a medias entre al libro.
 *
 * Por qué no usa `allocateRefund(PARTIAL)`: ese reparto es a prorrata de TODO
 * lo que ZIPP y el comercio tenían, y por eso cobraría margen de domicilio y
 * dejaría a ZIPP con más ingreso del que le corresponde por un producto que no
 * se entregó. Aquí el faltante es del producto: se mueve lo que dependía del
 * producto (su valor, la comisión sobre él, la tarifa de servicio si es
 * porcentual, el impuesto sobre la base) y nada más. Ejemplo: productos
 * 32.000, comisión 10 %, tarifa de servicio fija 1.000, domicilio 4.500,
 * faltan 12.000 → 10.800 salen del comercio y 1.200 de la comisión.
 *
 * Qué cambia y qué queda CONGELADO:
 *  · Cambia: subtotal, tarifa de servicio (fórmula de la versión, sin subir
 *    nunca), comisión, impuesto, el descuento de PRODUCTO (cupón de comercio,
 *    de plataforma o promoción automática, a prorrata del valor que sale) y,
 *    por tanto, el pago al comercio y el total del cliente.
 *  · Congelado: domicilio, envío gratis, descuento de Zipp Pro, cupón de
 *    domicilio, propina, margen de domicilio, pago al repartidor y los
 *    umbrales/mínimos (pedido mínimo, envío gratis, mínimo de Pro). Perder un
 *    umbral por el faltante no le cobra domicilio al cliente: lo absorbe quien
 *    ya lo financiaba. El repartidor no se toca (`fromDriverPayout = 0`).
 *
 * Promoción automática: la promoción automática descuenta solo las líneas que
 * cubre, y el pedido no guarda cuánto descontó en cada una (`items[]` no tiene
 * `productDiscount`). Repartir a prorrata sobre todo el subtotal descontaría
 * de más cuando lo que falta es una línea SIN promoción. Se decidió no
 * persistir ese dato por línea en esta versión (tocaría `quote()` y su
 * contrato HTTP): si `autoPromotionDiscount > 0` y no llega `lineProductDiscount`,
 * no se permite el parcial. La función ya sabe usarlo el día que se guarde.
 *
 * Todo es entero: el único reparto proporcional es el del descuento de
 * producto, con `Math.floor(a × b / c)` sobre enteros exactos.
 */
export function repriceShortage(input: RepriceShortageInput): ShortageRepricing {
  const { finance, items, missing, cfg, lineProductDiscount, platformCouponScope, prior } = input;

  const CANCEL = 'Cancela el pedido.';
  const fail = (why: string, code = 'ITEM_SHORTAGE_NOT_ALLOWED') =>
    new AppError(`No se puede descontar este faltante automáticamente: ${why} ${CANCEL}`, 422, code);

  if (prior && Object.values(prior).some((v) => v !== 0)) {
    throw new AppError(
      'Este pedido ya tiene un reembolso aplicado: el faltante no se puede calcular encima.',
      409,
      'ITEM_SHORTAGE_PRIOR_REFUND'
    );
  }

  const n = (value: number | undefined, label: string): number => {
    const v = value ?? 0;
    if (!Number.isSafeInteger(v) || v < 0) throw fail(`${label} no es un entero válido.`, 'ITEM_SHORTAGE_BAD_SNAPSHOT');
    return v;
  };

  const S = n(finance.productSubtotal, 'el subtotal');
  const tip = n(finance.tip, 'la propina');
  const deliveryFee = n(finance.deliveryCustomerFee, 'el domicilio');
  const F = n(finance.freeDeliveryDiscount, 'el envío gratis');
  const PD = n(finance.proDeliveryDiscount, 'el descuento de Pro al domicilio');
  const PS = n(finance.proServiceFeeDiscount, 'el descuento de Pro a la tarifa');
  const A = n(finance.autoPromotionDiscount, 'la promoción automática');
  const merchantFunded = n(finance.merchantFundedDiscount, 'lo que financia el comercio');
  const platformFunded = n(finance.platformFundedDiscount, 'lo que financia ZIPP');
  const feeBefore = n(finance.customerServiceFee, 'la tarifa de servicio');
  const driverPayout = n(finance.driverPayout, 'el pago al repartidor');

  // ── Lo que sale: valor bruto, y de la promoción automática si hay snapshot ──
  if (missing.length === 0) throw fail('no indicaste ningún producto.');

  if (A > 0) {
    if (!lineProductDiscount || lineProductDiscount.length !== items.length) {
      throw fail('el pedido tiene una promoción automática que no se puede repartir por producto.', 'ITEM_SHORTAGE_PROMO_UNSUPPORTED');
    }
    if (lineProductDiscount.reduce((sum, v) => sum + v, 0) !== A) {
      throw fail('el descuento por producto no coincide con el del pedido.', 'ITEM_SHORTAGE_BAD_SNAPSHOT');
    }
  }

  let removedGross = 0;
  let removedAuto = 0;
  let missingUnits = 0;
  const seen = new Set<number>();
  for (const m of missing) {
    const line = items[m.index];
    if (!line || seen.has(m.index)) throw fail('las líneas indicadas no son válidas.');
    seen.add(m.index);
    if (!Number.isInteger(m.missingQty) || m.missingQty < 1 || m.missingQty > line.quantity) {
      throw fail('la cantidad que falta no es válida.');
    }
    if (!Number.isInteger(line.totalPrice) || line.quantity < 1 || line.totalPrice % line.quantity !== 0) {
      throw fail('el precio de una línea no es divisible por sus unidades.', 'ITEM_SHORTAGE_BAD_SNAPSHOT');
    }
    removedGross += (line.totalPrice / line.quantity) * m.missingQty;
    removedAuto += Math.floor(((lineProductDiscount?.[m.index] ?? 0) * m.missingQty) / line.quantity);
    missingUnits += m.missingQty;
  }
  const totalUnits = items.reduce((sum, line) => sum + line.quantity, 0);
  if (missingUnits >= totalUnits) {
    throw new AppError(
      'Falta todo el pedido: no queda nada que entregar. Rechaza el pedido.',
      422,
      'ITEM_SHORTAGE_ALL_MISSING'
    );
  }
  if (removedGross <= 0 || removedGross > S) throw fail('el valor de lo que falta no es válido.', 'ITEM_SHORTAGE_BAD_SNAPSHOT');

  // ── Descuentos: cuánto es de producto y cuánto queda congelado ──
  const D_m = merchantFunded - F - A; // cupón de código del comercio (solo producto)
  if (D_m < 0) throw fail('los descuentos del pedido no cuadran.', 'ITEM_SHORTAGE_BAD_SNAPSHOT');
  const couponPlatform = platformFunded - PD - PS;
  if (couponPlatform < 0) throw fail('los descuentos del pedido no cuadran.', 'ITEM_SHORTAGE_BAD_SNAPSHOT');

  let D_p = 0; // cupón de plataforma sobre producto
  let platformDelivery = 0; // sobre domicilio: congelado
  let platformService = 0; // sobre tarifa de servicio: sigue a la tarifa
  if (couponPlatform > 0) {
    if (platformCouponScope === CouponScope.PRODUCT) D_p = couponPlatform;
    else if (platformCouponScope === CouponScope.DELIVERY) platformDelivery = couponPlatform;
    else if (platformCouponScope === CouponScope.SERVICE_FEE) platformService = couponPlatform;
    else throw fail('no se pudo determinar a qué línea descontaba el cupón de plataforma.', 'ITEM_SHORTAGE_COUPON_UNKNOWN');
  }

  // El cupón se calculó sobre el subtotal ya neto de promociones automáticas.
  const netBase = S - A;
  const removedNet = removedGross - removedAuto;
  const share = (discount: number) =>
    discount > 0 && netBase > 0 ? Math.floor((discount * removedNet) / netBase) : 0;
  const D_m2 = D_m - share(D_m);
  const D_p2 = D_p - share(D_p);
  const A2 = A - removedAuto;

  // ── Cifras posteriores ──
  const S2 = S - removedGross;

  const feeFormula = clampMoney(
    cfg.serviceFeeFixed + applyBps(S2, cfg.serviceFeeBps),
    cfg.serviceFeeMin,
    cfg.serviceFeeMax
  );
  // Nunca sube: si la fórmula diera más (cambio de redondeo), se queda la original.
  const fee2 = Math.min(feeBefore, feeFormula);
  const couponService2 = Math.min(platformService, fee2);
  const proService2 = Math.min(PS, fee2 - couponService2);

  const payableSub2 = S2 - D_m2 - D_p2 - A2;
  const payableDelivery = deliveryFee - platformDelivery - F - PD;
  const payableService2 = fee2 - couponService2 - proService2;
  if (payableSub2 < 0 || payableDelivery < 0 || payableService2 < 0) {
    throw fail('los descuentos superarían lo que queda por pagar.');
  }

  // El pedido conserva la regla con la que se cobró: si salió con reglas por
  // concepto (M-014), el faltante se recalcula con ESAS tarifas y bases —no con las
  // de hoy ni con la tasa global—; si no, con la tasa de la configuración.
  const storedLines = finance.taxBreakdown ?? [];
  const tax2 = computeCheckoutTax({
    plan: storedLines.length
      ? {
          mode: 'rules',
          status: 'definitive',
          missing: [],
          rates: Object.fromEntries(storedLines.map((l) => [l.concept, { bps: l.rateBps, base: l.base, ruleId: l.ruleId }])),
        }
      : null,
    legacyBps: cfg.taxBps,
    net: { products: payableSub2, delivery: payableDelivery, service_fee: payableService2 },
    gross: { products: S2, delivery: deliveryFee, service_fee: fee2 },
  }).taxPayable;
  const customerTotal2 = payableSub2 + payableDelivery + payableService2 + tax2 + tip;

  const merchantFunded2 = D_m2 + F + A2;
  const platformFunded2 = D_p2 + platformDelivery + couponService2 + PD + proService2;

  const commissionBase2 = cfg.commissionAfterMerchantDiscount ? S2 - D_m2 - A2 : S2;
  // Tope en la comisión original: el faltante nunca puede subirla.
  const commission2 = Math.min(
    n(finance.merchantCommission, 'la comisión'),
    applyBps(Math.max(0, commissionBase2), finance.appliedCommissionBps)
  );

  const businessPayout2 = S2 - merchantFunded2 - commission2;
  const platformGross2 = commission2 + fee2 + finance.deliveryMargin;
  const cashToRemitAfter = customerTotal2 - businessPayout2 - driverPayout;

  const allocation: RefundAllocation = {
    fromMerchantPayout: finance.businessPayout - businessPayout2,
    fromDriverPayout: 0,
    fromCommission: finance.merchantCommission - commission2,
    fromDeliveryMargin: 0,
    fromServiceFee: feeBefore - fee2,
    fromTax: finance.taxPayable - tax2,
    fromPlatform: finance.platformPromotionExpense - platformFunded2,
  };
  const refundAmount = finance.customerTotal - customerTotal2;

  // ── Invariantes: cualquiera que falle deja solo «cancelar» ──
  const values = [...Object.values(allocation), refundAmount, businessPayout2, cashToRemitAfter, customerTotal2];
  if (values.some((v) => !Number.isSafeInteger(v))) throw fail('una cifra no es entera.', 'ITEM_SHORTAGE_INVARIANT');
  if (Object.values(allocation).some((v) => v < 0)) throw fail('el recálculo subiría una cuenta.', 'ITEM_SHORTAGE_INVARIANT');
  if (refundAmount <= 0) throw fail('el faltante no cambia lo que paga el cliente.', 'ITEM_SHORTAGE_INVARIANT');
  if (customerTotal2 > finance.customerTotal) throw fail('el total del cliente subiría.', 'ITEM_SHORTAGE_INVARIANT');
  if (businessPayout2 < 0) throw fail('el comercio quedaría con un pago negativo.', 'ITEM_SHORTAGE_INVARIANT');
  if (cashToRemitAfter < 0) throw fail('el efectivo por rendir quedaría negativo.', 'ITEM_SHORTAGE_INVARIANT');
  if (customerTotal2 + platformFunded2 !== businessPayout2 + driverPayout + platformGross2 + tax2) {
    throw fail('las cifras posteriores no cuadran.', 'ITEM_SHORTAGE_INVARIANT');
  }
  if (
    allocation.fromMerchantPayout + allocation.fromCommission + allocation.fromServiceFee + allocation.fromTax !==
    refundAmount + allocation.fromPlatform
  ) {
    throw fail('el reparto del reembolso no cuadra.', 'ITEM_SHORTAGE_INVARIANT');
  }

  return {
    removedGross,
    after: {
      productSubtotal: S2,
      customerTotal: customerTotal2,
      businessPayout: businessPayout2,
      merchantCommission: commission2,
      customerServiceFee: fee2,
      taxPayable: tax2,
      merchantFundedDiscount: merchantFunded2,
      platformFundedDiscount: platformFunded2,
      platformGrossRevenue: platformGross2,
      cashToRemit: cashToRemitAfter,
    },
    allocation,
    refundAmount,
    cashToRemitAfter,
  };
}
