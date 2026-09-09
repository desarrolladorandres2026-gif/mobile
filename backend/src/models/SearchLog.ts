import mongoose, { Schema, Document, Types } from 'mongoose';

/**
 * Lo que la gente escribe en la caja de búsqueda.
 *
 * Sirve para dos cosas, y la segunda vale más que la primera:
 *
 * 1. "Lo más buscado" deja de ser una lista de categorías del catálogo
 *    disfrazada de tendencia y pasa a ser lo que de verdad se busca.
 * 2. Las búsquedas que devuelven cero resultados son la lista priorizada de
 *    qué falta en el pueblo. Nadie más la tiene: el cliente que buscó
 *    "sushi" y no encontró nada se va sin decírselo a nadie.
 *
 * Solo se registran búsquedas confirmadas —el usuario pulsó buscar, eligió
 * una sugerencia o abrió un resultado—, nunca lo que se escribe a medias.
 * Guardar cada pausa del teclado llenaría esto de "ham", "hambur",
 * "hamburgu" y haría inservibles las dos lecturas de arriba.
 */
export interface ISearchLog extends Document {
  /** Tal cual lo escribió, para poder leerlo en el panel. */
  termRaw: string;
  /** Normalizado, que es por donde se agrupa. */
  term: string;
  /** Ausente cuando busca alguien sin sesión, que es un caso normal. */
  userId?: Types.ObjectId | null;
  resultCount: number;
  /** El término corregido, si la búsqueda tuvo que rescatarse. */
  suggestedTerm?: string | null;
  createdAt: Date;
}

const searchLogSchema = new Schema<ISearchLog>(
  {
    termRaw: { type: String, required: true, maxlength: 100 },
    term: { type: String, required: true, maxlength: 100 },
    userId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    resultCount: { type: Number, required: true, min: 0 },
    suggestedTerm: { type: String, default: null, maxlength: 100 },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// La consulta de tendencias: agrupar por término dentro de una ventana.
searchLogSchema.index({ term: 1, createdAt: -1 });
// Y la de "qué se buscó y no había", que es la interesante para captación.
searchLogSchema.index({ resultCount: 1, createdAt: -1 });

/**
 * Noventa días y se borra solo.
 *
 * Es un dato de tendencia, no un historial: lo que se buscaba hace un año
 * no dice nada útil hoy y sí sería un rastro de lo que buscó cada persona
 * guardado sin motivo.
 */
searchLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

export const SearchLog = mongoose.model<ISearchLog>('SearchLog', searchLogSchema);
