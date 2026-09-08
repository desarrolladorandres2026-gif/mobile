import mongoose, { Schema, Document, Types } from 'mongoose';

export interface IReview extends Document {
  orderId: Types.ObjectId;
  userId: Types.ObjectId;
  businessId: Types.ObjectId;
  driverId?: Types.ObjectId;
  businessRating?: number;
  driverRating?: number;
  comment?: string;

  /**
   * Respuesta pública del negocio.
   *
   * Poder contestar cambia lo que significa una mala reseña: deja de ser
   * una sentencia y pasa a ser una conversación que los demás clientes
   * leen. Es la diferencia entre un comercio que parece ignorar los
   * problemas y uno que los resuelve.
   */
  businessReply?: string;
  businessRepliedAt?: Date;

  /**
   * La otra dirección: qué tal se portó el cliente.
   *
   * No es simetría por elegancia. Un domiciliario que llega a una dirección
   * inventada, o un negocio con un cliente que insulta por el chat, hoy no
   * tienen dónde dejarlo constando. Estas notas no son públicas: alimentan
   * el perfil de riesgo, no una estrella en el perfil de nadie.
   */
  clientRatingByBusiness?: number;
  clientRatingByDriver?: number;
  clientNotes?: string;

  /**
   * Qué le pareció cada plato, en pulgares.
   *
   * Cinco estrellas por producto son demasiada fricción justo después de
   * comer: la gente abandona la pantalla y no se obtiene nada. Un gesto
   * binario se responde sin pensar y basta para ordenar una carta, que es
   * para lo único que se va a usar.
   */
  productFeedback?: Array<{ productId: Types.ObjectId; liked: boolean }>;

  /** Moderación: una reseña oculta no cuenta para la media ni se muestra. */
  isHidden: boolean;
  hiddenReason?: string;
  hiddenBy?: Types.ObjectId;
  hiddenAt?: Date;

  createdAt: Date;
}

const reviewSchema = new Schema<IReview>(
  {
    orderId: { type: Schema.Types.ObjectId, ref: 'Order', required: true, unique: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true },
    driverId: { type: Schema.Types.ObjectId, ref: 'Driver', default: null },
    // No obligatoria: una reseña puede nacer del lado del negocio o del
    // domiciliario calificando al cliente, antes de que el cliente haya
    // dicho nada. Quien exige la nota es el flujo del cliente, no el
    // esquema, porque el documento sirve a tres actores distintos.
    businessRating: { type: Number, min: 1, max: 5, default: null },
    driverRating: { type: Number, min: 1, max: 5, default: null },
    comment: { type: String, default: '', maxlength: 500 },

    businessReply: { type: String, maxlength: 500 },
    businessRepliedAt: { type: Date },

    clientRatingByBusiness: { type: Number, min: 1, max: 5, default: null },
    clientRatingByDriver: { type: Number, min: 1, max: 5, default: null },
    clientNotes: { type: String, maxlength: 500 },

    productFeedback: {
      type: [
        new Schema(
          {
            productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
            liked: { type: Boolean, required: true },
          },
          { _id: false }
        ),
      ],
      default: undefined,
    },

    isHidden: { type: Boolean, default: false },
    hiddenReason: { type: String, maxlength: 300 },
    hiddenBy: { type: Schema.Types.ObjectId, ref: 'User' },
    hiddenAt: { type: Date },
  },
  { timestamps: true }
);

reviewSchema.index({ businessId: 1, createdAt: -1 });
reviewSchema.index({ driverId: 1 });
// La cola de moderación pregunta por lo oculto y lo reciente.
reviewSchema.index({ isHidden: 1, createdAt: -1 });

export const Review = mongoose.model<IReview>('Review', reviewSchema);
