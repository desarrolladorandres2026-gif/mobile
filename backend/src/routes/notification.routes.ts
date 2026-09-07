import { Router } from 'express';
import { notificationController } from '../controllers/notification.controller';
import { authenticate } from '../middlewares';

const router = Router();

// All routes require authentication
router.use(authenticate);

router.get('/', (req, res, next) => notificationController.getMyNotifications(req, res, next));
router.get('/unread-count', (req, res, next) => notificationController.getUnreadCount(req, res, next));
router.post('/devices', (req, res, next) => notificationController.registerDevice(req, res, next));
router.delete('/devices', (req, res, next) => notificationController.unregisterDevice(req, res, next));
router.patch('/read-all', (req, res, next) => notificationController.markAllAsRead(req, res, next));
router.patch('/:id/read', (req, res, next) => notificationController.markAsRead(req, res, next));
router.delete('/:id', (req, res, next) => notificationController.delete(req, res, next));

export default router;
