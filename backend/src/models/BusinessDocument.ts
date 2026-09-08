import mongoose, { Schema, Document, Types } from 'mongoose';

/**
 * Papeles que un comercio tiene que presentar para operar en ZIPP.
 *
 * Los tipos son los que pide la realidad colombiana, no una lista genérica:
 * el RUT identifica fiscalmente al negocio, la matrícula mercantil demuestra
 * que existe, la cédula del representante dice quién responde, y la
 * certificación bancaria es a dónde va el dinero de sus ventas —sin ella no
 * se le puede pagar aunque venda.
 *
 * El concepto sanitario solo aplica a quien manipula alimentos. Exigírselo a
 * una droguería o a una papelería sería inventar un requisito.
 */
export type BusinessDocumentType =
  | 'rut'
  | 'chamber_of_commerce'
  | 'legal_rep_id'
  | 'bank_certificate'
  | 'health_permit';

export const REQUIRED_BUSINESS_DOCUMENTS: BusinessDocumentType[] = [
  'rut',
  'chamber_of_commerce',
  'legal_rep_id',
  'bank_certificate',
];

/** Categorías que manipulan alimentos y por tanto necesitan concepto sanitario. */
export const FOOD_CATEGORIES = ['restaurant', 'fast_food', 'cafe', 'bakery', 'supermarket'];

export interface IBusinessDocument extends Document {
  businessId: Types.ObjectId;
  type: BusinessDocumentType;
  /** Número, URL del archivo o referencia externa. */
  reference: string;
  expiresAt?: Date;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  rejectionReason?: string;
  reviewedBy?: Types.ObjectId;
  reviewedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const schema = new Schema<IBusinessDocument>(
  {
    businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true },
    type: {
      type: String,
      enum: ['rut', 'chamber_of_commerce', 'legal_rep_id', 'bank_certificate', 'health_permit'],
      required: true,
    },
    reference: { type: String, required: true, trim: true, maxlength: 500 },
    expiresAt: Date,
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected', 'expired'],
      default: 'pending',
    },
    rejectionReason: { type: String, maxlength: 300 },
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    reviewedAt: Date,
  },
  { timestamps: true }
);

// Un documento de cada tipo por negocio: volver a enviarlo reemplaza al
// anterior en vez de acumular versiones que nadie sabe cuál mirar.
schema.index({ businessId: 1, type: 1 }, { unique: true });
schema.index({ status: 1, expiresAt: 1 });

export const BusinessDocument = mongoose.model<IBusinessDocument>('BusinessDocument', schema);
