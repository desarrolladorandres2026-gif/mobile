import { Router } from 'express';
import { reviewController } from '../controllers/review.controller';
import { authenticate, authorize, validate, reviewCreateRateLimiter } from '../middlewares';
import {
  createReviewSchema, rateBusinessByDriverSchema, rateDriverByBusinessSchema,
  rateClientReasonsSchema,
} from '../validators';
import { UserRole } from '../types';
import { z } from 'zod';

const replySchema = z.object({
  body: z.object({ reply: z.string().trim().min(1).max(500) }),
});

const rateClientSchema = z.object({
  body: z.object({
    rating: z.number().int().min(1).max(5),
    notes: z.string().trim().max(500).optional(),
    reasons: rateClientReasonsSchema,
  }),
});

const moderateSchema = z.object({
  body: z.object({
    hidden: z.boolean(),
    reason: z.string().trim().max(300).optional(),
  }),
});

const router = Router();

// Create a review (only clients, after delivery)
router.post('/', authenticate, authorize(UserRole.CLIENT), reviewCreateRateLimiter, validate(createReviewSchema), (req, res, next) => reviewController.create(req, res, next));

// Lo que este cliente tiene pendiente de calificar. Va antes de las rutas
// con parámetro para que "pending" no se lea como un id.
router.get('/pending', authenticate, authorize(UserRole.CLIENT), (req, res, next) => reviewController.pending(req, res, next));

// ── Moderación (admin) ──
// Antes de las rutas con parámetro, para que "moderation" no se lea como id.
router.get('/moderation', authenticate, authorize(UserRole.ADMIN), (req, res, next) => reviewController.moderationQueue(req, res, next));
router.patch('/:id/moderate', authenticate, authorize(UserRole.ADMIN), validate(moderateSchema), (req, res, next) => reviewController.moderate(req, res, next));

// ── La otra dirección ──
// El negocio responde en público; negocio y domiciliario califican al
// cliente en privado, para el perfil de riesgo.
router.post('/:id/reply', authenticate, authorize(UserRole.BUSINESS), validate(replySchema), (req, res, next) => reviewController.reply(req, res, next));
router.post('/order/:orderId/rate-client', authenticate, authorize(UserRole.BUSINESS, UserRole.DRIVER), reviewCreateRateLimiter, validate(rateClientSchema), (req, res, next) => reviewController.rateClient(req, res, next));

// ── Comercio ↔ domiciliario ──
// Operacional: no sale a ningún perfil público, alimenta el reputationScore
// interno de cada uno.
router.post('/order/:orderId/rate-business', authenticate, authorize(UserRole.DRIVER), reviewCreateRateLimiter, validate(rateBusinessByDriverSchema), (req, res, next) => reviewController.rateBusinessByDriver(req, res, next));
router.post('/order/:orderId/rate-driver', authenticate, authorize(UserRole.BUSINESS), reviewCreateRateLimiter, validate(rateDriverByBusinessSchema), (req, res, next) => reviewController.rateDriverByBusiness(req, res, next));

// Qué le falta calificar a cada actor de este pedido.
router.get('/order/:orderId/status', authenticate, (req, res, next) => reviewController.reviewStatus(req, res, next));

// Get reviews for a business (public)
router.get('/business/:businessId', (req, res, next) => reviewController.getByBusiness(req, res, next));

// Get reviews for a driver
router.get('/driver/:driverId', authenticate, (req, res, next) => reviewController.getByDriver(req, res, next));

// Get review for a specific order
router.get('/order/:orderId', authenticate, (req, res, next) => reviewController.getByOrder(req, res, next));

export default router;
