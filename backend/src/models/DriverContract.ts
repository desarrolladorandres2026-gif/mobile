import mongoose, { Schema, Document, Types } from 'mongoose';

/**
 * Contrato de prestación de servicios de un domiciliario.
 *
 * Se registra a mano por un administrador: no hay firma electrónica. El PDF
 * firmado y los anexos viven en entrega privada de Cloudinary (solo la llave
 * se guarda; ver `privateStorage.service.ts`). Un cobro o pago nunca cuelga de
 * aquí: es solo el expediente de la relación.
 */
export const DRIVER_CONTRACT_STATUSES = ['draft', 'active', 'suspended', 'terminated'] as const;
export type DriverContractStatus = (typeof DRIVER_CONTRACT_STATUSES)[number];

export const MAX_CONTRACT_HISTORY = 50;
export const MAX_CONTRACT_EXTRA_FILES = 10;

export interface IContractFile {
  key: string;
  resourceType: 'image' | 'raw';
  format: 'jpg' | 'png' | 'webp' | 'pdf';
  bytes: number;
  uploadedAt: Date;
  uploadedBy?: Types.ObjectId;
}

export interface IContractExtraFile extends IContractFile {
  _id: Types.ObjectId;
  name: string;
}

export interface IContractHistoryEntry {
  at: Date;
  byUserId?: Types.ObjectId;
  byName?: string;
  action: 'created' | 'updated' | 'file_uploaded' | 'extra_uploaded' | 'extra_removed';
  note?: string;
}

export interface IDriverContract extends Document {
  driverId: Types.ObjectId;
  status: DriverContractStatus;
  startDate?: Date;
  endDate?: Date;
  file?: IContractFile;
  extraFiles: IContractExtraFile[];
  history: IContractHistoryEntry[];
  createdAt: Date;
  updatedAt: Date;
}

const fileFields = {
  key: { type: String, required: true },
  resourceType: { type: String, enum: ['image', 'raw'], required: true },
  format: { type: String, enum: ['jpg', 'png', 'webp', 'pdf'], required: true },
  bytes: { type: Number, required: true },
  uploadedAt: { type: Date, required: true },
  uploadedBy: { type: Schema.Types.ObjectId, ref: 'User' },
};

const schema = new Schema<IDriverContract>(
  {
    driverId: { type: Schema.Types.ObjectId, ref: 'Driver', required: true, unique: true },
    status: { type: String, enum: [...DRIVER_CONTRACT_STATUSES], default: 'draft' },
    startDate: Date,
    endDate: Date,
    file: { type: new Schema(fileFields, { _id: false }), default: undefined },
    extraFiles: {
      type: [new Schema({ ...fileFields, name: { type: String, required: true, trim: true, maxlength: 80 } })],
      default: [],
    },
    history: {
      type: [
        new Schema(
          {
            at: { type: Date, required: true },
            byUserId: { type: Schema.Types.ObjectId, ref: 'User' },
            byName: { type: String, trim: true, maxlength: 120 },
            action: { type: String, enum: ['created', 'updated', 'file_uploaded', 'extra_uploaded', 'extra_removed'], required: true },
            note: { type: String, trim: true, maxlength: 500 },
          },
          { _id: false }
        ),
      ],
      default: [],
    },
  },
  { timestamps: true }
);

export const DriverContract = mongoose.model<IDriverContract>('DriverContract', schema);
