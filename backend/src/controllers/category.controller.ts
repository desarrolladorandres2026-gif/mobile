import { Request, Response, NextFunction } from 'express';
import { categoryService, publicCatalogService } from '../services';
import { sendResponse, param, query } from '../utils';
import { AppError, cacheHeaders } from '../middlewares';
import { UserRole } from '../types';
import { Business } from '../models';

async function assertOwnsBusiness(req: Request, businessId: string) {
  if (req.user!.role === UserRole.ADMIN) return;
  const owned = await Business.exists({ _id: businessId, ownerId: req.user!._id });
  if (!owned) throw new AppError('No autorizado para modificar este comercio', 403);
}

export class CategoryController {
  async create(req: Request, res: Response, next: NextFunction) {
    try {
      await assertOwnsBusiness(req, req.body.businessId);
      const category = await categoryService.create(req.body);
      sendResponse(res, 201, 'Categoría creada', category);
    } catch (error) {
      next(error);
    }
  }

  async getByBusiness(req: Request, res: Response, next: NextFunction) {
    try {
      const categories = await publicCatalogService.categories(param(req, 'businessId'));
      cacheHeaders(res, 'revalidate');
      sendResponse(res, 200, 'Categorías obtenidas', categories);
    } catch (error) {
      next(error);
    }
  }

  async update(req: Request, res: Response, next: NextFunction) {
    try {
      await assertOwnsBusiness(req, req.body.businessId);
      const category = await categoryService.update(
        param(req, 'id'),
        req.body.businessId,
        req.body
      );
      sendResponse(res, 200, 'Categoría actualizada', category);
    } catch (error) {
      next(error);
    }
  }

  async delete(req: Request, res: Response, next: NextFunction) {
    try {
      await assertOwnsBusiness(req, req.body.businessId);
      await categoryService.delete(param(req, 'id'), req.body.businessId);
      sendResponse(res, 200, 'Categoría eliminada');
    } catch (error) {
      next(error);
    }
  }
}

export const categoryController = new CategoryController();
