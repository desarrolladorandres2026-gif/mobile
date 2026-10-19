import { Router } from 'express';
import { categoryController } from '../controllers';
import { z } from 'zod';
import { authenticate, authorize, validate } from '../middlewares';
import { objectId } from '../validators/common';
import { UserRole } from '../types';
import { Permission } from '../security';
import { requirePermission, adminRequires, can } from '../middlewares/auth';

const router = Router();

// Sin validación el cuerpo viajaba entero hasta `Object.assign` en el servicio
// y un `businessId` con mala forma era un 500 por CastError (auditoría
// 2026-10-17). `businessId` decide a qué negocio se le pregunta el permiso,
// así que se exige con forma de id.
const name = z.string().trim().min(1, 'Escribe el nombre de la categoría').max(50);
const createCategorySchema = z.object({
  body: z.object({ businessId: objectId, name, sortOrder: z.number().int().min(0).max(10_000).optional() }).strict(),
});
const updateCategorySchema = z.object({
  params: z.object({ id: objectId }),
  body: z
    .object({
      businessId: objectId,
      name: name.optional(),
      sortOrder: z.number().int().min(0).max(10_000).optional(),
      isActive: z.boolean().optional(),
    })
    .strict(),
});
const deleteCategorySchema = z.object({
  params: z.object({ id: objectId }),
  body: z.object({ businessId: objectId }).strict(),
});

// Public
router.get('/business/:businessId', (req, res, next) => categoryController.getByBusiness(req, res, next));

// Protected
router.post('/', authenticate, authorize(UserRole.BUSINESS, UserRole.ADMIN), adminRequires(Permission.PRODUCTS_CREATE), validate(createCategorySchema), (req, res, next) => categoryController.create(req, res, next));
router.put('/:id', authenticate, authorize(UserRole.BUSINESS, UserRole.ADMIN), adminRequires(Permission.PRODUCTS_UPDATE), validate(updateCategorySchema), (req, res, next) => categoryController.update(req, res, next));
router.delete('/:id', authenticate, authorize(UserRole.BUSINESS, UserRole.ADMIN), adminRequires(Permission.PRODUCTS_DELETE), validate(deleteCategorySchema), (req, res, next) => categoryController.delete(req, res, next));

export default router;
