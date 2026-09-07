import { Router } from 'express';
import { orderController, orderFlowController } from '../controllers';
import { authenticate, authorize } from '../middlewares';
import { validate } from '../middlewares';
import {
  orderCodeRateLimiter,
  orderChatRateLimiter,
  orderEvidenceRateLimiter,
  orderCallRateLimiter,
  cashConfirmRateLimiter,
} from '../middlewares';
import {
  createOrderSchema,
  updateOrderStatusSchema,
  quoteOrderSchema,
  verifyOrderCodeSchema,
  orderArrivalSchema,
  orderChatMessageSchema,
  orderCallSchema,
  confirmCashSchema,
  changePaymentMethodSchema,
} from '../validators';
import { UserRole } from '../types';

const router = Router();

router.post('/quote', authenticate, authorize(UserRole.CLIENT), validate(quoteOrderSchema), (req, res, next) => orderController.quote(req, res, next));
router.post('/', authenticate, authorize(UserRole.CLIENT), validate(createOrderSchema), (req, res, next) => orderController.create(req, res, next));
router.get('/my', authenticate, (req, res, next) => orderController.getMyOrders(req, res, next));
router.get('/business/:businessId', authenticate, authorize(UserRole.BUSINESS, UserRole.ADMIN), (req, res, next) => orderController.getBusinessOrders(req, res, next));
router.get('/driver/available', authenticate, authorize(UserRole.DRIVER, UserRole.ADMIN), (req, res, next) => orderController.getAvailableOrders(req, res, next));
router.get('/driver/my', authenticate, authorize(UserRole.DRIVER), (req, res, next) => orderController.getDriverOrders(req, res, next));
router.get('/:id/receipt', authenticate, (req, res, next) => orderController.receipt(req, res, next));

// ── Traspaso físico del pedido ───────────────────────────────────────
//
// Ninguna de estas rutas lleva `authorize(...)`: el rol de plataforma no
// dice nada útil aquí. Lo que importa es la relación con *este* pedido, y
// eso lo resuelve `resolveOrderAccess` dentro de cada acción, con el
// pedido ya cargado. Un `authorize(DRIVER)` daría una falsa sensación de
// control mientras deja pasar al domiciliario de otro reparto.
//
// Van declaradas antes que `/:id` para que Express no interprete
// "pickup" como un identificador de pedido.

router.get('/:id/flow', authenticate, (req, res, next) => orderFlowController.getState(req, res, next));

// Recogida en el comercio
router.post('/:id/pickup/arrive', authenticate, validate(orderArrivalSchema), (req, res, next) => orderFlowController.arriveAtStore(req, res, next));
router.post('/:id/pickup/evidence', authenticate, orderEvidenceRateLimiter, (req, res, next) => orderFlowController.uploadPickupEvidence(req, res, next));
router.post('/:id/pickup/verify', authenticate, orderCodeRateLimiter, validate(verifyOrderCodeSchema), (req, res, next) => orderFlowController.verifyPickup(req, res, next));

// Entrega al cliente
router.post('/:id/delivery/arrive', authenticate, validate(orderArrivalSchema), (req, res, next) => orderFlowController.arriveAtCustomer(req, res, next));
router.post('/:id/delivery/evidence', authenticate, orderEvidenceRateLimiter, (req, res, next) => orderFlowController.uploadDeliveryEvidence(req, res, next));
router.post('/:id/delivery/verify', authenticate, orderCodeRateLimiter, validate(verifyOrderCodeSchema), (req, res, next) => orderFlowController.verifyDelivery(req, res, next));

/**
 * Cobro en efectivo. Sin `authorize(DRIVER)`, igual que el resto del
 * traspaso: lo que autoriza no es el rol sino ser el domiciliario *de
 * este* pedido, y eso lo resuelve `resolveOrderAccess` con el pedido ya
 * cargado. Un `authorize` aquí daría sensación de control mientras deja
 * pasar al domiciliario de otro reparto.
 *
 * Declarada antes de `/:id` para que Express no lea "cash" como un id.
 */
router.post(
  '/:id/cash/confirm',
  authenticate,
  cashConfirmRateLimiter,
  validate(confirmCashSchema),
  (req, res, next) => orderFlowController.confirmCash(req, res, next)
);

router.get('/:id/evidence', authenticate, (req, res, next) => orderFlowController.listEvidence(req, res, next));
router.get('/:id/timeline', authenticate, (req, res, next) => orderFlowController.getTimeline(req, res, next));

// Chat del pedido
router.get('/:id/chat', authenticate, (req, res, next) => orderFlowController.getChat(req, res, next));
router.post('/:id/chat/messages', authenticate, orderChatRateLimiter, validate(orderChatMessageSchema), (req, res, next) => orderFlowController.sendMessage(req, res, next));
router.post('/:id/chat/read', authenticate, (req, res, next) => orderFlowController.markChatRead(req, res, next));

// Llamadas del pedido
router.get('/:id/calls', authenticate, (req, res, next) => orderFlowController.listCalls(req, res, next));
router.post('/:id/call', authenticate, orderCallRateLimiter, (req, res, next) => orderFlowController.startCall(req, res, next));
router.post('/:id/call/:callId/answer', authenticate, validate(orderCallSchema), (req, res, next) => orderFlowController.answerCall(req, res, next));
router.post('/:id/call/:callId/end', authenticate, validate(orderCallSchema), (req, res, next) => orderFlowController.endCall(req, res, next));

router.get('/:id', authenticate, (req, res, next) => orderController.getById(req, res, next));
router.patch('/:id/status', authenticate, validate(updateOrderStatusSchema), (req, res, next) => orderController.updateStatus(req, res, next));
router.patch('/:id/assign-driver', authenticate, authorize(UserRole.ADMIN, UserRole.DRIVER), (req, res, next) => orderController.assignDriver(req, res, next));

// Cambiar de método antes de que el comercio acepte. Solo el cliente:
// nadie más tiene por qué decidir cómo paga.
router.patch(
  '/:id/payment-method',
  authenticate,
  authorize(UserRole.CLIENT),
  validate(changePaymentMethodSchema),
  (req, res, next) => orderController.changePaymentMethod(req, res, next)
);


export default router;
