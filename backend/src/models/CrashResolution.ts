import mongoose, { Schema, Document, Types } from 'mongoose';

/**
 * Un error de la app marcado como resuelto.
 *
 * Se resuelve un **mensaje**, no un grupo mensaje+versión, y se guarda en qué
 * versiones se había visto al resolverlo. Así:
 *  - si el mismo error sigue llegando desde una versión vieja (gente que no
 *    ha actualizado), sigue resuelto: el arreglo ya está publicado;
 *  - si aparece en una versión que no estaba en la lista, se enseña como
 *    **regresión**: el arreglo no funcionó o volvió a romperse.
 *
 * No caduca con `ClientError` (30 días): una resolución vieja es justo la que
 * permite reconocer una regresión.
 */
export interface ICrashResolution extends Document {
  message: string;
  versions: string[];
  note?: string | null;
  resolvedBy: Types.ObjectId;
  resolvedAt: Date;
}

const crashResolutionSchema = new Schema<ICrashResolution>(
  {
    message: { type: String, required: true, maxlength: 500, unique: true },
    versions: { type: [String], default: [] },
    note: { type: String, default: null, maxlength: 300 },
    resolvedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    resolvedAt: { type: Date, required: true },
  },
  { timestamps: true }
);

export const CrashResolution = mongoose.model<ICrashResolution>('CrashResolution', crashResolutionSchema);
