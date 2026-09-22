import mongoose, { Schema, Document, Types } from 'mongoose';

/**
 * Qué pasó con cada intento de quitarle el fondo a una foto.
 *
 * Tres usos, y por eso es una colección y no una línea de log:
 *
 * - **Métricas**: cuántas se procesan, cuántas fallan y cuánto tardan, por
 *   proveedor (`GET /admin/image-processing/stats`).
 * - **El tope diario por comercio**: se cuentan aquí, no en memoria del
 *   proceso, así que el tope aguanta reinicios y más de una instancia.
 * - **Cuadrar la factura del proveedor**: cada `completed` y cada `failed`
 *   que llegó a responder es un crédito cobrado.
 *
 * No va al libro mayor: es un coste de operación sin pedido detrás.
 * Nunca guarda la imagen, la clave ni el cuerpo de la respuesta del
 * proveedor — solo códigos estables.
 */
export type ImageProcessingOutcome =
  | 'completed'
  | 'failed'
  | 'retry_scheduled'
  | 'superseded'
  | 'limited';

export interface IImageProcessingEvent extends Document {
  businessId: Types.ObjectId;
  productId: Types.ObjectId;
  provider: string;
  outcome: ImageProcessingOutcome;
  errorCode: string | null;
  durationMs: number | null;
  attempt: number;
  /**
   * Si esta llamada consumió un crédito del proveedor. Un `limited` o un
   * fallo antes de llegar a él no cuesta; un `completed` o una respuesta
   * inválida sí.
   */
  billable: boolean;
  createdAt: Date;
}

/** Cuánto se guarda: medio año alcanza para comparar temporadas. */
const RETENTION_SECONDS = 180 * 24 * 60 * 60;

const imageProcessingEventSchema = new Schema<IImageProcessingEvent>(
  {
    businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true },
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    provider: { type: String, required: true, maxlength: 40 },
    outcome: {
      type: String,
      enum: ['completed', 'failed', 'retry_scheduled', 'superseded', 'limited'],
      required: true,
    },
    errorCode: { type: String, default: null, maxlength: 60 },
    durationMs: { type: Number, default: null, min: 0 },
    attempt: { type: Number, default: 1, min: 0 },
    billable: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now },
  },
  { timestamps: false }
);

imageProcessingEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: RETENTION_SECONDS });
// El tope diario: "cuántas llevas hoy este comercio".
imageProcessingEventSchema.index({ businessId: 1, createdAt: -1 });

export const ImageProcessingEvent = mongoose.model<IImageProcessingEvent>(
  'ImageProcessingEvent',
  imageProcessingEventSchema
);
