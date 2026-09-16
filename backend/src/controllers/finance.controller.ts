import { Request, Response, NextFunction } from 'express';
import {
  pricingConfigService,
  payoutService,
  cashReconciliationService,
  cashIncidentService,
  ledgerService,
  businessService,
} from '../services';
import { sendResponse, param, query, clampLimit } from '../utils';
import { PayoutBeneficiary, LedgerAccount, CashIncidentResolution } from '../types';

export class FinanceController {
  // ── Pricing configuration ──

  async getConfig(_req: Request, res: Response, next: NextFunction) {
    try {
      const config = await pricingConfigService.getCurrent();
      sendResponse(res, 200, 'Configuración de precios', config);
    } catch (error) { next(error); }
  }

  async updateConfig(req: Request, res: Response, next: NextFunction) {
    try {
      const { reason, ...patch } = req.body;

      const result = await pricingConfigService.update(patch, {
        userId: req.user!._id.toString(),
        userName: req.user!.name,
        reason,
        ip: req.ip,
      });

      sendResponse(res, 200, 'Configuración actualizada', {
        config: result.config,
        changes: result.changes,
      });
    } catch (error) { next(error); }
  }

  async listConfigVersions(req: Request, res: Response, next: NextFunction) {
    try {
      const versions = await pricingConfigService.listVersions(
        clampLimit(query(req, 'limit'), 100, 50)
      );
      sendResponse(res, 200, 'Versiones de configuración', versions);
    } catch (error) { next(error); }
  }

  async configAudit(req: Request, res: Response, next: NextFunction) {
    try {
      const trail = await pricingConfigService.getAuditTrail(
        clampLimit(query(req, 'limit'), 100, 50)
      );
      sendResponse(res, 200, 'Historial de cambios', trail);
    } catch (error) { next(error); }
  }

  // ── Business commercial terms ──

  async updateBusinessTerms(req: Request, res: Response, next: NextFunction) {
    try {
      const business = await businessService.updateTerms(param(req, 'id'), req.body);
      sendResponse(res, 200, 'Términos comerciales actualizados', business);
    } catch (error) { next(error); }
  }

  // ── Payouts and settlements ──

  async payoutSummary(req: Request, res: Response, next: NextFunction) {
    try {
      const [business, driver] = await Promise.all([
        payoutService.summaryFor({ beneficiary: PayoutBeneficiary.BUSINESS }),
        payoutService.summaryFor({ beneficiary: PayoutBeneficiary.DRIVER }),
      ]);
      sendResponse(res, 200, 'Resumen de pasivos', { business, driver });
    } catch (error) { next(error); }
  }

  async settle(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await payoutService.settle({
        beneficiary: req.body.beneficiary as PayoutBeneficiary,
        businessId: req.body.businessId,
        driverId: req.body.driverId,
        reference: req.body.reference,
        createdBy: req.user!._id.toString(),
      });
      sendResponse(res, 201, 'Liquidación registrada', result);
    } catch (error) { next(error); }
  }

  async listSettlements(req: Request, res: Response, next: NextFunction) {
    try {
      const settlements = await payoutService.listSettlements({
        beneficiary: query(req, 'beneficiary') as PayoutBeneficiary | undefined,
        businessId: query(req, 'businessId'),
        driverId: query(req, 'driverId'),
        limit: clampLimit(query(req, 'limit'), 100, 50),
      });
      sendResponse(res, 200, 'Liquidaciones', settlements);
    } catch (error) { next(error); }
  }

  // ── Cash reconciliation ──

  async listCash(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await cashReconciliationService.list(
        query(req, 'status'),
        Number(query(req, 'page')) || 1,
        clampLimit(query(req, 'limit'), 100, 20)
      );
      sendResponse(res, 200, 'Conciliaciones de efectivo', result.records, result.meta);
    } catch (error) { next(error); }
  }

  async verifyCash(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await cashReconciliationService.verifyByAdmin(
        req.body.ids || [],
        req.user!._id.toString(),
        req.body.note
      );
      sendResponse(res, 200, 'Efectivo verificado', result);
    } catch (error) { next(error); }
  }

  async settleCash(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await cashReconciliationService.settle(
        req.body.ids || [],
        req.user!._id.toString()
      );
      sendResponse(res, 200, 'Efectivo liquidado', result);
    } catch (error) { next(error); }
  }

  // ── Incidencias de efectivo ──
  //
  // Leer es de cualquier administrador; decidir es de finanzas. Es la misma
  // separación que ya rige verificar y liquidar efectivo, y por la misma
  // razón: aquí se decide si alguien debe dinero o deja de deberlo.

  async listCashIncidents(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await cashIncidentService.list(
        query(req, 'status'),
        Number(query(req, 'page')) || 1,
        clampLimit(query(req, 'limit'), 100, 20)
      );
      sendResponse(res, 200, 'Incidencias de efectivo', result.incidents, result.meta);
    } catch (error) { next(error); }
  }

  async reviewCashIncident(req: Request, res: Response, next: NextFunction) {
    try {
      const incident = await cashIncidentService.review(
        param(req, 'id'),
        req.user!._id.toString()
      );
      sendResponse(res, 200, 'Incidencia en revisión', incident);
    } catch (error) { next(error); }
  }

  async resolveCashIncident(req: Request, res: Response, next: NextFunction) {
    try {
      const incident = await cashIncidentService.resolve({
        incidentId: param(req, 'id'),
        adminUserId: req.user!._id.toString(),
        resolution: req.body.resolution as CashIncidentResolution,
        adminNote: req.body.adminNote,
        reject: req.body.reject === true,
      });
      sendResponse(res, 200, 'Incidencia resuelta', incident);
    } catch (error) { next(error); }
  }

  // ── Ledger ──

  async ledgerForOrder(req: Request, res: Response, next: NextFunction) {
    try {
      const entries = await ledgerService.forOrder(param(req, 'orderId'));
      sendResponse(res, 200, 'Asientos del pedido', entries);
    } catch (error) { next(error); }
  }

  /**
   * Balance sheet by account, plus a health flag.
   *
   * `balanced` is the one number an operator should watch: if the whole
   * book ever stops balancing, something has written money outside the
   * ledger service and every downstream report is suspect.
   */
  async ledgerSummary(_req: Request, res: Response, next: NextFunction) {
    try {
      const accounts = Object.values(LedgerAccount);
      const balances = await Promise.all(
        accounts.map(async (account) => ({
          account,
          ...(await ledgerService.accountBalance(account)),
        }))
      );

      sendResponse(res, 200, 'Balance por cuenta', {
        balances,
        balanced: await ledgerService.isBalanced(),
      });
    } catch (error) { next(error); }
  }
}

export const financeController = new FinanceController();
