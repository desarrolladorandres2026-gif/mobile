import { Router } from 'express';
import { notificationController } from '../controllers/notification.controller';
import { authenticate, rejectCounterScope } from '../middlewares';

// El mostrador (sesión `counter`, decisión 2026-10-09) usa la cuenta del
// dueño: no registra su push en ella ni borra o da por leídas sus alertas,
// entre ellas las de seguridad ("cambiaron los datos legales…").

const router = Router();

// All routes require authentication
router.use(authenticate);

router.get('/', (req, res, next) => notificationController.getMyNotifications(req, res, next));
router.get('/unread-count', (req, res, next) => notificationController.getUnreadCount(req, res, next));
router.post('/devices', rejectCounterScope, (req, res, next) => notificationController.registerDevice(req, res, next));
router.delete('/devices', rejectCounterScope, (req, res, next) => notificationController.unregisterDevice(req, res, next));
router.patch('/read-all', rejectCounterScope, (req, res, next) => notificationController.markAllAsRead(req, res, next));
router.patch('/:id/read', (req, res, next) => notificationController.markAsRead(req, res, next));
router.delete('/:id', rejectCounterScope, (req, res, next) => notificationController.delete(req, res, next));

export default router;
