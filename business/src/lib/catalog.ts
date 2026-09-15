import type { ApiModifierGroup } from './modifierGroups';
import type { ProductImages } from '../components/SmartImage';

/**
 * El producto del catálogo, tal y como lo devuelve la API.
 *
 * Estaba declarado dentro de `pages/Menu.tsx`, así que el campo de imagen
 * —que vive en otro componente y recibe el producto ya guardado de vuelta
 * del servidor— no podía usarlo y lo escribía como `any`. El resultado
 * era que el callback que refresca la fila del menú no comprobaba nada:
 * bastaba con que el backend renombrara un campo para que la tarjeta se
 * quedara con los datos viejos y en silencio.
 */
export interface ExtraOption {
  name: string;
  price: number;
}

export interface Product {
  _id: string;
  name: string;
  description?: string;
  price: number;
  discountPrice?: number;
  /** Minutos de cocina propios. `null`/`undefined` hereda el del negocio. */
  prepTimeMinutes?: number | null;
  isAvailable: boolean;
  categoryId: string;
  extras?: ExtraOption[];
  /** Grupos con reglas (mínimo, máximo). Ver `lib/modifierGroups.ts`. */
  modifierGroups?: ApiModifierGroup[];
  /** Variantes ya calculadas por el servidor. Nulo si no tiene foto. */
  images?: ProductImages | null;
  /** Variantes de las fotos adicionales. La principal no está aquí. */
  galleryImages?: ProductImages[] | null;
  /** Identificadores de las fotos adicionales, para poder borrarlas. */
  gallery?: Array<{ publicId: string }> | null;
  /**
   * Unidades restantes. `null` significa que el negocio no lleva cuenta,
   * que no es lo mismo que cero: cero es "se acabó".
   */
  stock?: number | null;
  lowStockThreshold?: number;
}
