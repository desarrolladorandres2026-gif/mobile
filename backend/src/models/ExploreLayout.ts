import mongoose, { Schema, Document, Types } from 'mongoose';

/**
 * La configuración de la pestaña Explorar, editable desde el panel.
 *
 * Dos colecciones y no una, siguiendo el patrón de `PlatformPricingConfig`:
 *
 * - `ExploreLayoutState` es el **borrador**, uno por `scope`. Se guarda
 *   muchas veces mientras un admin edita, así que **no** lleva el plugin de
 *   invalidación de caché: si lo llevara, cada guardado vaciaría la caché de
 *   Explorar para todo el mundo por un cambio que nadie ve todavía.
 * - `ExploreLayoutVersion` son las **versiones publicadas**: solo se
 *   insertan, nunca se editan. Restaurar es copiar una al borrador o
 *   republicarla como versión nueva — el historial nunca se reescribe.
 *
 * `scope` hoy siempre es `'global'`. Existe para que un Explorar por ciudad
 * sea una fila más, no una migración.
 *
 * Las secciones se guardan como `Mixed`: su forma la valida Zod
 * (`validators/exploreLayout.validator.ts`) al entrar y al salir. Un `Mixed`
 * de Mongoose no puede expresar una unión discriminada.
 */

export const EXPLORE_GLOBAL_SCOPE = 'global';

export interface IExploreLayoutState extends Document {
  scope: string;
  draft: unknown[];
  schemaVersion: number;
  /** Sube con cada guardado. Guardar o publicar exige la revisión que se vio. */
  revision: number;
  /** La versión publicada vigente; 0 mientras nunca se haya publicado. */
  currentVersion: number;
  updatedBy?: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const exploreLayoutStateSchema = new Schema<IExploreLayoutState>(
  {
    scope: { type: String, required: true, unique: true, trim: true, maxlength: 40 },
    draft: { type: [Schema.Types.Mixed], default: [] },
    schemaVersion: { type: Number, required: true, min: 1 },
    revision: { type: Number, required: true, min: 0, default: 0 },
    currentVersion: { type: Number, required: true, min: 0, default: 0 },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

export const ExploreLayoutState = mongoose.model<IExploreLayoutState>(
  'ExploreLayoutState',
  exploreLayoutStateSchema
);

export interface IExploreLayoutVersion extends Document {
  scope: string;
  version: number;
  sections: unknown[];
  schemaVersion: number;
  publishedBy?: Types.ObjectId | null;
  publishedAt: Date;
  /** Qué cambió, en palabras de quien publicó. */
  note: string;
  /** Si se publicó restaurando otra versión, cuál. */
  restoredFrom?: number | null;
}

const exploreLayoutVersionSchema = new Schema<IExploreLayoutVersion>({
  scope: { type: String, required: true, trim: true, maxlength: 40 },
  version: { type: Number, required: true, min: 1 },
  sections: { type: [Schema.Types.Mixed], default: [] },
  schemaVersion: { type: Number, required: true, min: 1 },
  publishedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  publishedAt: { type: Date, required: true, default: Date.now },
  note: { type: String, default: '', trim: true, maxlength: 200 },
  restoredFrom: { type: Number, default: null },
});

// El índice único es el cerrojo de la publicación: dos admins que publican
// a la vez calculan el mismo número y solo uno puede insertarlo.
exploreLayoutVersionSchema.index({ scope: 1, version: 1 }, { unique: true });
exploreLayoutVersionSchema.index({ scope: 1, publishedAt: -1 });

export const ExploreLayoutVersion = mongoose.model<IExploreLayoutVersion>(
  'ExploreLayoutVersion',
  exploreLayoutVersionSchema
);
