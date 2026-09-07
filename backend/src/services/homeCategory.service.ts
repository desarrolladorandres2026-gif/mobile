import { HomeCategory, IHomeCategory } from '../models';
import { AppError } from '../middlewares';
import { cloudinary } from '../config';

export class HomeCategoryService {
  /** Todas, para el panel — incluye inactivas. */
  list(): Promise<IHomeCategory[]> {
    return HomeCategory.find().sort({ order: 1, createdAt: 1 });
  }

  /** Solo lo que la app debe pintar, ya ordenado. */
  listActive(): Promise<IHomeCategory[]> {
    return HomeCategory.find({ status: 'active' }).sort({ order: 1, createdAt: 1 });
  }

  async getById(id: string): Promise<IHomeCategory> {
    const category = await HomeCategory.findById(id);
    if (!category) throw new AppError('Categoría no encontrada', 404);
    return category;
  }

  /** Siguiente hueco al final, para que una categoría nueva no se cuele al frente. */
  async nextOrder(): Promise<number> {
    const last = await HomeCategory.findOne().sort({ order: -1 }).select('order');
    return last ? Math.min(last.order + 1, 999) : 0;
  }

  create(data: Partial<IHomeCategory>): Promise<IHomeCategory> {
    return HomeCategory.create(data);
  }

  async update(id: string, data: Partial<IHomeCategory>): Promise<IHomeCategory> {
    const category = await this.getById(id);
    Object.assign(category, data);
    await category.save();
    return category;
  }

  async remove(id: string): Promise<IHomeCategory> {
    const category = await this.getById(id);
    await category.deleteOne();
    return category;
  }

  /**
   * Sube la imagen a Cloudinary y devuelve la URL ya optimizada.
   *
   * Mismo enfoque que `promotionBannerService.uploadBannerImage`: nada toca
   * disco, el buffer va directo a Cloudinary y se guarda ya acotado.
   */
  uploadImage(buffer: Buffer): Promise<string> {
    return new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder: 'zipp/home-categories',
          resource_type: 'image',
          transformation: [{ width: 400, crop: 'limit' }, { quality: 'auto', fetch_format: 'auto' }],
        },
        (error, result) => {
          if (error || !result) {
            reject(new AppError('No se pudo subir la imagen', 502));
            return;
          }
          resolve(result.secure_url);
        }
      );
      stream.end(buffer);
    });
  }
}

export const homeCategoryService = new HomeCategoryService();
