import { PipelineStage } from 'mongoose';
import { Product, Business, ICoupon } from '../models';
import { LatLng } from '../utils/geo';
import { VISIBLE_BUSINESS, withDistance, withinRadius } from '../utils/catalogQuery';
import { couponService } from './coupon.service';

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
  coupons: ICoupon[];
  products: Record<string, unknown>[];
  businesses: Record<string, unknown>[];
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
  private async discountedProducts(
    coords: LatLng | null,
    maxDistance: number,
    city: string | undefined,
    limit: number
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
          businessRating: '$business.rating',
          businessDeliveryTime: '$business.deliveryTime',
          businessLocation: '$business.location',
        },
      },
    ];

    return Product.aggregate(pipeline);
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

    const rows = await Business.find(filter).limit(limit).lean();

    const withOffer = rows.map((row) => {
      const percent = bestDiscount.get(row._id.toString());

      // El descuento manda sobre el envío gratis: es el número más grande
      // de la tarjeta. "Hasta" y no "-40%" a secas porque el porcentaje es
      // el del mejor producto, no el de la carta entera, y prometer lo
      // segundo se descubre nada más abrir el menú.
      const offer: BusinessOffer = percent
        ? { kind: 'discount', label: `Hasta -${percent}%` }
        : {
            kind: 'free_delivery',
            label: `Envío gratis desde ${shortMoney(row.freeDeliveryThreshold)}`,
          };

      return { ...row, offer, bestDiscountPercent: percent ?? 0 };
    });

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
    const [coupons, products] = await Promise.all([
      couponService.getPublic(city),
      this.discountedProducts(coords, maxDistance, city, limit),
    ]);

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
