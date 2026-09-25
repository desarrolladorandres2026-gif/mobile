import { Router } from 'express';
import { financeController } from '../controllers/finance.controller';
import { authenticate, authorize, validate, requirePermission, payoutAccountRevealRateLimiter, businessFiscalRateLimiter } from '../middlewares';
import {
  updatePricingConfigSchema,
  settleSchema,
  settlementPaymentSchema,
  settlementIdParamSchema,
  cashIdsSchema,
  verifyCashSchema,
  cashIncidentIdSchema,
  resolveCashIncidentSchema,
  listClawbacksSchema,
  listSettlementsSchema,
  listPayablesSchema,
  listPaymentsSchema,
  paymentsDailySchema,
  financeExportSchema,
  listAdInvoicesSchema,
  listFiscalDocumentsSchema,
  collectAdInvoiceSchema,
  collectClawbackSchema,
  writeOffClawbackSchema,
} from '../validators/finance.validator';
import { adminBusinessTermsSchema } from '../validators/business.validator';
import { UserRole } from '../types';
import { Permission } from '../security';

const router = Router();

// Every finance route requires an admin session.
router.use(authenticate, authorize(UserRole.ADMIN));

// ── Lectura: finance:view ──
router.get('/config', requirePermission(Permission.FINANCE_VIEW), (req, res, next) => financeController.getConfig(req, res, next));
router.get('/config/versions', requirePermission(Permission.FINANCE_VIEW), (req, res, next) =>
  financeController.listConfigVersions(req, res, next)
);
router.get('/config/audit', requirePermission(Permission.FINANCE_VIEW), (req, res, next) =>
  financeController.configAudit(req, res, next)
);
router.get('/payouts/summary', requirePermission(Permission.FINANCE_VIEW), (req, res, next) =>
  financeController.payoutSummary(req, res, next)
);
router.get(
  '/settlements',
  requirePermission(Permission.FINANCE_VIEW),
  validate(listSettlementsSchema),
  (req, res, next) => financeController.listSettlements(req, res, next)
);
// Exportes contables: `reports:export` + ver finanzas, y además motivo y TOTP en el cuerpo.
router.post(
  '/exports/:kind',
  requirePermission(Permission.REPORTS_EXPORT),
  requirePermission(Permission.FINANCE_VIEW),
  validate(financeExportSchema),
  (req, res, next) => financeController.exportFinance(req, res, next)
);
// Comprobantes internos (INT-): emitir es finanzas; leer, cualquiera con finance:view.
router.post(
  '/settlements/:id/document',
  requirePermission(Permission.FINANCE_MANAGE),
  validate(settlementIdParamSchema),
  (req, res, next) => financeController.issueSettlementDocument(req, res, next)
);
router.get(
  '/documents',
  requirePermission(Permission.FINANCE_VIEW),
  validate(listFiscalDocumentsSchema),
  (req, res, next) => financeController.listFiscalDocuments(req, res, next)
);
router.get(
  '/documents/:id',
  requirePermission(Permission.FINANCE_VIEW),
  validate(settlementIdParamSchema),
  (req, res, next) => financeController.getFiscalDocument(req, res, next)
);
router.get(
  '/ad-invoices',
  requirePermission(Permission.FINANCE_VIEW),
  validate(listAdInvoicesSchema),
  (req, res, next) => financeController.listAdInvoices(req, res, next)
);
router.post(
  '/ad-invoices/:id/collect',
  requirePermission(Permission.FINANCE_MANAGE),
  validate(collectAdInvoiceSchema),
  (req, res, next) => financeController.collectAdInvoice(req, res, next)
);
router.get(
  '/payments',
  requirePermission(Permission.FINANCE_VIEW),
  validate(listPaymentsSchema),
  (req, res, next) => financeController.listPayments(req, res, next)
);
router.get(
  '/payments/daily',
  requirePermission(Permission.FINANCE_VIEW),
  validate(paymentsDailySchema),
  (req, res, next) => financeController.paymentsDaily(req, res, next)
);
router.get(
  '/payables',
  requirePermission(Permission.FINANCE_VIEW),
  validate(listPayablesSchema),
  (req, res, next) => financeController.listPayables(req, res, next)
);
router.get(
  '/clawbacks',
  requirePermission(Permission.FINANCE_VIEW),
  validate(listClawbacksSchema),
  (req, res, next) => financeController.listClawbacks(req, res, next)
);
router.get('/cash', requirePermission(Permission.FINANCE_VIEW), (req, res, next) => financeController.listCash(req, res, next));
router.get('/cash/by-driver', requirePermission(Permission.FINANCE_VIEW), (req, res, next) =>
  financeController.cashByDriver(req, res, next)
);
router.get('/cash/totals', requirePermission(Permission.FINANCE_VIEW), (req, res, next) => financeController.cashTotals(req, res, next));
// Los faltantes de efectivo. Solo lectura para cualquier administrador:
// verlos es supervisión, decidirlos es finanzas (ver más abajo).
router.get('/cash/incidents', requirePermission(Permission.FINANCE_VIEW), (req, res, next) =>
  financeController.listCashIncidents(req, res, next)
);
router.get('/ledger/summary', requirePermission(Permission.FINANCE_VIEW), (req, res, next) =>
  financeController.ledgerSummary(req, res, next)
);
router.get('/ledger/orders/:orderId', requirePermission(Permission.FINANCE_VIEW), (req, res, next) =>
  financeController.ledgerForOrder(req, res, next)
);

// ── Write: finance admin only ──
// These change what the platform charges or declare that money arrived.
router.put(
  '/config',
  requirePermission(Permission.FINANCE_MANAGE),
  validate(updatePricingConfigSchema),
  (req, res, next) => financeController.updateConfig(req, res, next)
);
router.patch(
  '/businesses/:id/terms',
  requirePermission(Permission.COMMISSIONS_MANAGE),
  validate(adminBusinessTermsSchema),
  (req, res, next) => financeController.updateBusinessTerms(req, res, next)
);
router.post(
  '/settlements',
  requirePermission(Permission.PAYOUTS_PROCESS),
  validate(settleSchema),
  (req, res, next) => financeController.settle(req, res, next)
);
/**
 * Registra el pago manual (transferencia/consignación) de una liquidación
 * ya reclamada por `POST /settlements`. Cierra la liquidación y postea el
 * asiento contable de desembolso.
 */
router.post(
  '/settlements/:id/payment',
  requirePermission(Permission.PAYOUTS_PROCESS),
  validate(settlementPaymentSchema),
  (req, res, next) => financeController.paySettlement(req, res, next)
);
/**
 * La cuenta a la que se paga una liquidación, desde la foto que se guardó al
 * liquidar. La pantalla de pago usa esta, no la cuenta actual del comercio.
 */
router.get(
  '/settlements/:id/payout-account',
  requirePermission(Permission.PAYOUTS_REVEAL_ACCOUNT),
  payoutAccountRevealRateLimiter,
  validate(settlementIdParamSchema),
  (req, res, next) => financeController.revealSettlementPayoutAccount(req, res, next)
);
/** Refresca la foto con la cuenta actual (verificada) de una liquidación pendiente. */
router.post(
  '/settlements/:id/payout-account/refresh',
  requirePermission(Permission.PAYOUTS_REVEAL_ACCOUNT),
  businessFiscalRateLimiter,
  validate(settlementIdParamSchema),
  (req, res, next) => financeController.refreshSettlementPayoutAccount(req, res, next)
);
/** Cola de cuentas pendientes de verificación en comercios ya aprobados. */
router.get(
  '/payout-accounts/pending',
  requirePermission(Permission.PAYOUTS_PROCESS),
  (req, res, next) => financeController.pendingPayoutAccounts(req, res, next)
);
router.post(
  '/clawbacks/:id/collect',
  requirePermission(Permission.FINANCE_MANAGE),
  validate(collectClawbackSchema),
  (req, res, next) => financeController.collectClawback(req, res, next)
);
router.post(
  '/clawbacks/:id/write-off',
  requirePermission(Permission.FINANCE_MANAGE),
  validate(writeOffClawbackSchema),
  (req, res, next) => financeController.writeOffClawback(req, res, next)
);
router.post(
  '/cash/verify',
  requirePermission(Permission.FINANCE_MANAGE),
  validate(verifyCashSchema),
  (req, res, next) => financeController.verifyCash(req, res, next)
);
router.post(
  '/cash/settle',
  requirePermission(Permission.FINANCE_MANAGE),
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
  requirePermission(Permission.FINANCE_MANAGE),
  validate(cashIncidentIdSchema),
  (req, res, next) => financeController.reviewCashIncident(req, res, next)
);
router.post(
  '/cash/incidents/:id/resolve',
  requirePermission(Permission.FINANCE_MANAGE),
  validate(resolveCashIncidentSchema),
  (req, res, next) => financeController.resolveCashIncident(req, res, next)
);

export default router;
