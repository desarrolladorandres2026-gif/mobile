import mongoose, { Schema, Document } from 'mongoose';
import { cacheInvalidationPlugin, CachePrefix } from '../cache';

/**
 * Categorías de negocio que se muestran en el Home de la app móvil
 * (Restaurantes, Comida rápida, etc.).
 *
 * Dominio distinto de `Category` (menú de un negocio, campo `businessId`):
 * esto es la vitrina de la pantalla inicial, no el catálogo de un negocio.
 * La `key` debe coincidir con las claves de `BUSINESS_CATEGORIES` en
 * `mobile/constants/config.ts` para que la app pueda resolver el icono de
 * respaldo cuando no hay `imageUrl`.
 */
export interface IHomeCategory extends Document {
  key: string;
  name: string;
  imageUrl?: string;
  status: 'active' | 'inactive';
  order: number;
  createdAt: Date;
  updatedAt: Date;
}

const homeCategorySchema = new Schema<IHomeCategory>(
  {
    key: {
      type: String,
      required: [true, 'La clave de la categoría es requerida'],
      trim: true,
      lowercase: true,
      unique: true,
      maxlength: [40, 'La clave no puede exceder 40 caracteres'],
    },
    name: {
      type: String,
      required: [true, 'El nombre de la categoría es requerido'],
      trim: true,
      maxlength: [40, 'El nombre no puede exceder 40 caracteres'],
    },
    imageUrl: {
      type: String,
      default: '',
      trim: true,
    },
    status: {
      type: String,
      enum: ['active', 'inactive'],
      default: 'active',
    },
    order: { type: Number, default: 0, min: 0, max: 999 },
  },
  { timestamps: true }
);

// La consulta que hace la app en cada arranque: solo activas, ya ordenadas.
homeCategorySchema.index({ status: 1, order: 1 });

// Cada escritura limpia lo que la caché de lecturas tenga de este modelo.
homeCategorySchema.plugin(cacheInvalidationPlugin, {
  prefixesFor: () => [CachePrefix.HOME_CATEGORIES, CachePrefix.HOME],
});

export const HomeCategory = mongoose.model<IHomeCategory>('HomeCategory', homeCategorySchema);
