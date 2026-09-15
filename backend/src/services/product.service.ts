import { Types } from 'mongoose';
import { Product, IProduct, Category, Business } from '../models';
import type { ModifierGroup } from '../types';
import { BusinessCategory } from '../types';
import { AppError } from '../middlewares';
import { productImageService } from './productImage.service';

interface CreateProductInput {
  businessId: string;
  categoryId: string;
  name: string;
  description?: string;
  price: number;
  discountPrice?: number | null;
  prepTimeMinutes?: number | null;
  extras?: Array<{ name: string; price: number }>;
  modifierGroups?: ModifierGroup[];
  isAvailable?: boolean;
  isFeatured?: boolean;
  stock?: number | null;
  lowStockThreshold?: number;
  requiresAgeVerification?: boolean;
}

export class ProductService {
  /**
   * Los productos que más se piden de un negocio.
   *
   * Sale de los pedidos entregados, no de un campo que alguien marca a
   * mano: "destacado" dice lo que el negocio quiere vender y esto dice lo
   * que la gente compra, que rara vez es lo mismo y es lo que de verdad
   * ayuda a decidir a quien entra por primera vez.
   *
   * Solo cuentan los entregados. Incluir cancelados premiaría justamente
   * los platos que fallan.
   */
  async topSellers(businessId: string, limit = 5, withinDays = 30) {
    const { Order } = await import('../models');
    const { OrderStatus } = await import('../types');
    const since = new Date(Date.now() - withinDays * 24 * 60 * 60 * 1000);

    const rows = await Order.aggregate([
      {
        $match: {
          businessId: new Types.ObjectId(businessId),
          status: OrderStatus.DELIVERED,
          deliveredAt: { $gte: since },
        },
      },
      { $unwind: '$items' },
      { $group: { _id: '$items.productId', sold: { $sum: '$items.quantity' } } },
      { $sort: { sold: -1 } },
      { $limit: limit },
      {
        $lookup: {
          from: 'products',
          localField: '_id',
          foreignField: '_id',
          as: 'product',
        },
      },
      { $unwind: '$product' },
      // Un producto retirado de la carta no puede seguir apareciendo como
      // el más vendido: lleva a una ficha que no se puede pedir.
      { $match: { 'product.isAvailable': true } },
      {
        $replaceRoot: {
          newRoot: { $mergeObjects: ['$product', { soldCount: '$sold' }] },
        },
      },
    ]);

    return rows;
  }

  async create(input: CreateProductInput): Promise<IProduct> {
    if (!input.categoryId) {
      throw new AppError(
        'Elige una categoría para el producto. Si no tienes ninguna, créala primero.',
        400
      );
    }

    const category = await Category.findById(input.categoryId);
    if (!category || category.businessId.toString() !== input.businessId) {
      throw new AppError('Categoría no encontrada o no pertenece a este negocio', 400);
    }

    // Campo a campo, nunca el cuerpo entero. La validación de la ruta ya
    // descarta lo que no reconoce, pero el servicio también se llama desde
    // las pruebas y desde el seed, y una lista explícita es lo que impide
    // que un campo nuevo del modelo se vuelva escribible sin querer.
    return Product.create({
      businessId: input.businessId,
      categoryId: input.categoryId,
      name: input.name,
      description: input.description ?? '',
      price: input.price,
      discountPrice: input.discountPrice ?? null,
      prepTimeMinutes: input.prepTimeMinutes ?? null,
      extras: input.extras ?? [],
      modifierGroups: input.modifierGroups ?? [],
      // Faltaban. El validador los dejaba pasar y aquí se perdían: un
      // comercio que daba de alta un licor con "solo mayores" marcado, o
      // una panadería con "quedan 12", veían el producto creado sin nada
      // de eso — y sin ningún error que lo dijera.
      stock: input.stock ?? null,
      lowStockThreshold: input.lowStockThreshold ?? 0,
      requiresAgeVerification: input.requiresAgeVerification ?? false,
      // Con inventario en cero se nace agotado, igual que al editar.
      isAvailable: input.stock === 0 ? false : (input.isAvailable ?? true),
      isFeatured: input.isFeatured ?? false,
    });
  }

  /**
   * Productos disponibles de negocios de una categoría, para los carruseles
   * del home.
   *
   * `categoryKey` es el `key` de `HomeCategory` (configurado en el admin),
   * que por convención coincide con el enum `BusinessCategory` — no hay FK
   * entre ambos. Una clave que no matchea ningún valor del enum no es un
   * error: simplemente no hay negocios de esa categoría y el carrusel no
   * tiene nada que mostrar.
   */
  async getByBusinessCategory(categoryKey: string, limit = 20) {
    if (!Object.values(BusinessCategory).includes(categoryKey as BusinessCategory)) {
      return [];
    }

    const businessIds = await Business.find({
      category: categoryKey,
      isActive: true,
      isApproved: true,
    }).distinct('_id');

    if (!businessIds.length) return [];

    return Product.find({ businessId: { $in: businessIds }, isAvailable: true })
      .sort({ isFeatured: -1, createdAt: -1 })
      .limit(limit)
      .populate('businessId', 'name category');
  }

  async getByBusiness(businessId: string, categoryId?: string, includeUnavailable = false) {
    const filter: Record<string, unknown> = { businessId };
    if (!includeUnavailable) {
      filter.isAvailable = true;
    }
    if (categoryId) filter.categoryId = categoryId;
    return Product.find(filter).sort({ isFeatured: -1, name: 1 });
  }


  async getById(id: string): Promise<IProduct> {
    const product = await Product.findById(id);
    if (!product) throw new AppError('Producto no encontrado', 404);
    return product;
  }

  async update(id: string, businessId: string, data: Partial<CreateProductInput>): Promise<IProduct> {
    const product = await this.getOwned(id, businessId);

    // Mover un producto de categoría es legítimo, pero solo a una
    // categoría del mismo comercio: sin esta comprobación, un producto
    // podía acabar colgando del menú de otro.
    if (data.categoryId && data.categoryId !== product.categoryId.toString()) {
      const category = await Category.findById(data.categoryId);
      if (!category || category.businessId.toString() !== businessId) {
        throw new AppError('Categoría no encontrada o no pertenece a este negocio', 400);
      }
      product.categoryId = category._id;
    }

    if (data.name !== undefined) product.name = data.name;
    if (data.description !== undefined) product.description = data.description;
    if (data.price !== undefined) product.price = data.price;
    // `null` y no `undefined`: es el valor por defecto del esquema, y es
    // lo que ocurre cuando el comercio borra el precio con descuento.
    // Asignar `undefined` deja el borrado a merced de cómo trate Mongoose
    // ese valor, que no es lo mismo en todas las versiones.
    if (data.discountPrice !== undefined) product.discountPrice = data.discountPrice ?? null;
    if (data.prepTimeMinutes !== undefined) product.prepTimeMinutes = data.prepTimeMinutes ?? null;
    if (data.extras !== undefined) product.extras = data.extras;
    if (data.modifierGroups !== undefined) product.modifierGroups = data.modifierGroups as any;
    if (data.isAvailable !== undefined) product.isAvailable = data.isAvailable;
    if (data.isFeatured !== undefined) product.isFeatured = data.isFeatured;

    // El inventario se escribe explícitamente y admite `null`, que no es lo
    // mismo que cero: null desactiva el control, cero dice que se acabó.
    if (data.stock !== undefined) {
      product.stock = data.stock;

      // Reponer devuelve el producto a la carta sin un segundo paso. Un
      // negocio que acaba de escribir "quedan 12" no espera tener que
      // acordarse además de reactivarlo.
      if (data.stock !== null && data.stock > 0 && data.isAvailable === undefined) {
        product.isAvailable = true;
      }
      if (data.stock === 0) product.isAvailable = false;
    }
    if (data.requiresAgeVerification !== undefined) {
      product.requiresAgeVerification = data.requiresAgeVerification;
    }
    if (data.lowStockThreshold !== undefined) {
      product.lowStockThreshold = data.lowStockThreshold;
    }

    await product.save();
    return product;
  }

  async delete(id: string, businessId: string): Promise<void> {
    const product = await this.getOwned(id, businessId);

    // La foto se borra con el producto. Sin esto, cada producto eliminado
    // dejaba su imagen viviendo en Cloudinary sin que nada la
    // referenciara: archivos huérfanos que nadie sabría identificar
    // después.
    await productImageService.forget(product);
    await product.deleteOne();
  }

  /**
   * Carga un producto comprobando que pertenece a quien lo pide.
   *
   * Estaba repetido en `update` y `delete`, y va a hacer falta en las tres
   * rutas de imagen: una comprobación de propiedad copiada cuatro veces es
   * una comprobación que un día se copia mal.
   */
  async getOwned(id: string, businessId: string): Promise<IProduct> {
    const product = await Product.findById(id);
    if (!product) throw new AppError('Producto no encontrado', 404);
    if (product.businessId.toString() !== businessId) throw new AppError('No autorizado', 403);
    return product;
  }
}

export const productService = new ProductService();
