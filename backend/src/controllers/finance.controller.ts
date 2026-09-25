import { Request, Response, NextFunction } from 'express';
import {
  pricingConfigService,
  payoutService,
  cashReconciliationService,
  cashIncidentService,
  ledgerService,
  businessService,
} from '../services';
import { sendResponse, param, query, clampLimit, toCsv, csvFilename } from '../utils';
import { assertExportAuthorized } from '../security/exportGate';
import { financeExportService, type FinanceExportKind } from '../services/financeExport.service';
import { AppError } from '../middlewares';
import { platformResultService } from '../services/platformResult.service';
import { paymentReportService } from '../services/paymentReport.service';
import { fiscalDocumentService } from '../services/fiscalDocument.service';
import { adInvoiceService, type AdInvoiceView } from '../services/adInvoice.service';
import { periodRange, isReportPeriod, customRange, type DateRange } from '../utils/period';
import { PayoutBeneficiary, LedgerAccount, CashIncidentResolution, SettlementPaymentStatus, PaymentStatus } from '../types';
import { AuditAction, AuditSeverity, logAudit } from '../security';

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
      const business = await businessService.updateTerms(param(req, 'id'), req.body, req.user, req);
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
      if (result.settlement) {
        void logAudit(req, {
          action: AuditAction.PAYOUT_PROCESSED,
          entity: 'settlement',
          entityId: String(result.settlement._id),
          severity: AuditSeverity.HIGH,
          description: `Liquidación reclamada: ${result.count} payouts, neto $${result.netAmount.toLocaleString('es-CO')}`,
          metadata: {
            beneficiary: req.body.beneficiary,
            businessId: req.body.businessId,
            driverId: req.body.driverId,
            netAmount: result.netAmount,
          },
        });
      }
      sendResponse(res, 201, 'Liquidación registrada', result);
    } catch (error) { next(error); }
  }

  async listSettlements(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await payoutService.listSettlements({
        beneficiary: query(req, 'beneficiary') as PayoutBeneficiary | undefined,
        businessId: query(req, 'businessId'),
        driverId: query(req, 'driverId'),
        paymentStatus: query(req, 'paymentStatus') as SettlementPaymentStatus | undefined,
        page: Number(query(req, 'page')) || 1,
        limit: clampLimit(query(req, 'limit'), 100, 25),
      });
      sendResponse(res, 200, 'Liquidaciones', result.items, result.meta);
    } catch (error) { next(error); }
  }

  /**
   * Exporte contable en CSV (libro, liquidaciones, reembolsos, pagos, efectivo).
   * Motivo y TOTP obligatorios; queda en la auditoría con el rango y las filas.
   */
  async exportFinance(req: Request, res: Response, next: NextFunction) {
    try {
      const kind = param(req, 'kind') as FinanceExportKind;
      const { reason, totpToken, from, to } = req.body ?? {};
      await assertExportAuthorized(req, reason, totpToken, { superAdminOnly: false });

      const range = paymentReportService.parseRange(from, to, 30);
      const result = await financeExportService.build(kind, range);

      void logAudit(req, {
        action: AuditAction.DATA_EXPORTED,
        entity: result.entity,
        severity: AuditSeverity.HIGH,
        description: `Exporte contable "${kind}" (${result.rows.length} filas): ${String(reason).trim()}`,
        metadata: { kind, from, to, rows: result.rows.length, reason: String(reason).trim() },
      });

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${csvFilename(result.prefix)}"`);
      res.setHeader('Cache-Control', 'no-store');
      res.send(toCsv(result.rows, result.columns));
    } catch (error) { next(error); }
  }

  /** Emite (una sola vez) el comprobante interno de una liquidación pagada. */
  async issueSettlementDocument(req: Request, res: Response, next: NextFunction) {
    try {
      const { document, created } = await fiscalDocumentService.issueForSettlement(param(req, 'id'), req.user!._id.toString());
      if (created) {
        void logAudit(req, {
          action: AuditAction.PAYOUT_PROCESSED,
          entity: 'fiscal_document',
          entityId: String(document._id),
          severity: AuditSeverity.MEDIUM,
          description: `Comprobante interno ${document.number} emitido`,
          metadata: { settlementId: param(req, 'id'), number: document.number },
        });
      }
      sendResponse(res, created ? 201 : 200, created ? 'Comprobante emitido' : 'El comprobante ya existía', document);
    } catch (error) { next(error); }
  }

  async listFiscalDocuments(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await fiscalDocumentService.list({
        month: query(req, 'month'),
        page: Number(query(req, 'page')) || 1,
        limit: clampLimit(query(req, 'limit'), 100, 25),
      });
      sendResponse(res, 200, 'Comprobantes internos', result.items, result.meta);
    } catch (error) { next(error); }
  }

  async getFiscalDocument(req: Request, res: Response, next: NextFunction) {
    try {
      sendResponse(res, 200, 'Comprobante interno', await fiscalDocumentService.getById(param(req, 'id')));
    } catch (error) { next(error); }
  }

  /** Facturas de publicidad por estado de cobro. */
  async listAdInvoices(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await adInvoiceService.list({
        view: query(req, 'view') as AdInvoiceView | undefined,
        page: Number(query(req, 'page')) || 1,
        limit: clampLimit(query(req, 'limit'), 100, 25),
      });
      sendResponse(res, 200, 'Facturas de publicidad', { items: result.items, totals: result.totals }, result.meta);
    } catch (error) { next(error); }
  }

  /** Registra el cobro por fuera de una factura de publicidad sin comercio. */
  async collectAdInvoice(req: Request, res: Response, next: NextFunction) {
    try {
      const invoice = await adInvoiceService.collect({
        invoiceId: param(req, 'id'),
        reference: req.body.reference,
        receiptUrl: req.body.receiptUrl,
        collectedBy: req.user!._id.toString(),
      });
      void logAudit(req, {
        action: AuditAction.PAYOUT_PROCESSED,
        entity: 'ad_invoice',
        entityId: param(req, 'id'),
        severity: AuditSeverity.HIGH,
        description: `Factura de publicidad cobrada por fuera, ref. ${req.body.reference}`,
        metadata: { amount: invoice.amount, campaignName: invoice.campaignName, reference: req.body.reference },
      });
      sendResponse(res, 200, 'Cobro de publicidad registrado', invoice);
    } catch (error) { next(error); }
  }

  /** Cobros en línea por estado y método, con la comisión estimada de la pasarela. */
  async listPayments(req: Request, res: Response, next: NextFunction) {
    try {
      const from = query(req, 'from');
      const to = query(req, 'to');
      const result = await paymentReportService.list({
        status: query(req, 'status') as PaymentStatus | undefined,
        methodType: query(req, 'methodType'),
        range: from || to ? paymentReportService.parseRange(from, to) : undefined,
        page: Number(query(req, 'page')) || 1,
        limit: clampLimit(query(req, 'limit'), 100, 25),
      });
      sendResponse(res, 200, 'Pagos', { items: result.items, totals: result.totals }, result.meta);
    } catch (error) { next(error); }
  }

  /** Conciliación diaria: cobrado, comisión asentada y depósito esperado de Wompi. */
  async paymentsDaily(req: Request, res: Response, next: NextFunction) {
    try {
      const range = paymentReportService.parseRange(query(req, 'from'), query(req, 'to'));
      sendResponse(res, 200, 'Conciliación diaria de pagos', await paymentReportService.daily(range));
    } catch (error) { next(error); }
  }

  /** Beneficiarios con dinero listo para liquidar: la lista de trabajo semanal. */
  async listPayables(req: Request, res: Response, next: NextFunction) {
    try {
      const payables = await payoutService.listPayables({
        beneficiary: query(req, 'beneficiary') as PayoutBeneficiary | undefined,
      });
      sendResponse(res, 200, 'Pendiente de liquidar', payables);
    } catch (error) { next(error); }
  }

  /**
   * Registra el pago manual de una liquidación: transferencia/consignación
   * hecha por fuera de ZIPP y anotada aquí con referencia y comprobante.
   * Es lo que de verdad cierra la liquidación y su asiento contable.
   */
  async paySettlement(req: Request, res: Response, next: NextFunction) {
    try {
      const settlement = await payoutService.registerPayment({
        settlementId: param(req, 'id'),
        method: req.body.method,
        reference: req.body.reference,
        paidAt: req.body.paidAt,
        receiptUrl: req.body.receiptUrl,
        note: req.body.note,
        paidBy: req.user!._id.toString(),
      });
      void logAudit(req, {
        action: AuditAction.SETTLEMENT_PAYMENT_REGISTERED,
        entity: 'settlement',
        entityId: param(req, 'id'),
        severity: AuditSeverity.HIGH,
        description: `Pago de liquidación registrado por ${req.body.method}, ref. ${req.body.reference}`,
        metadata: { netAmount: settlement.netAmount, method: req.body.method },
      });
      sendResponse(res, 200, 'Pago de liquidación registrado', settlement);
    } catch (error) { next(error); }
  }

  /**
   * La cuenta a la que se paga esta liquidación, tal como se verificó al
   * liquidar (no la actual del comercio). `no-store` y auditoría HIGH.
   */
  async revealSettlementPayoutAccount(req: Request, res: Response, next: NextFunction) {
    try {
      const account = await payoutService.revealSettlementPayoutAccount(param(req, 'id'), req);
      res.setHeader('Cache-Control', 'no-store');
      sendResponse(res, 200, 'Cuenta de pago de la liquidación', account);
    } catch (error) { next(error); }
  }

  /** Toma de nuevo la foto de la cuenta de una liquidación pendiente con la cuenta actual verificada. */
  async refreshSettlementPayoutAccount(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await payoutService.refreshPayoutAccountSnapshot(param(req, 'id'), req.user!._id.toString(), req);
      res.setHeader('Cache-Control', 'no-store');
      sendResponse(res, 200, 'Cuenta de pago de la liquidación actualizada', result);
    } catch (error) { next(error); }
  }

  /** Cuentas de pago pendientes de verificación en comercios ya aprobados. */
  async pendingPayoutAccounts(_req: Request, res: Response, next: NextFunction) {
    try {
      const pending = await businessService.pendingPayoutAccounts();
      res.setHeader('Cache-Control', 'no-store');
      sendResponse(res, 200, 'Cuentas de pago pendientes de verificación', pending);
    } catch (error) { next(error); }
  }

  // ── Arrastres fuera de una liquidación ──

  async listClawbacks(req: Request, res: Response, next: NextFunction) {
    try {
      const clawbacks = await payoutService.listClawbacks({
        status: query(req, 'status') as 'open' | 'collected' | 'written_off' | undefined,
        businessId: query(req, 'businessId'),
      });
      sendResponse(res, 200, 'Arrastres', clawbacks);
    } catch (error) { next(error); }
  }

  async collectClawback(req: Request, res: Response, next: NextFunction) {
    try {
      const payout = await payoutService.collectClawback({
        payoutId: param(req, 'id'),
        reference: req.body.reference,
        receiptUrl: req.body.receiptUrl,
      });
      void logAudit(req, {
        action: AuditAction.CLAWBACK_COLLECTED,
        entity: 'payout',
        entityId: param(req, 'id'),
        severity: AuditSeverity.HIGH,
        description: `Arrastre cobrado directo, ref. ${req.body.reference}`,
        metadata: { amount: payout.amount, orderId: String(payout.orderId) },
      });
      sendResponse(res, 200, 'Arrastre cobrado', payout);
    } catch (error) { next(error); }
  }

  async writeOffClawback(req: Request, res: Response, next: NextFunction) {
    try {
      const payout = await payoutService.writeOffClawback({
        payoutId: param(req, 'id'),
        reason: req.body.reason,
      });
      void logAudit(req, {
        action: AuditAction.CLAWBACK_WRITTEN_OFF,
        entity: 'payout',
        entityId: param(req, 'id'),
        severity: AuditSeverity.HIGH,
        description: `Arrastre castigado como incobrable: ${req.body.reason}`,
        metadata: { amount: payout.amount, orderId: String(payout.orderId) },
      });
      sendResponse(res, 200, 'Arrastre castigado como incobrable', payout);
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

  /** Totales por estado sobre toda la colección, no solo la página cargada. */
  async cashTotals(_req: Request, res: Response, next: NextFunction) {
    try {
      const totals = await cashReconciliationService.totals();
      sendResponse(res, 200, 'Totales de efectivo', totals);
    } catch (error) { next(error); }
  }

  /** Efectivo sin rendir por domiciliario, con lo vencido y lo ya reportado. */
  async cashByDriver(_req: Request, res: Response, next: NextFunction) {
    try {
      sendResponse(res, 200, 'Efectivo por domiciliario', await cashReconciliationService.outstandingByDriver());
    } catch (error) { next(error); }
  }

  async verifyCash(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await cashReconciliationService.verifyByAdmin(
        req.body.ids || [],
        req.user!._id.toString(),
        req.body.reference,
        req.body.receiptUrl,
        req.body.amount
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
  async ledgerSummary(req: Request, res: Response, next: NextFunction) {
    try {
      // Periodo opcional: `?period=today|week|month` o `?from=YYYY-MM-DD&to=YYYY-MM-DD`
      // (hora de Bogotá). Sin parámetros, acumulado histórico (compatibilidad).
      const periodParam = query(req, 'period');
      const fromParam = query(req, 'from');
      const toParam = query(req, 'to');

      let range: DateRange | undefined;
      if (periodParam) {
        if (!isReportPeriod(periodParam)) throw new AppError('Periodo inválido: usa today, week o month', 400);
        range = periodRange(periodParam);
      } else if (fromParam || toParam) {
        const custom = customRange(fromParam || '', toParam || fromParam || '');
        if (!custom) throw new AppError('Rango inválido: usa from y to como YYYY-MM-DD', 400);
        range = custom;
      }

      const filter = range ? { createdAt: { $gte: range.from, $lte: range.to } } : {};
      const accounts = Object.values(LedgerAccount);
      const [balances, platformResult, balanced] = await Promise.all([
        Promise.all(
          accounts.map(async (account) => ({
            account,
            ...(await ledgerService.accountBalance(account, filter)),
          }))
        ),
        platformResultService.forRange(range),
        // `balanced` es siempre global: un libro descuadrado lo está sin importar el periodo.
        ledgerService.isBalanced(),
      ]);

      sendResponse(res, 200, 'Balance por cuenta', {
        balances,
        balanced,
        platformResult,
        period: periodParam || (range ? 'custom' : 'all'),
      });
    } catch (error) { next(error); }
  }
}

export const financeController = new FinanceController();
