import { Types } from 'mongoose';
import { Business, Product, Zone, IBusiness, IPlatformPricingConfig } from '../models';
import { AppError } from '../middlewares';
import { PaymentMethod, CouponFundedBy } from '../types';
import { config as envConfig } from '../config';
import {
  haversineMeters,
  isValidCoordinate,
  fromGeoPoint,
  roundToStep,
  applyBps,
  clampMoney,
  assertMoney,
  LatLng,
} from '../utils';
import { estimateRoute } from './mapbox.service';
import { couponService, AppliedCoupon } from './coupon.service';
import { pricingConfigService } from './pricingConfig.service';

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

export interface QuoteItemInput {
  productId: string;
  quantity: number;
  selectedExtras?: Array<{ name: string; quantity?: number }>;
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
}

export interface PricedItem {
  productId: Types.ObjectId;
  productName: string;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
  selectedExtras: Array<{ name: string; price: number; quantity: number }>;
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
}

/** The complete, auditable money breakdown for a cart. */
export interface Quote {
  items: PricedItem[];
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
  coupon: AppliedCoupon | null;
  minOrder: number;
  /** Cash a driver would have to remit. 0 for digital orders. */
  cashToRemit: number;

  // ── Legacy aliases, kept so existing clients keep working ──
  subtotal: number;
  deliveryFee: number;
  discount: number;
  tax: number;
  total: number;
  platformCommission: number;
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
  }> {
    if (!items || items.length === 0) {
      throw new AppError('El pedido debe tener al menos un producto', 400);
    }

    const productIds = items.map((i) => i.productId);
    const products = await Product.find({ _id: { $in: productIds } });
    const productMap = new Map(products.map((p) => [p._id.toString(), p]));

    let subtotal = 0;
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

      // Resolve each requested extra against the product's own catalogue.
      const resolvedExtras: PricedItem['selectedExtras'] = [];
      let extrasTotal = 0;

      for (const requested of item.selectedExtras || []) {
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

    return { pricedItems, subtotal: assertMoney(subtotal, 'subtotal') };
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
  deliveryWindow(business: IBusiness, destination: LatLng): { min: number; max: number } {
    const origin = fromGeoPoint(business.location);

    const prepMinutes = Math.max(0, business.deliveryTime || DEFAULT_PREP_MINUTES);
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
    };
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

    const { pricedItems, subtotal: productSubtotal } = await this.priceItems(
      input.businessId,
      input.items
    );

    const delivery = await this.priceDelivery(business, destination, cfg);
    const eta = this.deliveryWindow(business, destination);

    const zoneMinOrder = delivery.zoneId
      ? (await Zone.findById(delivery.zoneId))?.minOrder ?? 0
      : 0;
    const minOrder = Math.max(business.minOrder || 0, zoneMinOrder);

    if (minOrder && productSubtotal < minOrder) {
      throw new AppError(`El pedido mínimo es $${minOrder.toLocaleString('es-CO')}`, 400);
    }

    // ── Service fee ──
    const customerServiceFee = clampMoney(
      cfg.serviceFeeFixed + applyBps(productSubtotal, cfg.serviceFeeBps),
      cfg.serviceFeeMin,
      cfg.serviceFeeMax
    );

    // ── Coupon ──
    let coupon: AppliedCoupon | null = null;
    if (input.couponCode) {
      coupon = await couponService.validate(
        input.couponCode,
        {
          userId: input.userId,
          businessId: input.businessId,
          city: business.city,
          subtotal: productSubtotal,
          deliveryFee: delivery.customerFee,
          serviceFee: customerServiceFee,
          zoneId: delivery.zoneId?.toString() ?? null,
          userRole: 'client',
        },
        cfg
      );
    }

    const couponMerchantFunded = coupon?.merchantFunded ?? 0;
    const platformFundedDiscount = coupon?.platformFunded ?? 0;

    const productDiscount = coupon?.productDiscount ?? 0;
    const deliveryDiscount = coupon?.deliveryDiscount ?? 0;
    const serviceFeeDiscount = coupon?.serviceFeeDiscount ?? 0;

    const payableSubtotal = productSubtotal - productDiscount;
    const deliveryAfterCoupon = delivery.customerFee - deliveryDiscount;
    const payableServiceFee = customerServiceFee - serviceFeeDiscount;

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
    // negocio no tiene por qué pagar dos veces lo mismo.
    const qualifiesForFreeDelivery =
      business.freeDeliveryThreshold > 0 && productSubtotal >= business.freeDeliveryThreshold;

    const freeDeliveryDiscount = qualifiesForFreeDelivery
      ? Math.max(0, deliveryAfterCoupon)
      : 0;

    const payableDelivery = deliveryAfterCoupon - freeDeliveryDiscount;

    // Lo que el comercio termina financiando: su cupón más el envío que
    // regaló. Sale entero de su liquidación.
    const merchantFundedDiscount = couponMerchantFunded + freeDeliveryDiscount;

    // ── Commission ──
    // A platform-funded discount never shrinks the commission base: the
    // merchant sold at full price and ZIPP paid for the promotion, so ZIPP
    // still earns on the full sale. Only a merchant-funded discount reduces
    // it, and only when finance has configured it that way.
    const appliedCommissionBps = this.resolveCommissionBps(business, cfg);
    // Solo el descuento sobre PRODUCTO puede reducir la base: ahí el
    // comercio vendió más barato. El envío que regala lo paga aparte, con
    // los productos vendidos a precio completo, así que descontarlo aquí le
    // rebajaría también la comisión y ZIPP acabaría pagando parte de una
    // promoción que no decidió.
    const commissionBase = cfg.commissionAfterMerchantDiscount
      ? productSubtotal - couponMerchantFunded
      : productSubtotal;
    const merchantCommission = applyBps(Math.max(0, commissionBase), appliedCommissionBps);

    // ── Tip ──
    const tip = this.normalizeTip(input.tip, productSubtotal, cfg);

    // ── Tax ──
    const taxPayable = applyBps(
      payableSubtotal + payableDelivery + payableServiceFee,
      cfg.taxBps
    );

    const customerTotal =
      payableSubtotal + payableDelivery + payableServiceFee + taxPayable + tip;

    // ── Payouts ──
    const businessPayout = Math.max(
      0,
      productSubtotal - merchantFundedDiscount - merchantCommission
    );
    const driverPayout = delivery.driverPayout + tip;

    const platformGrossRevenue =
      merchantCommission + customerServiceFee + delivery.margin;
    const platformPromotionExpense = platformFundedDiscount;
    const platformNetRevenueBeforeOperatingCosts =
      platformGrossRevenue - platformPromotionExpense;

    // ── Contribution-margin guard ──
    // A platform campaign that costs more than the order earns is only
    // allowed when finance explicitly approved that campaign's budget.
    if (
      coupon &&
      coupon.fundedBy === CouponFundedBy.PLATFORM &&
      platformNetRevenueBeforeOperatingCosts < coupon.minimumContributionMargin &&
      !coupon.campaignApproved
    ) {
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
      coupon,
      minOrder,
      cashToRemit,

      // Legacy aliases so existing consumers keep working unchanged.
      subtotal: productSubtotal,
      deliveryFee: delivery.customerFee,
      discount: merchantFundedDiscount + platformFundedDiscount,
      tax: taxPayable,
      total: customerTotal,
      platformCommission: merchantCommission,
      precioOriginal: productSubtotal + delivery.customerFee + customerServiceFee + taxPayable + tip,
      descuentoEnvio: deliveryDiscount + freeDeliveryDiscount,
      totalUsuario: customerTotal,
      subsidioPlataforma: platformFundedDiscount,
      subsidioComercio: merchantFundedDiscount,
    };
  }

  /**
   * The books must balance before any money is quoted.
   *
   * What the customer pays, plus whatever ZIPP explicitly subsidises, has
   * to equal exactly what is owed out: merchant payout, driver payout,
   * platform revenue and tax. A mismatch means a rounding or routing bug,
   * and the only safe response is to refuse to price the order.
   */
  private assertBalanced(parts: {
    customerTotal: number;
    platformFundedDiscount: number;
    businessPayout: number;
    driverPayout: number;
    platformGrossRevenue: number;
    taxPayable: number;
  }): void {
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
