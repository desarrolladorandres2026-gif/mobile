import { Router } from 'express';
import { addressController } from '../controllers';
import { authenticate, geocodeRateLimiter, validate } from '../middlewares';
import { reverseGeocodeSchema, searchPlacesSchema, updateAddressSchema } from '../validators';

const router = Router();

router.use(authenticate);

router.get('/', (req, res, next) => addressController.getAll(req, res, next));

/**
 * Va antes que `/:id` a propósito.
 *
 * Express casa por orden de declaración: puesta después, esta ruta jamás
 * se alcanzaría porque `/:id` ya habría capturado "reverse-geocode" como
 * si fuera el identificador de una dirección.
 */
router.get(
  '/reverse-geocode',
  geocodeRateLimiter,
  validate(reverseGeocodeSchema),
  (req, res, next) => addressController.reverseGeocode(req, res, next)
);
/** Va antes que `/:id` por el mismo motivo que `/reverse-geocode`. */
router.get(
  '/search',
  geocodeRateLimiter,
  validate(searchPlacesSchema),
  (req, res, next) => addressController.search(req, res, next)
);
router.post('/', (req, res, next) => addressController.create(req, res, next));
router.delete('/:id', (req, res, next) => addressController.delete(req, res, next));
router.patch('/:id/default', (req, res, next) => addressController.setDefault(req, res, next));
router.patch('/:id', validate(updateAddressSchema), (req, res, next) =>
  addressController.update(req, res, next)
);

export default router;
