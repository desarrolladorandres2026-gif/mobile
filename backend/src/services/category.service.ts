import { Category, ICategory } from '../models';
import { AppError } from '../middlewares';

interface CreateCategoryInput {
  businessId: string;
  name: string;
  sortOrder?: number;
}

export class CategoryService {
  async create(input: CreateCategoryInput): Promise<ICategory> {
    return Category.create(input);
  }

  async getByBusiness(businessId: string): Promise<ICategory[]> {
    return Category.find({ businessId, isActive: true }).sort({ sortOrder: 1 });
  }

  async update(id: string, businessId: string, data: Partial<CreateCategoryInput>): Promise<ICategory> {
    const category = await Category.findById(id);
    if (!category) throw new AppError('Categoría no encontrada', 404);
    if (category.businessId.toString() !== businessId) throw new AppError('No autorizado', 403);
    Object.assign(category, data);
    await category.save();
    return category;
  }

  async delete(id: string, businessId: string): Promise<void> {
    const category = await Category.findById(id);
    if (!category) throw new AppError('Categoría no encontrada', 404);
    if (category.businessId.toString() !== businessId) throw new AppError('No autorizado', 403);
    await category.deleteOne();
  }
}

export const categoryService = new CategoryService();
