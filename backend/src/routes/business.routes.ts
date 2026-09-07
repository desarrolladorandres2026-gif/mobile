import { Router } from 'express';
import { businessController } from '../controllers';
import { authenticate, authorize } from '../middlewares';
import { validate } from '../middlewares';
import { createBusinessSchema, updateBusinessSchema } from '../validators';
import { UserRole } from '../types';

const router = Router();

// Public
router.get('/', (req, res, next) => businessController.getAll(req, res, next));
router.get('/slug/:slug', (req, res, next) => businessController.getBySlug(req, res, next));
router.get('/:id', (req, res, next) => businessController.getById(req, res, next));

// Protected – owner/admin
router.post('/', authenticate, authorize(UserRole.BUSINESS, UserRole.ADMIN), validate(createBusinessSchema), (req, res, next) => businessController.create(req, res, next));
router.put('/:id', authenticate, authorize(UserRole.BUSINESS, UserRole.ADMIN), validate(updateBusinessSchema), (req, res, next) => businessController.update(req, res, next));
router.delete('/:id', authenticate, authorize(UserRole.BUSINESS, UserRole.ADMIN), (req, res, next) => businessController.delete(req, res, next));
router.get('/my/businesses', authenticate, authorize(UserRole.BUSINESS, UserRole.ADMIN), (req, res, next) => businessController.getMyBusinesses(req, res, next));

// Lo que ZIPP le debe a este comercio. La propiedad se verifica en el
// controlador: un comercio no puede leer las cifras de otro.
router.get('/:id/statement', authenticate, authorize(UserRole.BUSINESS, UserRole.ADMIN), (req, res, next) => businessController.getStatement(req, res, next));
router.get('/:id/statement/lines', authenticate, authorize(UserRole.BUSINESS, UserRole.ADMIN), (req, res, next) => businessController.getStatementLines(req, res, next));

export default router;
