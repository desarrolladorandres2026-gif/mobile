import { Router } from 'express';
import { exploreController } from '../controllers/explore.controller';
import { identifyIfPossible } from '../middlewares';

const router = Router();

// Pública, pero mejor con sesión: explorar es de lo primero que hace alguien
// que abre la app, así que exigir cuenta sería cerrarle la puerta justo a
// quien todavía está decidiendo si se registra. Cuando sí hay sesión, el
// feed puede rotar por persona y traer sus secciones personales.
router.get('/', identifyIfPossible, (req, res, next) => exploreController.get(req, res, next));

export default router;
