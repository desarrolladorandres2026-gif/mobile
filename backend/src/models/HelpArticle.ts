import mongoose, { Schema, Document, Types } from 'mongoose';

/**
 * Artículo del Centro de ayuda del panel de comercios.
 *
 * Soporte los mantiene desde el panel de administración. El texto es plano
 * (saltos de línea, sin HTML): el panel lo pinta como texto, así que un
 * artículo nunca puede inyectar nada en la pantalla de un comercio.
 */
export const HELP_CATEGORIES = [
  'orders', 'products', 'drivers', 'payments', 'commissions', 'promotions', 'cancellations', 'refunds', 'account',
] as const;
export type HelpCategory = (typeof HELP_CATEGORIES)[number];

export interface IHelpArticle extends Document {
  category: HelpCategory;
  question: string;
  answer: string;
  /** Posición dentro de su categoría; a igualdad, el más antiguo primero. */
  sortOrder: number;
  /** Un borrador o archivado no llega al panel de comercios. */
  isPublished: boolean;
  createdBy: Types.ObjectId | null;
  updatedBy?: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const helpArticleSchema = new Schema<IHelpArticle>({
  category: { type: String, enum: HELP_CATEGORIES, required: true },
  question: { type: String, required: true, trim: true, maxlength: 200 },
  answer: { type: String, required: true, trim: true, maxlength: 4000 },
  sortOrder: { type: Number, default: 0 },
  isPublished: { type: Boolean, default: true },
  // null en los artículos que sembró la migración 027.
  createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true });
helpArticleSchema.index({ isPublished: 1, category: 1, sortOrder: 1, createdAt: 1 });

export const HelpArticle = mongoose.model<IHelpArticle>('HelpArticle', helpArticleSchema);
