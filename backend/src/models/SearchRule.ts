import mongoose, { Schema, Document, Types } from 'mongoose';

/**
 * Lo que administración decide hacer con un término de búsqueda.
 *
 * - `synonym`: si el término literal no devuelve nada, se busca `synonymOf`
 *   ("milanesa" → "pechuga apanada"). Solo entra cuando la búsqueda vendría
 *   vacía: nunca pisa un resultado que ya existía.
 * - `redirect`: si la búsqueda sigue vacía, la app ofrece ir a una
 *   categoría o a un negocio en vez de un "nada con esa búsqueda".
 * - `handled`: alguien ya lo vio y decidió que no hay nada que hacer (o que
 *   ya se está captando). Sale de la lista de búsquedas sin resultado.
 *
 * Una regla por término normalizado: un mismo término con dos destinos
 * distintos sería una regla que gana según el orden de una consulta.
 */
export type SearchRuleKind = 'synonym' | 'redirect' | 'handled';

export const SEARCH_RULE_KINDS: SearchRuleKind[] = ['synonym', 'redirect', 'handled'];

export type SearchRedirectKind = 'category' | 'business';

export interface ISearchRule extends Document {
  /** Normalizado (sin tildes, minúsculas): por donde se busca la regla. */
  term: string;
  /** Tal cual lo escribió quien creó la regla, para leerlo en el panel. */
  termRaw: string;
  kind: SearchRuleKind;
  /** Término destino, ya normalizado. Solo con `synonym`. */
  synonymOf?: string | null;
  redirect?: {
    kind: SearchRedirectKind;
    /** Clave de `BusinessCategory`. Solo con `kind: 'category'`. */
    category?: string;
    /** Solo con `kind: 'business'`. */
    businessId?: Types.ObjectId;
  } | null;
  note?: string;
  createdBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const searchRuleSchema = new Schema<ISearchRule>(
  {
    term: { type: String, required: true, unique: true, maxlength: 100 },
    termRaw: { type: String, required: true, trim: true, maxlength: 100 },
    kind: { type: String, enum: SEARCH_RULE_KINDS, required: true },
    synonymOf: { type: String, default: null, maxlength: 100 },
    redirect: {
      type: new Schema(
        {
          kind: { type: String, enum: ['category', 'business'], required: true },
          category: { type: String },
          businessId: { type: Schema.Types.ObjectId, ref: 'Business' },
        },
        { _id: false }
      ),
      default: null,
    },
    note: { type: String, trim: true, maxlength: 200 },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

export const SearchRule = mongoose.model<ISearchRule>('SearchRule', searchRuleSchema);
