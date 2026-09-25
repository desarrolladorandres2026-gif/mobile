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

export type BusinessDocumentStatus = 'pending' | 'approved' | 'rejected' | 'expired';

/**
 * Una versión anterior del documento, guardada al reenviarlo.
 *
 * El índice único `{businessId, type}` hace que un reenvío sobrescriba el
 * documento; sin esto, un rechazo desaparecía en cuanto el comercio volvía a
 * subir el papel, y nadie podía ver cuántas veces lo intentó ni por qué se
 * rechazó cada vez. Vive dentro del mismo documento (no en otra colección)
 * porque nunca se consulta aparte y se acota a `MAX_DOCUMENT_HISTORY`.
 */
export interface IBusinessDocumentHistoryEntry {
  status: BusinessDocumentStatus;
  rejectionReason?: string | null;
  reviewedBy?: Types.ObjectId | null;
  reviewedAt?: Date | null;
  /** `public_id` privado del archivo de esa versión. */
  fileKey?: string | null;
  fileResourceType?: 'image' | 'raw' | null;
  reference?: string;
  /** Cuándo el comercio subió esa versión. */
  submittedAt?: Date;
  /** Cuándo se archivó (es decir, cuándo la reemplazó otra). */
  archivedAt: Date;
}

/** Cuántas versiones anteriores se conservan por documento. */
export const MAX_DOCUMENT_HISTORY = 20;

export interface IBusinessDocument extends Document {
  businessId: Types.ObjectId;
  type: BusinessDocumentType;
  /** Número del documento (p. ej. la matrícula mercantil o el NIT del RUT). */
  reference: string;
  expiresAt?: Date;
  status: BusinessDocumentStatus;
  rejectionReason?: string | null;
  reviewedBy?: Types.ObjectId | null;
  reviewedAt?: Date | null;
  /**
   * El archivo escaneado, en entrega privada de Cloudinary (O4).
   *
   * Es una llave, nunca una URL: la URL firmada se calcula al leer, después
   * de comprobar quién pregunta (ver `privateStorage.service.ts`). Vacío en
   * los documentos anteriores a la subida de archivos, que solo traían
   * `reference`.
   */
  fileKey?: string | null;
  /** Con qué `resource_type` de Cloudinary se subió (`raw` para PDF). */
  fileResourceType?: 'image' | 'raw' | null;
  fileFormat?: 'jpg' | 'png' | 'webp' | 'pdf' | null;
  isPrivate: boolean;
  /** Cuándo el comercio subió la versión actual. */
  submittedAt?: Date | null;
  /**
   * Quién subió la versión actual. Sirve a la separación de funciones: un
   * admin que sube un papel en nombre del comercio no puede aprobarlo él mismo.
   */
  submittedBy?: Types.ObjectId | null;
  history: IBusinessDocumentHistoryEntry[];
  /** Avisos de vencimiento ya enviados, `<expiresAt ISO>:<etapa>` (ver `documentExpiry.service`). */
  expiryRemindersSent?: string[];
  createdAt: Date;
  updatedAt: Date;
}

const historyEntrySchema = new Schema<IBusinessDocumentHistoryEntry>(
  {
    status: { type: String, enum: ['pending', 'approved', 'rejected', 'expired'], required: true },
    rejectionReason: { type: String, maxlength: 300, default: null },
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    reviewedAt: { type: Date, default: null },
    fileKey: { type: String, default: null },
    fileResourceType: { type: String, enum: ['image', 'raw', null], default: null },
    reference: { type: String, maxlength: 500 },
    submittedAt: { type: Date },
    archivedAt: { type: Date, required: true },
  },
  { _id: false }
);

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
    fileKey: { type: String, default: null },
    fileResourceType: { type: String, enum: ['image', 'raw', null], default: null },
    fileFormat: { type: String, enum: ['jpg', 'png', 'webp', 'pdf', null], default: null },
    isPrivate: { type: Boolean, default: false },
    submittedAt: { type: Date, default: null },
    submittedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    history: { type: [historyEntrySchema], default: [] },
    expiryRemindersSent: { type: [String], default: undefined, select: false },
  },
  { timestamps: true }
);

// Un documento de cada tipo por negocio: volver a enviarlo reemplaza al
// anterior como versión vigente —el anterior pasa a `history`— en vez de
// acumular filas que nadie sabe cuál mirar.
schema.index({ businessId: 1, type: 1 }, { unique: true });
schema.index({ status: 1, expiresAt: 1 });

export const BusinessDocument = mongoose.model<IBusinessDocument>('BusinessDocument', schema);
