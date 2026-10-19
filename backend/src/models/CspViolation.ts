import mongoose, { Schema, Document } from 'mongoose';

/**
 * Infracciones de la Content-Security-Policy de los paneles, agrupadas (M-025).
 *
 * Mientras una política está en modo solo-informe, esto es lo único que dice si
 * pasar a bloqueo rompería algo legítimo. Una fila por combinación
 * panel + directiva + origen bloqueado, con un contador: un recurso que falla en
 * cada render mandaría miles de reportes iguales, y guardarlos uno a uno llenaría
 * la base justo cuando más información repetida hay.
 *
 * Solo guarda orígenes, nunca una URL completa: una ruta del panel puede llevar el
 * id de un pedido o de una persona en la dirección, y un reporte no es el sitio
 * para filtrarla.
 *
 * Caduca a los 30 días sin volver a verse.
 */
export interface ICspViolation extends Document {
  /** `panel` + directiva + origen bloqueado: la clave de agrupación. */
  key: string;
  documentOrigin: string;
  /** La directiva que se violó (`script-src`, `img-src`…). */
  directive: string;
  /** Origen bloqueado, o una palabra clave: `inline`, `eval`, `data`, `blob`. */
  blocked: string;
  /** `report` (solo informe) o `enforce` (ya bloqueó). */
  disposition: 'report' | 'enforce';
  count: number;
  firstSeen: Date;
  lastSeen: Date;
  /** Origen del archivo que lo provocó, si el navegador lo dio. */
  sourceOrigin?: string | null;
  /** Un fragmento corto de lo bloqueado (hasta 40 caracteres), solo para reconocerlo. */
  sample?: string | null;
}

const cspViolationSchema = new Schema<ICspViolation>(
  {
    key: { type: String, required: true, maxlength: 400 },
    documentOrigin: { type: String, required: true, maxlength: 200 },
    directive: { type: String, required: true, maxlength: 60 },
    blocked: { type: String, required: true, maxlength: 200 },
    disposition: { type: String, enum: ['report', 'enforce'], default: 'report' },
    count: { type: Number, default: 1, min: 1 },
    firstSeen: { type: Date, required: true },
    lastSeen: { type: Date, required: true },
    sourceOrigin: { type: String, default: null, maxlength: 200 },
    sample: { type: String, default: null, maxlength: 40 },
  },
  { timestamps: false }
);

cspViolationSchema.index({ key: 1 }, { unique: true });
cspViolationSchema.index({ lastSeen: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

export const CspViolation = mongoose.model<ICspViolation>('CspViolation', cspViolationSchema);
