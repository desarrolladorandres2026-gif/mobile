import { Router } from 'express';
import { categoryController } from '../controllers';
import { authenticate, authorize } from '../middlewares';
import { UserRole } from '../types';
import { Permission } from '../security';
import { requirePermission, adminRequires, can } from '../middlewares/auth';

const router = Router();

// Public
router.get('/business/:businessId', (req, res, next) => categoryController.getByBusiness(req, res, next));

// Protected
router.post('/', authenticate, authorize(UserRole.BUSINESS, UserRole.ADMIN), adminRequires(Permission.PRODUCTS_CREATE), (req, res, next) => categoryController.create(req, res, next));
router.put('/:id', authenticate, authorize(UserRole.BUSINESS, UserRole.ADMIN), adminRequires(Permission.PRODUCTS_UPDATE), (req, res, next) => categoryController.update(req, res, next));
router.delete('/:id', authenticate, authorize(UserRole.BUSINESS, UserRole.ADMIN), adminRequires(Permission.PRODUCTS_DELETE), (req, res, next) => categoryController.delete(req, res, next));

export default router;
