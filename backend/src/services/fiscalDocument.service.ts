import { Types } from 'mongoose';
import { FiscalDocument, IFiscalDocument, Settlement, Business, Driver, getNextSequence } from '../models';
import { AppError } from '../middlewares';
import { PayoutBeneficiary, SettlementPaymentStatus } from '../types';
import { decrypt } from '../security';
import { businessAad } from './business.service';
import { lastDigits } from '../utils/nit';
import type { FiscalDocumentType } from '../models/FiscalDocument';
import { customRange } from '../utils/period';

/**
 * Comprobantes internos (`INT-`) de liquidaciones pagadas.
 *
 * Se emiten a demanda, una sola vez por liquidación (idempotente), y solo
 * cuando el pago ya está registrado: un comprobante de algo que no se pagó
 * sería un soporte falso. Ver `FiscalDocument` para por qué no es factura.
 */

const pad = (n: number) => String(n).padStart(6, '0');

export const fiscalDocumentService = {
  async issueForSettlement(settlementId: string, issuedBy: string): Promise<{ document: IFiscalDocument; created: boolean }> {
    if (!Types.ObjectId.isValid(settlementId)) throw new AppError('Liquidación no encontrada', 404);
    const settlement = await Settlement.findById(settlementId).lean();
    if (!settlement) throw new AppError('Liquidación no encontrada', 404);
    if (settlement.paymentStatus !== SettlementPaymentStatus.PAID) {
      throw new AppError('El comprobante se emite cuando la liquidación ya está pagada', 409);
    }

    const type: FiscalDocumentType =
      settlement.beneficiary === PayoutBeneficiary.BUSINESS ? 'settlement_statement' : 'driver_payment_voucher';

    const existing = await FiscalDocument.findOne({ settlementId: settlement._id, type });
    if (existing) return { document: existing, created: false };

    const party = await this.partyOf(settlement);

    const lines = [
      { label: settlement.beneficiary === PayoutBeneficiary.BUSINESS ? 'Ventas liquidadas' : 'Pagos por domicilios', amount: settlement.grossAmount },
      ...(settlement.reversedAmount > 0 ? [{ label: 'Reembolsos y contracargos', amount: -settlement.reversedAmount }] : []),
      ...(settlement.adSpendAmount > 0 ? [{ label: 'Publicidad descontada', amount: -settlement.adSpendAmount }] : []),
      ...(settlement.clawbackAmount > 0 ? [{ label: 'Saldos en contra descontados', amount: -settlement.clawbackAmount }] : []),
    ];

    try {
      const seq = await getNextSequence('fiscal-document-int');
      const document = await FiscalDocument.create({
        number: `INT-${pad(seq)}`,
        type,
        settlementId: settlement._id,
        party,
        lines,
        netAmount: settlement.netAmount,
        currency: settlement.currency,
        paymentMethod: settlement.paymentMethod ?? null,
        paymentReference: settlement.reference || null,
        paidAt: settlement.paidAt ?? null,
        issuedBy: new Types.ObjectId(issuedBy),
      });
      return { document, created: true };
    } catch (error: any) {
      // Otra emisión simultánea ganó: su comprobante es el válido.
      if (error?.code === 11000) {
        const raced = await FiscalDocument.findOne({ settlementId: settlement._id, type });
        if (raced) return { document: raced, created: false };
      }
      throw error;
    }
  },

  async partyOf(settlement: any): Promise<IFiscalDocument['party']> {
    if (settlement.beneficiary === PayoutBeneficiary.BUSINESS && settlement.businessId) {
      const business = await Business.findById(settlement.businessId).select('name +legal').lean();
      const legal = business?.legal;
      let documentLast4: string | null = null;
      if (legal?.documentNumber) {
        // Se descifra solo para quedarse con los 4 últimos.
        documentLast4 = lastDigits(decrypt(legal.documentNumber, businessAad(settlement.businessId))) || null;
      }
      return {
        kind: 'business',
        id: settlement.businessId,
        name: business?.name ?? 'Comercio',
        legalName: legal?.legalName ?? null,
        documentType: legal?.documentType ?? null,
        documentLast4,
        dv: legal?.dv ?? null,
        taxRegime: legal?.taxRegime ?? null,
      };
    }
    const driver = await Driver.findById(settlement.driverId).select('userId').populate('userId', 'name').lean();
    return {
      kind: 'driver',
      id: settlement.driverId,
      name: (driver as any)?.userId?.name ?? 'Domiciliario',
    };
  },

  async list(params: { month?: string; page?: number; limit?: number }) {
    const filter: Record<string, unknown> = {};
    if (params.month) {
      if (!/^\d{4}-\d{2}$/.test(params.month)) throw new AppError('Mes inválido (usa AAAA-MM)', 400);
      const [y, m] = params.month.split('-').map(Number);
      const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
      const range = customRange(`${params.month}-01`, `${params.month}-${String(last).padStart(2, '0')}`);
      if (!range) throw new AppError('Mes inválido (usa AAAA-MM)', 400);
      filter.issuedAt = { $gte: range.from, $lte: range.to };
    }
    const limit = params.limit ?? 25;
    const page = Math.max(1, params.page ?? 1);
    const [items, total] = await Promise.all([
      FiscalDocument.find(filter).sort({ issuedAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      FiscalDocument.countDocuments(filter),
    ]);
    return { items, meta: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } };
  },

  async getById(id: string) {
    if (!Types.ObjectId.isValid(id)) throw new AppError('Comprobante no encontrado', 404);
    const document = await FiscalDocument.findById(id).lean();
    if (!document) throw new AppError('Comprobante no encontrado', 404);
    return document;
  },
};
