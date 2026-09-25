import mongoose, { Schema, Document, Types } from 'mongoose';

/**
 * Comprobante interno de una liquidación pagada.
 *
 * **No es una factura.** ZIPP aún no tiene NIT ni proveedor tecnológico de la
 * DIAN, así que esto es un soporte de gestión con consecutivo propio (`INT-`)
 * que el contador puede usar de base y que el día del NIT se sustituye por el
 * documento electrónico. Lo dice el propio documento (`notice`) y la app no
 * debe presentarlo como factura (docs/PANEL-ADMIN.md §5).
 *
 * Vive **fuera del libro mayor** por la misma razón que `AdInvoice`: el libro
 * está atado a pedidos y este documento es una foto de lo pagado.
 *
 * Es inmutable: una foto de lo que se pagó no se edita. Un error se corrige
 * con un documento nuevo y una nota, no reescribiendo el anterior. Y solo
 * guarda los últimos 4 del documento de la persona: el número completo ya
 * vive cifrado en su ficha y no hay motivo para duplicarlo aquí.
 */
export const FISCAL_DOCUMENT_TYPES = ['settlement_statement', 'driver_payment_voucher'] as const;
export type FiscalDocumentType = (typeof FISCAL_DOCUMENT_TYPES)[number];

export const FISCAL_DOCUMENT_NOTICE =
  'Comprobante interno de gestión. No es factura electrónica ni documento soporte DIAN.';

export interface IFiscalDocumentLine {
  label: string;
  /** Con signo: lo que resta va en negativo. */
  amount: number;
}

export interface IFiscalDocument extends Document {
  /** `INT-000123`. Consecutivo único, sin saltos salvo caída entre reservar y guardar. */
  number: string;
  type: FiscalDocumentType;
  settlementId: Types.ObjectId;
  party: {
    kind: 'business' | 'driver';
    id: Types.ObjectId;
    name: string;
    legalName?: string | null;
    documentType?: string | null;
    documentLast4?: string | null;
    dv?: string | null;
    taxRegime?: string | null;
  };
  lines: IFiscalDocumentLine[];
  netAmount: number;
  currency: string;
  paymentMethod?: string | null;
  paymentReference?: string | null;
  paidAt?: Date | null;
  notice: string;
  issuedBy: Types.ObjectId;
  issuedAt: Date;
  createdAt: Date;
}

const fiscalDocumentSchema = new Schema<IFiscalDocument>(
  {
    number: { type: String, required: true, unique: true },
    type: { type: String, enum: FISCAL_DOCUMENT_TYPES, required: true },
    settlementId: { type: Schema.Types.ObjectId, ref: 'Settlement', required: true },
    party: {
      kind: { type: String, enum: ['business', 'driver'], required: true },
      id: { type: Schema.Types.ObjectId, required: true },
      name: { type: String, required: true },
      legalName: { type: String, default: null },
      documentType: { type: String, default: null },
      documentLast4: { type: String, default: null, maxlength: 4 },
      dv: { type: String, default: null },
      taxRegime: { type: String, default: null },
    },
    lines: {
      type: [
        {
          _id: false,
          label: { type: String, required: true },
          amount: { type: Number, required: true, validate: Number.isInteger },
        },
      ],
      default: [],
    },
    netAmount: { type: Number, required: true, min: 0, validate: Number.isInteger },
    currency: { type: String, default: 'COP' },
    paymentMethod: { type: String, default: null },
    paymentReference: { type: String, default: null },
    paidAt: { type: Date, default: null },
    notice: { type: String, default: FISCAL_DOCUMENT_NOTICE },
    issuedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    issuedAt: { type: Date, default: Date.now },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// Un solo comprobante de cada tipo por liquidación: el índice es la garantía,
// no una comprobación que alguien pueda olvidar.
fiscalDocumentSchema.index({ settlementId: 1, type: 1 }, { unique: true });
fiscalDocumentSchema.index({ issuedAt: -1 });

// Inmutable: cualquier actualización se rechaza.
for (const op of ['updateOne', 'findOneAndUpdate', 'updateMany', 'replaceOne', 'findOneAndReplace'] as const) {
  fiscalDocumentSchema.pre(op, function () {
    throw new Error('Un comprobante interno no se modifica: emite uno nuevo con la corrección');
  });
}

export const FiscalDocument = mongoose.model<IFiscalDocument>('FiscalDocument', fiscalDocumentSchema);
