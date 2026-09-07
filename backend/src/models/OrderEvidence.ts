import mongoose, { Schema, Document, Types } from 'mongoose';
import { OrderEvidenceType, OrderStatus, UserRole, GeoPoint } from '../types';

/**
 * Fotografía que documenta un traspaso de custodia del pedido.
 *
 * La imagen vive en Cloudinary —el mismo almacenamiento que ya usan
 * avatares, banners y flyers— y aquí solo queda su identificador. Guardar
 * el binario en Mongo haría que cada consulta de un pedido arrastrase
 * megabytes y que un backup de la base pesara como un bucket entero.
 *
 * `storageKey` es el `public_id` de Cloudinary y es el dato autoritativo:
 * la URL de entrega se firma en cada lectura y caduca, así que no puede
 * ser lo único que se persista.
 */
export interface IOrderEvidence extends Document {
  orderId: Types.ObjectId;
  type: OrderEvidenceType;
  /** `public_id` en Cloudinary. Único e imposible de adivinar. */
  storageKey: string;
  /** URL tal como la devolvió el proveedor al subir. Puede requerir firma. */
  imageUrl: string;
  /** Si es true, `imageUrl` no sirve por sí sola: hay que firmarla. */
  isPrivate: boolean;
  uploadedBy: Types.ObjectId;
  uploadedByRole: UserRole;
  /** Partes implicadas en este traspaso, congeladas al subir la foto. */
  driverId: Types.ObjectId | null;
  businessId: Types.ObjectId | null;
  customerId: Types.ObjectId | null;
  /** Estado del pedido en el instante de la captura. */
  orderStatus: OrderStatus;
  /** Dónde estaba el dispositivo, si la app pudo obtenerlo. */
  location?: GeoPoint | null;
  metadata: {
    bytes: number;
    format: string;
    width?: number;
    height?: number;
    /** SHA-256 del binario recibido: detecta una foto reutilizada. */
    checksum: string;
  };
  uploadedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const orderEvidenceSchema = new Schema<IOrderEvidence>(
  {
    orderId: { type: Schema.Types.ObjectId, ref: 'Order', required: true, index: true },
    type: { type: String, enum: Object.values(OrderEvidenceType), required: true },
    storageKey: { type: String, required: true },
    imageUrl: { type: String, required: true },
    isPrivate: { type: Boolean, default: true },
    uploadedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    uploadedByRole: { type: String, enum: Object.values(UserRole), required: true },
    driverId: { type: Schema.Types.ObjectId, ref: 'Driver', default: null, index: true },
    businessId: { type: Schema.Types.ObjectId, ref: 'Business', default: null, index: true },
    customerId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    orderStatus: { type: String, enum: Object.values(OrderStatus), required: true },
    location: new Schema(
      {
        type: { type: String, enum: ['Point'], default: 'Point' },
        coordinates: { type: [Number], required: true },
      },
      { _id: false }
    ),
    metadata: {
      bytes: { type: Number, required: true, min: 0 },
      format: { type: String, required: true },
      width: { type: Number },
      height: { type: Number },
      checksum: { type: String, required: true },
    },
    uploadedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

// El panel de administración filtra por pedido+tipo (¿tiene evidencia de
// recogida?) y lista por fecha; ambos accesos van indexados.
orderEvidenceSchema.index({ orderId: 1, type: 1 });
orderEvidenceSchema.index({ type: 1, uploadedAt: -1 });
orderEvidenceSchema.index({ driverId: 1, uploadedAt: -1 });

export const OrderEvidence = mongoose.model<IOrderEvidence>(
  'OrderEvidence',
  orderEvidenceSchema
);
