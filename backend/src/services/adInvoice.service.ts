import { Types } from 'mongoose';
import { AdInvoice } from '../models';
import { AppError } from '../middlewares';

/**
 * Facturas de publicidad vistas por finanzas.
 *
 * Una factura de un comercio se descuenta sola de su siguiente liquidación
 * (`settle()`); una venta que hizo el equipo comercial por fuera
 * (`settledAgainstPayout: false`, sin comercio) no tiene de dónde
 * descontarse y solo se cierra cuando finanzas registra el cobro con su
 * referencia y comprobante. Sin esta vista esas facturas quedaban abiertas
 * para siempre sin que nadie las viera.
 *
 * Nada de esto pasa por el libro mayor (`LedgerEntry.orderId` es
 * obligatorio; ver `AdInvoice`): la compensación contra una liquidación ya
 * tiene su asiento propio, atado al pedido, y esto es solo el estado de
 * cobro de la factura.
 */

export type AdInvoiceView = 'to_deduct' | 'deducted' | 'to_collect' | 'collected';

const VIEW_FILTER: Record<AdInvoiceView, Record<string, unknown>> = {
  to_deduct: { settledAgainstPayout: true, settledAt: null },
  deducted: { settledAgainstPayout: true, settledAt: { $ne: null } },
  to_collect: { settledAgainstPayout: false, settledAt: null },
  collected: { settledAgainstPayout: false, settledAt: { $ne: null } },
};

const viewOf = (i: { settledAgainstPayout: boolean; settledAt?: Date | null }): AdInvoiceView =>
  i.settledAgainstPayout ? (i.settledAt ? 'deducted' : 'to_deduct') : i.settledAt ? 'collected' : 'to_collect';

export const adInvoiceService = {
  async list(params: { view?: AdInvoiceView; page?: number; limit?: number }) {
    const filter = params.view ? VIEW_FILTER[params.view] : {};
    const limit = params.limit ?? 25;
    const page = Math.max(1, params.page ?? 1);

    const [rows, total, groups] = await Promise.all([
      AdInvoice.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate('businessId', 'name')
        .lean(),
      AdInvoice.countDocuments(filter),
      AdInvoice.aggregate([
        {
          $group: {
            _id: { against: '$settledAgainstPayout', settled: { $ne: ['$settledAt', null] } },
            count: { $sum: 1 },
            amount: { $sum: '$amount' },
          },
        },
      ]),
    ]);

    const totals: Record<AdInvoiceView, { count: number; amount: number }> = {
      to_deduct: { count: 0, amount: 0 },
      deducted: { count: 0, amount: 0 },
      to_collect: { count: 0, amount: 0 },
      collected: { count: 0, amount: 0 },
    };
    for (const g of groups) {
      const view = viewOf({ settledAgainstPayout: g._id.against, settledAt: g._id.settled ? new Date() : null });
      totals[view] = { count: g.count, amount: g.amount };
    }

    const items = rows.map((r: any) => ({
      _id: String(r._id),
      view: viewOf(r),
      campaignName: r.campaignName,
      businessId: r.businessId ? String(r.businessId._id ?? r.businessId) : null,
      advertiserName: r.businessId?.name ?? r.advertiserName,
      pricingModel: r.pricingModel,
      impressions: r.impressions,
      clicks: r.clicks,
      amount: r.amount,
      periodStart: r.periodStart,
      periodEnd: r.periodEnd,
      settledAt: r.settledAt ?? null,
      collectionReference: r.collectionReference ?? null,
      collectionReceiptUrl: r.collectionReceiptUrl ?? null,
      createdAt: r.createdAt,
    }));

    return { items, totals, meta: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } };
  },

  /**
   * Registra el cobro por fuera de una factura que no se descuenta de
   * ninguna liquidación. Atómico y de una sola vez: `settledAt: null` va en
   * el filtro, así que un doble clic no la cobra dos veces ni pisa la
   * referencia de la primera.
   */
  async collect(params: { invoiceId: string; reference: string; receiptUrl: string; collectedBy: string }) {
    if (!Types.ObjectId.isValid(params.invoiceId)) throw new AppError('Factura no encontrada', 404);

    const updated = await AdInvoice.findOneAndUpdate(
      { _id: params.invoiceId, settledAgainstPayout: false, settledAt: null },
      {
        $set: {
          settledAt: new Date(),
          collectionReference: params.reference,
          collectionReceiptUrl: params.receiptUrl,
          collectedBy: new Types.ObjectId(params.collectedBy),
        },
      },
      { new: true }
    );
    if (updated) return updated;

    const existing = await AdInvoice.findById(params.invoiceId).select('settledAgainstPayout settledAt');
    if (!existing) throw new AppError('Factura no encontrada', 404);
    if (existing.settledAgainstPayout) {
      throw new AppError('Esta factura se descuenta de la liquidación del comercio; no se cobra por fuera', 409);
    }
    throw new AppError('Esta factura ya fue cobrada', 409);
  },
};
