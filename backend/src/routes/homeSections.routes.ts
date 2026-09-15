import { Router } from 'express';
import { homeSectionsController } from '../controllers/homeSections.controller';

const router = Router();

// Pública: descubrir productos es lo primero que hace alguien que abre la
// app, igual que `/search` y `/offers`.
router.get('/', (req, res, next) => homeSectionsController.get(req, res, next));

export default router;
