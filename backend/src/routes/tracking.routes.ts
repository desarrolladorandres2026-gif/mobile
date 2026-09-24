import { Router } from 'express';
import { trackingController } from '../controllers/tracking.controller';
import { authenticate, authorize, validate } from '../middlewares';
import { pingSchema, routeSchema, nearestSchema } from '../validators/tracking.validator';
import { UserRole } from '../types';
import { requirePermission, adminRequires } from '../middlewares/auth';
import { Permission } from '../security';

const router = Router();

/**
 * Seguimiento en vivo: mapas, posiciones y rutas.
 *
 * Ninguna ruta es pública. La ubicación de una persona es dato sensible y
 * el token de Mapbox es una cuota que alguien paga; ambos exigen sesión.
 *
 * Nota sobre el filtrado por pedido: `authorize()` aquí solo comprueba el
 * rol *de plataforma*. Quién puede ver un pedido concreto lo decide
 * `resolveOrderAccess` dentro del servicio — la misma función que gobierna
 * el chat y las evidencias. Poner esa comprobación en la ruta la duplicaría
 * y acabaría desincronizada.
 */

// Config de mapas: cualquier sesión válida. La app la pide al arrancar.
router.get('/config', authenticate, (req, res, next) => trackingController.config(req, res, next));

// Seguimiento de un pedido: cliente, comercio, repartidor o admin — lo
// resuelve el servicio contra la base, no el rol.
router.get('/orders/:orderId', authenticate, adminRequires(Permission.ORDERS_VIEW_ALL), (req, res, next) =>
  trackingController.order(req, res, next)
);

// Ruta óptima y recálculo. Solo el repartidor asignado (o un admin).
router.post(
  '/orders/:orderId/route',
  authenticate,
  authorize(UserRole.DRIVER, UserRole.ADMIN),
  adminRequires(Permission.ORDERS_VIEW_ALL),
  validate(routeSchema),
  (req, res, next) => trackingController.route(req, res, next)
);

// Respaldo REST del socket, y canal de la tarea en segundo plano.
router.post(
  '/ping',
  authenticate,
  authorize(UserRole.DRIVER),
  validate(pingSchema),
  (req, res, next) => trackingController.ping(req, res, next)
);

// Panel admin
router.get('/fleet', authenticate, authorize(UserRole.ADMIN), requirePermission(Permission.DRIVERS_TRACK), (req, res, next) =>
  trackingController.fleet(req, res, next)
);

router.get(
  '/nearest',
  authenticate,
  authorize(UserRole.ADMIN),
  requirePermission(Permission.DRIVERS_TRACK),
  validate(nearestSchema),
  (req, res, next) => trackingController.nearest(req, res, next)
);

export default router;
