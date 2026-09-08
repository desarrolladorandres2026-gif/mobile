import { Types } from 'mongoose';
import { Favorite, FavoriteKind, Business, Product } from '../models';
import { AppError } from '../middlewares/errorHandler';

/**
 * Favoritos del cliente.
 *
 * Antes vivían en el almacenamiento local del teléfono: cambiar de móvil o
 * reinstalar la app borraba la lista entera. Es de las pocas cosas que un
 * usuario construye a mano, una por una, así que perderla se nota.
 */
export class FavoriteService {
  /**
   * Marca algo como favorito.
   *
   * El upsert lo hace repetible a propósito: la app puede reintentar tras
   * quedarse sin conexión sin tener que averiguar antes si ya lo mandó.
   */
  async add(userId: string, kind: FavoriteKind, targetId: string) {
    // Se comprueba que exista antes de guardarlo. Sin esto, la lista puede
    // acabar llena de referencias a negocios borrados que la app tiene que
    // filtrar en cada pantalla.
    const exists =
      kind === 'business'
        ? await Business.exists({ _id: targetId })
        : await Product.exists({ _id: targetId });

    if (!exists) {
      throw new AppError(
        kind === 'business' ? 'Negocio no encontrado' : 'Producto no encontrado',
        404
      );
    }

    return Favorite.findOneAndUpdate(
      { userId, kind, targetId },
      { $setOnInsert: { userId, kind, targetId } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  }

  async remove(userId: string, kind: FavoriteKind, targetId: string): Promise<void> {
    await Favorite.deleteOne({ userId, kind, targetId });
  }

  /** Los ids marcados, para que la app pinte el corazón lleno sin más consultas. */
  async ids(userId: string): Promise<{ businesses: string[]; products: string[] }> {
    const favorites = await Favorite.find({ userId }).select('kind targetId').lean();

    return {
      businesses: favorites.filter((f) => f.kind === 'business').map((f) => f.targetId.toString()),
      products: favorites.filter((f) => f.kind === 'product').map((f) => f.targetId.toString()),
    };
  }

  /**
   * La lista con su contenido, para la pantalla de favoritos.
   *
   * Se resuelve en dos consultas —una por tipo— en vez de una por elemento.
   * Un cliente con treinta favoritos haría treinta viajes a la base cada
   * vez que abre la pantalla.
   */
  async list(userId: string) {
    const favorites = await Favorite.find({ userId }).sort({ createdAt: -1 }).lean();

    const businessIds = favorites.filter((f) => f.kind === 'business').map((f) => f.targetId);
    const productIds = favorites.filter((f) => f.kind === 'product').map((f) => f.targetId);

    const [businesses, products] = await Promise.all([
      businessIds.length
        ? Business.find({ _id: { $in: businessIds }, isActive: true, isApproved: true }).lean()
        : [],
      productIds.length
        ? Product.find({ _id: { $in: productIds } }).populate('businessId', 'name').lean()
        : [],
    ]);

    return { businesses, products };
  }

  /**
   * Sube de golpe lo que la app tenía guardado en el teléfono.
   *
   * Es la migración de un solo uso por usuario: la primera vez que abre la
   * versión nueva, sus favoritos locales suben y a partir de ahí mandan los
   * del servidor. Sin esto, estrenar la sincronización empezaría vaciándole
   * la lista, que es la peor forma posible de mejorar algo.
   */
  async importLocal(
    userId: string,
    items: Array<{ kind: FavoriteKind; targetId: string }>
  ): Promise<number> {
    if (!items.length) return 0;

    // Los ids llegan como texto desde la app; el esquema los guarda como
    // ObjectId. Convertirlos aquí evita crear filas duplicadas que solo se
    // diferencian en el tipo del campo.
    const operations = items
      .slice(0, 200)
      .filter((item) => Types.ObjectId.isValid(item.targetId))
      .map((item) => ({
        updateOne: {
          filter: {
            userId: new Types.ObjectId(userId),
            kind: item.kind,
            targetId: new Types.ObjectId(item.targetId),
          },
          update: {
            $setOnInsert: {
              userId: new Types.ObjectId(userId),
              kind: item.kind,
              targetId: new Types.ObjectId(item.targetId),
            },
          },
          upsert: true,
        },
      }));

    if (!operations.length) return 0;

    // `ordered: false` para que una referencia inválida —un negocio que ya
    // no existe— no aborte el resto de la importación.
    const result = await Favorite.bulkWrite(operations, { ordered: false });
    return result.upsertedCount ?? 0;
  }
}

export const favoriteService = new FavoriteService();
