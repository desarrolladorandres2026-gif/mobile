import { Router } from 'express';
import { reviewController } from '../controllers/review.controller';
import { authenticate, authorize, validate } from '../middlewares';
import { createReviewSchema } from '../validators';
import { UserRole } from '../types';

const router = Router();

// Create a review (only clients, after delivery)
router.post('/', authenticate, authorize(UserRole.CLIENT), validate(createReviewSchema), (req, res, next) => reviewController.create(req, res, next));

// Get reviews for a business (public)
router.get('/business/:businessId', (req, res, next) => reviewController.getByBusiness(req, res, next));

// Get reviews for a driver
router.get('/driver/:driverId', authenticate, (req, res, next) => reviewController.getByDriver(req, res, next));

// Get review for a specific order
router.get('/order/:orderId', authenticate, (req, res, next) => reviewController.getByOrder(req, res, next));

export default router;
