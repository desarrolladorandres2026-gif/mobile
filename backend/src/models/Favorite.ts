import mongoose, { Schema, Document, Types } from 'mongoose';

/**
 * Lo que un cliente marcó para volver.
 *
 * Vivía solo en el teléfono, en el almacenamiento local de la app. Eso
 * significaba que cambiar de móvil, reinstalar o limpiar los datos borraba
 * la lista entera sin aviso — y los favoritos son de las pocas cosas que un
 * usuario construye a mano, una por una, a lo largo de meses.
 *
 * Un mismo documento sirve para negocios y para productos. Separarlos en
 * dos colecciones duplicaría los índices, las rutas y la sincronización
 * para guardar exactamente el mismo par: quién y qué.
 */
export type FavoriteKind = 'business' | 'product';

export interface IFavorite extends Document {
  userId: Types.ObjectId;
  kind: FavoriteKind;
  targetId: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const favoriteSchema = new Schema<IFavorite>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    kind: { type: String, enum: ['business', 'product'], required: true },
    targetId: { type: Schema.Types.ObjectId, required: true },
  },
  { timestamps: true }
);

// Marcar dos veces lo mismo no es un favorito nuevo. El índice único
// convierte "añadir" en una operación que se puede repetir sin miedo, que
// es justo lo que necesita una app que sincroniza tras estar sin conexión.
favoriteSchema.index({ userId: 1, kind: 1, targetId: 1 }, { unique: true });
favoriteSchema.index({ userId: 1, createdAt: -1 });

export const Favorite = mongoose.model<IFavorite>('Favorite', favoriteSchema);
