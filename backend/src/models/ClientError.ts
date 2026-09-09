import mongoose, { Schema, Document, Types } from 'mongoose';

/**
 * Un error que reventó en el teléfono de alguien.
 *
 * Antes de esto la app no tenía reporte de errores de ninguna clase: un
 * crash en producción era invisible. El usuario desinstalaba y no quedaba
 * rastro, así que los peores fallos del producto se conocían por WhatsApp
 * o no se conocían.
 *
 * Se guarda en la base y no en un tercero porque un servicio externo exige
 * una cuenta y una clave que hoy no existen — y dejar el hueco "pendiente
 * de configurar" es exactamente cómo se llegó a que las notificaciones push
 * nunca funcionaran en un año de desarrollo.
 *
 * **Caduca a los 30 días.** Un error de hace dos meses ya no describe la
 * app que hay hoy, y esta colección crece con el tráfico y con los fallos a
 * la vez: justo cuando peor va todo es cuando más escribe.
 */
export interface IClientError extends Document {
  userId: Types.ObjectId;
  message: string;
  stack?: string | null;
  /** Dejó la pantalla en blanco, frente al que se capturó y siguió. */
  fatal: boolean;
  /** Pantalla, hook o acción donde ocurrió. */
  scope?: string | null;
  /**
   * El pedido implicado.
   *
   * Es el campo que convierte un reporte en algo reproducible: un crash en
   * el checkout sin saber qué pedido era no se puede investigar.
   */
  orderId?: Types.ObjectId | null;
  platform: string;
  appVersion: string;
  deviceId?: string | null;
  extra?: Record<string, unknown> | null;
  /** Cuándo lo vio el teléfono, que puede no ser cuándo llegó aquí. */
  at: Date;
  createdAt: Date;
}

const clientErrorSchema = new Schema<IClientError>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    message: { type: String, required: true, maxlength: 500 },
    stack: { type: String, default: null, maxlength: 4000 },
    fatal: { type: Boolean, default: false, index: true },
    scope: { type: String, default: null, maxlength: 120 },
    orderId: { type: Schema.Types.ObjectId, ref: 'Order', default: null },
    platform: { type: String, required: true, maxlength: 60 },
    appVersion: { type: String, required: true, maxlength: 40 },
    deviceId: { type: String, default: null, maxlength: 120 },
    extra: { type: Schema.Types.Mixed, default: null },
    at: { type: Date, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// Agrupar por mensaje y versión es la primera pregunta que se hace siempre:
// "¿qué se está rompiendo más, y desde qué versión?".
clientErrorSchema.index({ message: 1, appVersion: 1, createdAt: -1 });

// TTL de 30 días. Ver el comentario de arriba.
clientErrorSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30 });

export const ClientError = mongoose.model<IClientError>('ClientError', clientErrorSchema);
