import { Types } from 'mongoose';
import { Business, Product, Zone, IBusiness, ICoupon, IPlatformPricingConfig } from '../models';
import { resolveModifierSelection } from '../utils/modifierSelection';
import { AppError } from '../middlewares';
import { PaymentMethod, CouponFundedBy, SelectedExtra } from '../types';
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
import { estimateRoute } from './mapbox.service';
import { couponService, AppliedCoupon } from './coupon.service';
import { pricingConfigService } from './pricingConfig.service';
import { proService, type ProBenefitsSnapshot } from './pro.service';

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
    cfg: IPlatformPricingConfig
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

    // ── Promociones automáticas por producto ──
    //
    // Sin código: se resuelven solas contra lo que hay en el carrito, antes
    // de saber si el cliente trae un cupón. `priceItems()` no sabe nada de
    // esto a propósito — ver la nota en `applyAutoPromotions`.
    const autoPromos = await couponService.autoPromotionsFor(input.businessId, new Date());
    const { appliedAutoPromotions, autoPromotionDiscount } = await this.applyAutoPromotions(
      pricedItems,
      autoPromos,
      input,
      cfg
    );
    // Forzado por el modelo: `autoApply` solo admite `fundedBy: BUSINESS`.
    const autoPromotionMerchantFunded = autoPromotionDiscount;

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

    const productDiscount = coupon?.productDiscount ?? 0;
    const deliveryDiscount = coupon?.deliveryDiscount ?? 0;
    const serviceFeeDiscount = coupon?.serviceFeeDiscount ?? 0;

    const payableSubtotal = productSubtotal - productDiscount - autoPromotionDiscount;

    const appliedCommissionBps = this.resolveCommissionBps(business, cfg);

    // ── Zipp Pro ──
    // Una consulta por cotización, contra un documento por persona. Lo que
    // devuelve no es "si pagó", es "qué tiene derecho a descontar hoy": la
    // membresía caducada no llega hasta aquí.
    const pro = await proService.benefitsFor(input.userId);

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
    } = this.settleDiscounts({
      coupon,
      productSubtotal,
      autoPromotionMerchantFunded,
      deliveryCustomerFee: delivery.customerFee,
      deliveryMargin: delivery.margin,
      customerServiceFee,
      freeDeliveryThreshold: effectiveFreeDeliveryThreshold(business, new Date(), envConfig.settlement.timezone),
      appliedCommissionBps,
      cfg,
      pro,
    });

    // Después del reparto: la tarifa de servicio que la membresía perdona
    // se decide ahí dentro, junto al resto del dinero.
    const payableServiceFee = customerServiceFee - serviceFeeDiscount - proServiceFeeDiscount;

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

    const platformPromotionExpense = platformFundedDiscount;

    // ── Contribution-margin guard ──
    // A platform campaign that costs more than the order earns is only
    // allowed when finance explicitly approved that campaign's budget.
    if (this.breaksMarginFloor(coupon, platformNetRevenueBeforeOperatingCosts)) {
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
          userId: input.userId,
          businessId: input.businessId,
          city: business.city,
          // Neto de promociones automáticas: lo que sugiere debe ahorrar
          // exactamente lo que ahorraría si de verdad se aplicara.
          productSubtotal: subtotalAfterAutoPromotions,
          autoPromotionMerchantFunded,
          deliveryCustomerFee: delivery.customerFee,
          deliveryMargin: delivery.margin,
          customerServiceFee,
          zoneId: delivery.zoneId?.toString() ?? null,
          freeDeliveryThreshold: effectiveFreeDeliveryThreshold(business, new Date(), envConfig.settlement.timezone),
          appliedCommissionBps,
          cfg,
          pro,
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
      descuentoEnvio: deliveryDiscount + freeDeliveryDiscount + proDeliveryDiscount,
      totalUsuario: customerTotal,
      subsidioPlataforma: platformFundedDiscount,
      subsidioComercio: merchantFundedDiscount,
    };
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
  private async suggestCoupon(parts: {
    userId: string;
    businessId: string;
    city?: string;
    productSubtotal: number;
    /** Ya neto de promociones automáticas — constante frente a cualquier cupón candidato. */
    autoPromotionMerchantFunded: number;
    deliveryCustomerFee: number;
    deliveryMargin: number;
    customerServiceFee: number;
    zoneId: string | null;
    freeDeliveryThreshold: number;
    appliedCommissionBps: number;
    cfg: IPlatformPricingConfig;
    pro: ProBenefitsSnapshot | null;
  }): Promise<SuggestedCoupon | null> {
    const { cfg } = parts;

    const ctx = {
      userId: parts.userId,
      businessId: parts.businessId,
      city: parts.city,
      subtotal: parts.productSubtotal,
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

    const settle = (coupon: AppliedCoupon | null) =>
      this.settleDiscounts({
        coupon,
        // `parts.productSubtotal` viene neto de la promoción (base de los
        // cupones candidatos); el reparto necesita el bruto, igual que
        // `quote()`, o la comisión y el umbral de envío gratis restarían
        // la promoción dos veces.
        productSubtotal: parts.productSubtotal + parts.autoPromotionMerchantFunded,
        autoPromotionMerchantFunded: parts.autoPromotionMerchantFunded,
        deliveryCustomerFee: parts.deliveryCustomerFee,
        deliveryMargin: parts.deliveryMargin,
        customerServiceFee: parts.customerServiceFee,
        freeDeliveryThreshold: parts.freeDeliveryThreshold,
        appliedCommissionBps: parts.appliedCommissionBps,
        cfg,
        // El mismo trato que va a aplicarse al cobrar: sin él, el sugeridor
        // juzgaría el margen de un pedido que no es el que se va a hacer.
        pro: parts.pro,
      });

    // Lo que paga el cliente antes de impuestos y propina —que no dependen
    // del cupón salvo por el redondeo—, con la misma composición que `quote`.
    const payableBeforeTax = (
      applied: AppliedCoupon | null,
      outcome: ReturnType<typeof settle>
    ) =>
      parts.productSubtotal - (applied?.productDiscount ?? 0) +
      outcome.payableDelivery +
      parts.customerServiceFee - (applied?.serviceFeeDiscount ?? 0) -
      outcome.proServiceFeeDiscount;

    const baseline = payableBeforeTax(null, settle(null));
    const savingOf = (applied: AppliedCoupon) =>
      baseline - payableBeforeTax(applied, settle(applied));

    const ranked = candidates
      .filter((coupon) => parts.productSubtotal >= coupon.minOrderAmount)
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

      // Nunca se ofrece lo que después se va a rechazar: el mismo suelo de
      // margen que aplica la cotización decide aquí, con la misma función.
      if (this.breaksMarginFloor(applied, outcome.platformNetRevenueBeforeOperatingCosts)) {
        return null;
      }

      const saving = baseline - payableBeforeTax(applied, outcome);
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
   * cupones pueda preguntar "¿y si aplicara este?" con exactamente la misma
   * aritmética con la que después se va a cobrar: si fueran dos copias, el
   * día que una cambiara la app ofrecería un ahorro que el cobro no da, que
   * es la clase de diferencia que nadie ve hasta que un cliente la reclama.
   *
   * Es pura: no toca la base ni lanza. Decidir si el resultado es aceptable
   * es trabajo de `breaksMarginFloor`.
   */
  private settleDiscounts(parts: {
    coupon: AppliedCoupon | null;
    productSubtotal: number;
    /**
     * Lo que descontó una promoción automática por producto, ya resuelto
     * por `applyAutoPromotions`. Siempre financiado por el comercio: el
     * modelo `Coupon` obliga a que `autoApply` sea `scope: PRODUCT` y
     * excluye por eso mismo `fundedBy: PLATFORM` para este modo.
     */
    autoPromotionMerchantFunded: number;
    deliveryCustomerFee: number;
    deliveryMargin: number;
    customerServiceFee: number;
    freeDeliveryThreshold: number;
    appliedCommissionBps: number;
    cfg: IPlatformPricingConfig;
    /** El trato de Zipp Pro, si esta persona lo tiene pagado hoy. */
    pro: ProBenefitsSnapshot | null;
  }): {
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
  } {
    const { coupon, productSubtotal, cfg } = parts;

    const couponMerchantFunded = coupon?.merchantFunded ?? 0;
    const couponPlatformFunded = coupon?.platformFunded ?? 0;
    const deliveryAfterCoupon = parts.deliveryCustomerFee - (coupon?.deliveryDiscount ?? 0);

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
      parts.freeDeliveryThreshold > 0 && productSubtotal >= parts.freeDeliveryThreshold;

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
    const proDeliveryDiscount =
      parts.pro?.freeDelivery && productSubtotal >= parts.pro.freeDeliveryMinSubtotal
        ? Math.max(0, deliveryAfterFree)
        : 0;

    const proServiceFeeDiscount = parts.pro?.serviceFeeWaived
      ? Math.max(0, parts.customerServiceFee - (coupon?.serviceFeeDiscount ?? 0))
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

    return {
      freeDeliveryDiscount,
      payableDelivery: deliveryAfterFree - proDeliveryDiscount,
      proDeliveryDiscount,
      proServiceFeeDiscount,
      merchantFundedDiscount,
      merchantCommission,
      platformFundedDiscount,
      platformGrossRevenue,
      platformNetRevenueBeforeOperatingCosts: platformGrossRevenue - platformFundedDiscount,
    };
  }

  /**
   * Si una campaña de plataforma deja el pedido por debajo del margen que
   * finanzas fijó.
   *
   * Un cupón del comercio nunca entra: lo paga él, así que no hay margen
   * nuestro que proteger.
   */
  private breaksMarginFloor(coupon: AppliedCoupon | null, netRevenue: number): boolean {
    return (
      !!coupon &&
      coupon.fundedBy === CouponFundedBy.PLATFORM &&
      netRevenue < coupon.minimumContributionMargin &&
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
