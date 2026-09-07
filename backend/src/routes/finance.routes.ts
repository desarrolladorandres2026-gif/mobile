import { Router } from 'express';
import { financeController } from '../controllers/finance.controller';
import { authenticate, authorize, validate, requireFinanceAdmin } from '../middlewares';
import {
  updatePricingConfigSchema,
  settleSchema,
  cashIdsSchema,
  cashIncidentIdSchema,
  resolveCashIncidentSchema,
} from '../validators/finance.validator';
import { adminBusinessTermsSchema } from '../validators/business.validator';
import { UserRole } from '../types';

const router = Router();

// Every finance route requires an admin session.
router.use(authenticate, authorize(UserRole.ADMIN));

// ── Read: any admin ──
router.get('/config', (req, res, next) => financeController.getConfig(req, res, next));
router.get('/config/versions', (req, res, next) =>
  financeController.listConfigVersions(req, res, next)
);
router.get('/config/audit', (req, res, next) =>
  financeController.configAudit(req, res, next)
);
router.get('/payouts/summary', (req, res, next) =>
  financeController.payoutSummary(req, res, next)
);
router.get('/settlements', (req, res, next) =>
  financeController.listSettlements(req, res, next)
);
router.get('/cash', (req, res, next) => financeController.listCash(req, res, next));
// Los faltantes de efectivo. Solo lectura para cualquier administrador:
// verlos es supervisión, decidirlos es finanzas (ver más abajo).
router.get('/cash/incidents', (req, res, next) =>
  financeController.listCashIncidents(req, res, next)
);
router.get('/ledger/summary', (req, res, next) =>
  financeController.ledgerSummary(req, res, next)
);
router.get('/ledger/orders/:orderId', (req, res, next) =>
  financeController.ledgerForOrder(req, res, next)
);

// ── Write: finance admin only ──
// These change what the platform charges or declare that money arrived.
router.put(
  '/config',
  requireFinanceAdmin,
  validate(updatePricingConfigSchema),
  (req, res, next) => financeController.updateConfig(req, res, next)
);
router.patch(
  '/businesses/:id/terms',
  requireFinanceAdmin,
  validate(adminBusinessTermsSchema),
  (req, res, next) => financeController.updateBusinessTerms(req, res, next)
);
router.post(
  '/settlements',
  requireFinanceAdmin,
  validate(settleSchema),
  (req, res, next) => financeController.settle(req, res, next)
);
router.post(
  '/cash/verify',
  requireFinanceAdmin,
  validate(cashIdsSchema),
  (req, res, next) => financeController.verifyCash(req, res, next)
);
router.post(
  '/cash/settle',
  requireFinanceAdmin,
  validate(cashIdsSchema),
  (req, res, next) => financeController.settleCash(req, res, next)
);

/**
 * Incidencias de efectivo. No hay DELETE y no lo habrá: una incidencia es
 * la prueba de por qué un saldo cambió, y borrarla dejaría el cambio sin
 * explicación. Cerrarla es `resolve`.
 */
router.post(
  '/cash/incidents/:id/review',
  requireFinanceAdmin,
  validate(cashIncidentIdSchema),
  (req, res, next) => financeController.reviewCashIncident(req, res, next)
);
router.post(
  '/cash/incidents/:id/resolve',
  requireFinanceAdmin,
  validate(resolveCashIncidentSchema),
  (req, res, next) => financeController.resolveCashIncident(req, res, next)
);

export default router;
