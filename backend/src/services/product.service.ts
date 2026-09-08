import { Types } from 'mongoose';
import { Product, IProduct, Category } from '../models';
import { AppError } from '../middlewares';
import { productImageService } from './productImage.service';

interface CreateProductInput {
  businessId: string;
  categoryId: string;
  name: string;
  description?: string;
  price: number;
  discountPrice?: number | null;
  extras?: Array<{ name: string; price: number }>;
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
      extras: input.extras ?? [],
      isAvailable: input.isAvailable ?? true,
      isFeatured: input.isFeatured ?? false,
    });
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
    if (data.extras !== undefined) product.extras = data.extras;
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
