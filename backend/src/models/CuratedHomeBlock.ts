import mongoose, { Schema, Document, Types } from 'mongoose';

/**
 * Bloques curados a mano por un administrador, intercalados entre las veinte
 * colecciones automáticas del inicio (`homeSections.service.ts`).
 *
 * A diferencia de esas colecciones —que se calculan solas a partir de
 * ventas, descuentos, etc.— estos tres formatos existen porque hay
 * decisiones que solo una persona puede tomar: "estos 3 productos van juntos
 * en un spotlight", "estos 3 negocios merecen un banner", "esta lista de
 * negocios es una colección con nombre propio". El campo `order` es lo que
 * permite intercalarlos entre las colecciones automáticas sin tocar código
 * (ver el espacio numérico 10, 20, 30… que usa `homeSections.service.ts`
 * para esas veinte).
 */

export type CuratedHomeBlockKind = 'productBanner' | 'businessBanner' | 'businessCollection';

export const CURATED_HOME_BLOCK_KINDS: CuratedHomeBlockKind[] = [
  'productBanner',
  'businessBanner',
  'businessCollection',
];

/** Cuántos items exige cada formato. Los banners son un spotlight fijo de 3;
 * la colección de negocios es una fila horizontal de verdad, con el mismo
 * rango que usan las colecciones automáticas (`MIN_SECTION_SIZE`/
 * `TARGET_SIZE` en `homeSections.service.ts`). */
const ITEM_COUNT = {
  productBanner: { min: 3, max: 3 },
  businessBanner: { min: 3, max: 3 },
  businessCollection: { min: 4, max: 20 },
} as const;

export interface ICuratedHomeBlock extends Document {
  kind: CuratedHomeBlockKind;
  title: string;
  subtitle?: string;
  /** `Product` cuando `kind` es `productBanner`; `Business` en los otros dos casos. */
  items: Types.ObjectId[];
  /** Mismo espacio numérico que el `order` implícito de las colecciones automáticas. */
  order: number;
  isActive: boolean;
  startDate?: Date;
  endDate?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const curatedHomeBlockSchema = new Schema<ICuratedHomeBlock>(
  {
    kind: {
      type: String,
      enum: CURATED_HOME_BLOCK_KINDS,
      required: [true, 'El tipo de bloque es requerido'],
    },
    title: {
      type: String,
      required: [true, 'El título es requerido'],
      trim: true,
      maxlength: [80, 'El título no puede exceder 80 caracteres'],
    },
    subtitle: {
      type: String,
      trim: true,
      maxlength: [140, 'El subtítulo no puede exceder 140 caracteres'],
    },
    // Sin `ref`/`refPath` a propósito: qué colección resuelve cada id
    // depende de `kind` (`Product` para `productBanner`, `Business` para
    // los otros dos), y `homeSections.service.ts` ya sabe cuál consultar —
    // duplicar esa decisión aquí con `refPath` solo la escondería.
    items: {
      type: [{ type: Schema.Types.ObjectId }],
      required: true,
      validate: {
        validator(this: ICuratedHomeBlock, v: Types.ObjectId[]) {
          const bounds = ITEM_COUNT[this.kind];
          if (!bounds) return false;
          return v.length >= bounds.min && v.length <= bounds.max;
        },
        message: 'La cantidad de elementos no corresponde al tipo de bloque',
      },
    },
    order: { type: Number, required: true, min: 0, max: 999 },
    isActive: { type: Boolean, default: true },
    startDate: { type: Date },
    endDate: {
      type: Date,
      validate: {
        validator(this: ICuratedHomeBlock, v: Date) {
          return !this.startDate || !v || v > this.startDate;
        },
        message: 'La fecha de finalización debe ser posterior a la de inicio',
      },
    },
  },
  { timestamps: true }
);

/** Mismo gancho de coherencia de fechas que `PromotionBanner`, pero opcional. */
curatedHomeBlockSchema.pre('validate', function (next) {
  if (this.startDate && this.endDate && this.endDate <= this.startDate) {
    this.invalidate('endDate', 'La fecha de finalización debe ser posterior a la de inicio');
  }
  next();
});

// La consulta que hace `homeSections.service.ts` en cada carga del inicio:
// activos y ordenados. Las fechas se filtran en JS porque son opcionales.
curatedHomeBlockSchema.index({ isActive: 1, order: 1 });

export const CuratedHomeBlock = mongoose.model<ICuratedHomeBlock>(
  'CuratedHomeBlock',
  curatedHomeBlockSchema
);
