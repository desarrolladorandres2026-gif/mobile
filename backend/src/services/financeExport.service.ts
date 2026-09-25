import { LedgerEntry, Settlement, Refund, Payment, CashReconciliation, FiscalDocument } from '../models';
import { PaymentMethod, PaymentStatus } from '../types';
import { AppError } from '../middlewares';
import type { CsvColumn } from '../utils';
import type { DateRange } from '../utils/period';
import { pricingConfigService } from './pricingConfig.service';
import { estimateGatewayFee } from '../utils/gatewayFee';

/**
 * Exportes contables para quien lleva los libros de ZIPP.
 *
 * Cada exporte es un rango de fechas (hora de Bogotá) y un tope duro de
 * filas: un informe es un archivo que alguien abre, no un volcado de la
 * base. Si el rango lo supera, se rechaza con un mensaje que dice qué hacer
 * (acortarlo) en vez de entregar un archivo cortado en silencio, que en
 * contabilidad es peor que no tener archivo.
 *
 * Ninguno lleva teléfonos, direcciones ni documentos de personas: los
 * exportes con datos personales tienen su propia puerta (Super Administrador).
 */

export const FINANCE_EXPORT_KINDS = ['ledger', 'settlements', 'refunds', 'payments', 'cash', 'documents'] as const;
export type FinanceExportKind = (typeof FINANCE_EXPORT_KINDS)[number];

const MAX_ROWS = 50_000;

interface ExportResult {
  prefix: string;
  entity: string;
  rows: unknown[];
  columns: Array<CsvColumn<any>>;
}

function capped<T>(rows: T[]): T[] {
  if (rows.length > MAX_ROWS) {
    throw new AppError(`El rango tiene más de ${MAX_ROWS.toLocaleString('es-CO')} filas. Exporta un rango más corto.`, 422);
  }
  return rows;
}

const createdIn = (range: DateRange) => ({ $gte: range.from, $lte: range.to });

export const financeExportService = {
  async build(kind: FinanceExportKind, range: DateRange): Promise<ExportResult> {
    switch (kind) {
      case 'ledger': {
        const rows = capped(
          await LedgerEntry.find({ createdAt: createdIn(range) })
            .sort({ createdAt: 1 })
            .limit(MAX_ROWS + 1)
            .lean()
        );
        return {
          prefix: 'libro-mayor',
          entity: 'ledger',
          rows,
          columns: [
            { header: 'Fecha', value: (r: any) => r.createdAt },
            { header: 'Grupo', value: (r: any) => r.groupId },
            { header: 'Pedido', value: (r: any) => String(r.orderId) },
            { header: 'Evento', value: (r: any) => r.event },
            { header: 'Cuenta', value: (r: any) => r.account },
            { header: 'Dirección', value: (r: any) => r.direction },
            { header: 'Monto COP', value: (r: any) => r.amount },
            { header: 'Referencia', value: (r: any) => r.reference },
            { header: 'Detalle', value: (r: any) => r.memo },
            { header: 'Versión de tarifas', value: (r: any) => r.pricingConfigVersion },
          ],
        };
      }

      case 'settlements': {
        const rows = capped(
          await Settlement.find({ createdAt: createdIn(range) })
            .sort({ createdAt: 1 })
            .limit(MAX_ROWS + 1)
            .populate('businessId', 'name')
            .populate({ path: 'driverId', select: 'userId', populate: { path: 'userId', select: 'name' } })
            .lean()
        );
        return {
          prefix: 'liquidaciones',
          entity: 'settlement',
          rows,
          columns: [
            { header: 'Fecha', value: (r: any) => r.createdAt },
            { header: 'Beneficiario', value: (r: any) => r.beneficiary },
            { header: 'Nombre', value: (r: any) => r.businessId?.name ?? r.driverId?.userId?.name },
            { header: 'Pagos', value: (r: any) => r.payoutCount },
            { header: 'Bruto', value: (r: any) => r.grossAmount },
            { header: 'Reversado', value: (r: any) => r.reversedAmount },
            { header: 'Publicidad', value: (r: any) => r.adSpendAmount },
            { header: 'Saldo en contra', value: (r: any) => r.clawbackAmount },
            { header: 'Neto', value: (r: any) => r.netAmount },
            { header: 'Estado del pago', value: (r: any) => r.paymentStatus },
            { header: 'Medio', value: (r: any) => r.paymentMethod },
            { header: 'Referencia', value: (r: any) => r.reference },
            { header: 'Pagada', value: (r: any) => r.paidAt },
          ],
        };
      }

      case 'refunds': {
        const rows = capped(
          await Refund.find({ createdAt: createdIn(range) })
            .sort({ createdAt: 1 })
            .limit(MAX_ROWS + 1)
            .populate('orderId', 'orderNumber')
            .lean()
        );
        return {
          prefix: 'reembolsos',
          entity: 'refund',
          rows,
          columns: [
            { header: 'Fecha', value: (r: any) => r.createdAt },
            { header: 'Pedido', value: (r: any) => r.orderId?.orderNumber },
            { header: 'Tipo', value: (r: any) => r.kind },
            { header: 'Estado', value: (r: any) => r.status },
            { header: 'Monto', value: (r: any) => r.amount },
            { header: 'Motivo', value: (r: any) => r.reason },
            { header: 'Transacción', value: (r: any) => r.transactionId },
            { header: 'Del comercio', value: (r: any) => r.allocation?.fromMerchantPayout },
            { header: 'Del domiciliario', value: (r: any) => r.allocation?.fromDriverPayout },
            { header: 'De la comisión', value: (r: any) => r.allocation?.fromCommission },
            { header: 'De ZIPP', value: (r: any) => r.allocation?.fromPlatform },
          ],
        };
      }

      case 'payments': {
        const config = await pricingConfigService.getCurrent();
        const rows = capped(
          await Payment.find({ method: PaymentMethod.ONLINE, createdAt: createdIn(range) })
            .sort({ createdAt: 1 })
            .limit(MAX_ROWS + 1)
            .populate('orderId', 'orderNumber')
            .select('-metadata -statusHistory')
            .lean()
        );
        const settled = (r: any) => r.status === PaymentStatus.PAID || r.status === PaymentStatus.REFUNDED;
        return {
          prefix: 'pagos-wompi',
          entity: 'payment',
          rows,
          columns: [
            { header: 'Fecha', value: (r: any) => r.createdAt },
            { header: 'Pedido', value: (r: any) => r.orderId?.orderNumber },
            { header: 'Tipo', value: (r: any) => r.type },
            { header: 'Método', value: (r: any) => r.paymentMethodType },
            { header: 'Estado', value: (r: any) => r.status },
            { header: 'Monto', value: (r: any) => r.amount },
            { header: 'Comisión estimada', value: (r: any) => (settled(r) ? estimateGatewayFee(config, r.paymentMethodType, r.amount) : 0) },
            { header: 'Referencia', value: (r: any) => r.reference },
            { header: 'Transacción', value: (r: any) => r.transactionId },
          ],
        };
      }

      case 'documents': {
        // El paquete mensual para el contador: una fila por comprobante interno.
        const rows = capped(
          await FiscalDocument.find({ issuedAt: createdIn(range) })
            .sort({ number: 1 })
            .limit(MAX_ROWS + 1)
            .lean()
        );
        return {
          prefix: 'comprobantes-internos',
          entity: 'fiscal_document',
          rows,
          columns: [
            { header: 'Número', value: (r: any) => r.number },
            { header: 'Emitido', value: (r: any) => r.issuedAt },
            { header: 'Tipo', value: (r: any) => r.type },
            { header: 'Nombre', value: (r: any) => r.party?.name },
            { header: 'Razón social', value: (r: any) => r.party?.legalName },
            { header: 'Tipo de documento', value: (r: any) => r.party?.documentType },
            { header: 'Últimos 4 del documento', value: (r: any) => r.party?.documentLast4 },
            { header: 'DV', value: (r: any) => r.party?.dv },
            { header: 'Régimen', value: (r: any) => r.party?.taxRegime },
            { header: 'Neto pagado', value: (r: any) => r.netAmount },
            { header: 'Medio de pago', value: (r: any) => r.paymentMethod },
            { header: 'Referencia', value: (r: any) => r.paymentReference },
            { header: 'Pagado', value: (r: any) => r.paidAt },
          ],
        };
      }

      case 'cash': {
        const rows = capped(
          await CashReconciliation.find({ createdAt: createdIn(range) })
            .sort({ createdAt: 1 })
            .limit(MAX_ROWS + 1)
            .populate('orderId', 'orderNumber')
            .populate({ path: 'driverId', select: 'userId', populate: { path: 'userId', select: 'name' } })
            .lean()
        );
        return {
          prefix: 'efectivo',
          entity: 'cash_reconciliation',
          rows,
          columns: [
            { header: 'Fecha', value: (r: any) => r.createdAt },
            { header: 'Pedido', value: (r: any) => r.orderId?.orderNumber },
            { header: 'Domiciliario', value: (r: any) => r.driverId?.userId?.name },
            { header: 'Estado', value: (r: any) => r.status },
            { header: 'Monto a rendir', value: (r: any) => r.amount },
            { header: 'Vence', value: (r: any) => r.dueAt },
            { header: 'Reportado', value: (r: any) => r.reportedAt },
            { header: 'Referencia reportada', value: (r: any) => r.reportedReference },
            { header: 'Verificado', value: (r: any) => r.verifiedAt },
            { header: 'Método de verificación', value: (r: any) => r.verificationMethod },
            { header: 'Liquidado', value: (r: any) => r.settledAt },
          ],
        };
      }
    }
  },
};
