import { PipelineStage, Types } from 'mongoose';
import { Product, Business, ICoupon } from '../models';
import { CouponFundedBy } from '../types';
import { LatLng } from '../utils/geo';
import {
  VISIBLE_BUSINESS,
  PUBLIC_LIST_PROJECTION,
  withDistance,
  withinRadius,
  withEffectiveFreeDelivery,
} from '../utils/catalogQuery';
import { withProductImages } from '../utils/productImageUrls';
import { couponService, PublicCoupon } from './coupon.service';
import { pricingConfigService } from './pricingConfig.service';
import { resolveEffectiveDiscount } from './productPromotion.service';

/**
 * Todo lo que está en oferta, en una sola respuesta.
 *
 * Las tres piezas ya existían por separado —cupones públicos, `discountPrice`
 * por producto, `freeDeliveryThreshold` por negocio— pero solo se podían
 * consultar de una en una y, en el caso de los productos, negocio por
 * negocio. Sin esta consulta no hay forma de preguntar "¿qué está rebajado
 * cerca de mí?", y una oferta que solo se descubre entrando al comercio
 * correcto no es una oferta: es una casualidad.
 */

export interface OffersOptions {
  lat?: number;
  lng?: number;
  maxDistance?: number;
  city?: string;
  limit?: number;
}

/** Por qué este negocio está en la lista. */
export interface BusinessOffer {
  kind: 'discount' | 'free_delivery';
  label: string;
}

export interface OffersResult {
  coupons: PublicCoupon[];
  products: Record<string, unknown>[];
  businesses: Record<string, unknown>[];
}

/** Cuánto falta para que un cupón caduque. Los ya vencidos van al final. */
function msUntilExpiry(coupon: ICoupon, now: Date): number {
  const ms = coupon.validUntil.getTime() - now.getTime();
  return ms > 0 ? ms : Number.POSITIVE_INFINITY;
}

/**
 * En qué orden se ofrecen los cupones.
 *
 * Primero lo que de verdad se acaba —esa es la promesa que le hacemos a
 * quien abre la pestaña— y solo a igualdad de urgencia se adelanta lo que
 * financia el comercio.
 *
 * Ese desempate no es un detalle: un cupón del aliado le cuesta cero a Zipp
 * y trae el mismo pedido, mientras uno de plataforma sale de la caja. Hasta
 * ahora el orden no miraba quién pagaba, así que empujábamos nuestro propio
 * gasto tan fuerte como el suyo. Quién financia sigue sin salir en la
 * respuesta: se nota en el orden, no en un campo.
 *
 * Los negocios no necesitan este desempate: entran a la lista por
 * `discountPrice` o por `freeDeliveryThreshold`, que los paga el comercio
 * por definición.
 */
const EXPIRING_SOON_MS = 24 * 60 * 60 * 1000;

function rankCoupons(coupons: ICoupon[], now: Date): ICoupon[] {
  return [...coupons].sort((a, b) => {
    const urgentA = msUntilExpiry(a, now) <= EXPIRING_SOON_MS;
    const urgentB = msUntilExpiry(b, now) <= EXPIRING_SOON_MS;
    if (urgentA !== urgentB) return urgentA ? -1 : 1;
    if (urgentA) return msUntilExpiry(a, now) - msUntilExpiry(b, now);

    const merchantA = a.fundedBy === CouponFundedBy.BUSINESS;
    const merchantB = b.fundedBy === CouponFundedBy.BUSINESS;
    if (merchantA !== merchantB) return merchantA ? -1 : 1;

    return b.createdAt.getTime() - a.createdAt.getTime();
  });
}

/**
 * El descuento mínimo que merece anunciarse.
 *
 * Cinco, el mismo número que usa `discountPercent()` en la app para decidir
 * si pinta el distintivo. Si aquí entrara un 3%, el producto aparecería en
 * la pantalla de Descuentos sin ninguna marca que explicara por qué está
 * ahí: la lista diría una cosa y la tarjeta otra.
 */
const MIN_DISCOUNT_PERCENT = 5;

const DEFAULT_MAX_DISTANCE = 10_000;
const DEFAULT_LIMIT = 30;

function readCoords(options: OffersOptions): LatLng | null {
  const { lat, lng } = options;
  if (typeof lat !== 'number' || typeof lng !== 'number') return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

/**
 * `VISIBLE_BUSINESS`, pero para consultar el negocio ya unido al producto.
 *
 * Se deriva en vez de escribirse a mano para que añadir una condición de
 * visibilidad no obligue a acordarse de replicarla aquí.
 */
function joinedBusinessMatch(): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(VISIBLE_BUSINESS).map(([key, value]) => [`business.${key}`, value])
  );
}

/** "$30k", como se escribe un umbral en una etiqueta pequeña. */
function shortMoney(amount: number): string {
  return amount >= 1000 ? `$${Math.round(amount / 1000)}k` : `$${amount}`;
}

export class OffersService {
  /**
   * Productos rebajados, del mejor descuento al peor.
   *
   * El porcentaje se calcula en la base y no en JavaScript porque es el
   * criterio de orden: hacerlo después obligaría a traerse todos los
   * productos rebajados del catálogo para quedarse con treinta.
   *
   * El recorte va antes del `$lookup`, igual que en la búsqueda: unir
   * primero significaría resolver el negocio de cada producto en oferta
   * para descartar la mayoría acto seguido.
   */
  /**
   * Productos con precio de descuento manual (`Product.discountPrice`).
   *
   * Excluye los que además tienen una promoción automática activa: esos
   * los resuelve `autoPromotedProducts`, que calcula el precio con la
   * promoción — la que gana por precedencia — en vez del `discountPrice`
   * que pudo quedar desactualizado desde antes de que la promoción
   * empezara.
   */
  private async staticDiscountedProducts(
    coords: LatLng | null,
    maxDistance: number,
    city: string | undefined,
    limit: number,
    excludeProductIds: string[]
  ): Promise<Record<string, unknown>[]> {
    const businessMatch = joinedBusinessMatch();
    if (coords) {
      businessMatch['business.location'] = withinRadius(coords, maxDistance).location;
    }
    if (city) businessMatch['business.city'] = city;

    const pipeline: PipelineStage[] = [
      {
        $match: {
          isAvailable: true,
          discountPrice: { $gt: 0 },
          // Un "descuento" que no baja el precio no es un descuento. De
          // paso descarta los productos de precio cero, que provocarían
          // una división por cero en la etapa siguiente.
          $expr: { $lt: ['$discountPrice', '$price'] },
          ...(excludeProductIds.length > 0
            ? { _id: { $nin: excludeProductIds.map((id) => new Types.ObjectId(id)) } }
            : {}),
        },
      },
      {
        $addFields: {
          discountPercent: {
            // Hacia abajo, como en la app: anunciar "-20%" sobre un ahorro
            // real del 19,6% es prometer de más.
            $floor: {
              $multiply: [
                { $divide: [{ $subtract: ['$price', '$discountPrice'] }, '$price'] },
                100,
              ],
            },
          },
        },
      },
      { $match: { discountPercent: { $gte: MIN_DISCOUNT_PERCENT } } },
      { $sort: { discountPercent: -1 } },
      { $limit: limit * 3 },
      {
        $lookup: {
          from: 'businesses',
          localField: 'businessId',
          foreignField: '_id',
          as: 'business',
        },
      },
      { $unwind: '$business' },
      { $match: businessMatch },
      { $limit: limit },
      {
        $project: {
          name: 1,
          description: 1,
          price: 1,
          discountPrice: 1,
          discountPercent: 1,
          image: 1,
          imageAsset: 1,
          isAvailable: 1,
          businessId: '$business._id',
          businessName: '$business.name',
          businessCategory: '$business.category',
          businessRating: '$business.rating',
          businessDeliveryTime: '$business.deliveryTime',
          businessLocation: '$business.location',
        },
      },
    ];

    return (await Product.aggregate(pipeline)).map(withProductImages);
  }

  /**
   * Productos cubiertos por una promoción automática activa, sin
   * `discountPrice` propio (o con uno desactualizado — la promoción gana
   * de todas formas). Dos consultas en total, sin importar cuántos
   * productos tenga el catálogo: los cupones activos, y los productos que
   * cubren.
   */
  private async autoPromotedProducts(
    coords: LatLng | null,
    maxDistance: number,
    city: string | undefined,
    limit: number,
    promotions: Map<string, ICoupon>
  ): Promise<Record<string, unknown>[]> {
    if (promotions.size === 0) return [];

    const cfg = await pricingConfigService.getCurrent();
    const businessMatch = joinedBusinessMatch();
    if (coords) businessMatch['business.location'] = withinRadius(coords, maxDistance).location;
    if (city) businessMatch['business.city'] = city;

    const pipeline: PipelineStage[] = [
      {
        $match: {
          _id: { $in: [...promotions.keys()].map((id) => new Types.ObjectId(id)) },
          isAvailable: true,
        },
      },
      {
        $lookup: {
          from: 'businesses',
          localField: 'businessId',
          foreignField: '_id',
          as: 'business',
        },
      },
      { $unwind: '$business' },
      { $match: businessMatch },
      {
        $project: {
          name: 1,
          description: 1,
          price: 1,
          discountPrice: 1,
          image: 1,
          imageAsset: 1,
          isAvailable: 1,
          businessId: '$business._id',
          businessName: '$business.name',
          businessCategory: '$business.category',
          businessRating: '$business.rating',
          businessDeliveryTime: '$business.deliveryTime',
          businessLocation: '$business.location',
        },
      },
    ];

    const rows = await Product.aggregate(pipeline);

    const withDiscount = rows
      .map((row) => {
        const promo = promotions.get(row._id.toString());
        const effective = resolveEffectiveDiscount(row, promo, cfg);
        if (effective.discountPercent === null || effective.discountPercent < MIN_DISCOUNT_PERCENT) {
          return null;
        }
        return { ...row, discountPrice: effective.discountPrice, discountPercent: effective.discountPercent };
      })
      .filter((row): row is Record<string, unknown> => row !== null)
      .sort((a, b) => Number(b.discountPercent) - Number(a.discountPercent))
      .slice(0, limit);

    return withDiscount.map(withProductImages);
  }

  /** Descuentos de producto, manuales y automáticos, mezclados por porcentaje. */
  private async discountedProducts(
    coords: LatLng | null,
    maxDistance: number,
    city: string | undefined,
    limit: number
  ): Promise<Record<string, unknown>[]> {
    const promotions = await couponService.activeAutoPromotionsAcrossBusinesses(new Date());

    const [staticList, promoList] = await Promise.all([
      this.staticDiscountedProducts(coords, maxDistance, city, limit, [...promotions.keys()]),
      this.autoPromotedProducts(coords, maxDistance, city, limit, promotions),
    ]);

    return [...staticList, ...promoList]
      .sort((a, b) => Number(b.discountPercent ?? 0) - Number(a.discountPercent ?? 0))
      .slice(0, limit);
  }

  /**
   * Negocios con algo que anunciar, con el motivo ya resuelto.
   *
   * El motivo lo decide el servidor y no cada pantalla: si la app lo
   * dedujera por su cuenta, "envío gratis" acabaría significando cosas
   * distintas en la lista, en la ficha y en el carrito.
   */
  private async offerBusinesses(
    products: Record<string, unknown>[],
    coords: LatLng | null,
    maxDistance: number,
    city: string | undefined,
    limit: number
  ): Promise<Record<string, unknown>[]> {
    // El mejor descuento de cada negocio sale de los productos que ya se
    // trajeron. No hace falta una segunda consulta: son los mismos.
    const bestDiscount = new Map<string, number>();
    for (const product of products) {
      const id = String(product.businessId);
      const percent = Number(product.discountPercent) || 0;
      if (percent > (bestDiscount.get(id) ?? 0)) bestDiscount.set(id, percent);
    }

    const filter: Record<string, unknown> = {
      ...VISIBLE_BUSINESS,
      ...withinRadius(coords, maxDistance),
      $or: [
        { freeDeliveryThreshold: { $gt: 0 } },
        { _id: { $in: [...bestDiscount.keys()] } },
      ],
    };
    if (city) filter.city = city;

    // A2: misma lista blanca pública — sin `.select()`, `.lean()` devolvía
    // el documento crudo con `commissionRate(Bps)` y `ownerId`.
    const rows = await Business.find(filter).select(PUBLIC_LIST_PROJECTION).limit(limit).lean();

    const withOffer = rows
      .map((row) => {
        const percent = bestDiscount.get(row._id.toString());
        // El filtro que trajo esta fila mira el umbral crudo, sin vigencia:
        // una franja horaria que ya cerró puede dejar un negocio aquí sin
        // nada real que anunciar si tampoco tiene descuento.
        const resolved = withEffectiveFreeDelivery(row);

        if (!percent && resolved.freeDeliveryThreshold <= 0) return null;

        // El descuento manda sobre el envío gratis: es el número más grande
        // de la tarjeta. "Hasta" y no "-40%" a secas porque el porcentaje es
        // el del mejor producto, no el de la carta entera, y prometer lo
        // segundo se descubre nada más abrir el menú.
        const offer: BusinessOffer = percent
          ? { kind: 'discount', label: `Hasta -${percent}%` }
          : {
              kind: 'free_delivery',
              label: `Envío gratis desde ${shortMoney(resolved.freeDeliveryThreshold)}`,
            };

        return { ...resolved, offer, bestDiscountPercent: percent ?? 0 };
      })
      .filter((row): row is NonNullable<typeof row> => row !== null);

    const located = withDistance(withOffer, coords, 'location');

    return located.sort((a, b) => {
      if (b.bestDiscountPercent !== a.bestDiscountPercent) {
        return b.bestDiscountPercent - a.bestDiscountPercent;
      }
      return (a.distanceMeters ?? Infinity) - (b.distanceMeters ?? Infinity);
    });
  }

  async getOffers(options: OffersOptions = {}): Promise<OffersResult> {
    const {
      maxDistance = DEFAULT_MAX_DISTANCE,
      city,
      limit = DEFAULT_LIMIT,
    } = options;

    const coords = readCoords(options);

    // Los cupones no dependen de las otras dos consultas, pero los negocios
    // sí de los productos: el descuento de un negocio sale de su mejor
    // producto rebajado, así que se resuelven en dos tiempos.
    const now = new Date();
    const [rawCoupons, products, pricing] = await Promise.all([
      couponService.getPublic(city),
      this.discountedProducts(coords, maxDistance, city, limit),
      pricingConfigService.getCurrent(),
    ]);

    // Saneados aquí y no en el controlador, porque lo que se guarda en la
    // caché de 60 s es esto: si se filtrara después, el documento entero
    // —presupuesto y margen incluidos— seguiría viviendo en Redis.
    const coupons = rankCoupons(rawCoupons, now).map((c) => couponService.publicView(c, pricing, now));

    const businesses = await this.offerBusinesses(
      products,
      coords,
      maxDistance,
      city,
      limit
    );

    return { coupons, products, businesses };
  }
}

export const offersService = new OffersService();
