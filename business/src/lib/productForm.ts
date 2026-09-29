import type { ExtraOption } from './catalog';
import type { GroupDraft } from './modifierGroups';

/**
 * El formulario del producto, tal y como lo escribe el comercio.
 *
 * Todo en cadenas: lo que hay en los campos, sin convertir. Pasarlo a
 * números es trabajo de `readPricing`, y es un solo sitio a propósito: el
 * indicador de avance, las recomendaciones y el guardado tienen que
 * aplicar las mismas reglas, o la barra diría "listo" a un producto que
 * el botón luego rechaza.
 */
export interface ProductFormState {
  name: string;
  description: string;
  price: string;
  discountPrice: string;
  prepTimeMinutes: string;
  requiresAgeVerification: boolean;
  categoryId: string;
  extras: ExtraOption[];
  modifierGroups: GroupDraft[];
}

export const EMPTY_PRODUCT_FORM: ProductFormState = {
  name: '',
  description: '',
  price: '',
  discountPrice: '',
  prepTimeMinutes: '',
  requiresAgeVerification: false,
  categoryId: '',
  extras: [],
  modifierGroups: [],
};

/** Tope del modelo y del validador del servidor. */
export const PREP_TIME_MAX = 180;

export type PricingField = 'price' | 'discountPrice' | 'prepTimeMinutes';

export type PricingRead =
  | { ok: true; price: number; discountPrice: number | null; prepTimeMinutes: number | null }
  | { ok: false; field: PricingField; message: string };

/** Precio, oferta y tiempo, ya convertidos y validados. */
export function readPricing(form: ProductFormState): PricingRead {
  const price = Number(form.price);
  if (!form.price.trim() || !Number.isFinite(price) || price <= 0) {
    return { ok: false, field: 'price', message: 'Escribe un precio válido.' };
  }

  // Un 0 escrito en el campo es "sin descuento", no un descuento de cero:
  // enviarlo tal cual lo rechaza el validador, que exige un positivo.
  const rawDiscount = Number(form.discountPrice);
  const discountPrice =
    form.discountPrice.trim() && Number.isFinite(rawDiscount) && rawDiscount > 0 ? rawDiscount : null;
  if (discountPrice !== null && discountPrice >= price) {
    return {
      ok: false,
      field: 'discountPrice',
      message: 'El precio de oferta tiene que ser menor que el precio regular.',
    };
  }

  // Vacío es "usa el tiempo general del negocio", no cero minutos.
  const rawPrepTime = Number(form.prepTimeMinutes);
  const prepTimeMinutes =
    form.prepTimeMinutes.trim() && Number.isFinite(rawPrepTime) && rawPrepTime > 0 ? rawPrepTime : null;
  if (prepTimeMinutes !== null && (!Number.isInteger(prepTimeMinutes) || prepTimeMinutes > PREP_TIME_MAX)) {
    return {
      ok: false,
      field: 'prepTimeMinutes',
      message: `El tiempo de preparación va de 1 a ${PREP_TIME_MAX} minutos, sin decimales.`,
    };
  }

  return { ok: true, price, discountPrice, prepTimeMinutes };
}

/** El servidor exige al menos dos caracteres. */
export const hasValidName = (form: ProductFormState): boolean => form.name.trim().length >= 2;

/**
 * Descuento en porcentaje, redondeado hacia abajo como en la app.
 * `null` si no hay oferta válida.
 */
export function rawDiscountPercent(price: number, discountPrice: number | null): number | null {
  if (!discountPrice || discountPrice >= price || price <= 0) return null;
  return Math.floor(((price - discountPrice) / price) * 100);
}

/**
 * La etiqueta "−X%" que la app pinta sobre la foto.
 *
 * Copia de `discountPercent` en mobile/lib/catalog.ts: por debajo del 5 %
 * la app no la muestra, y la vista previa no puede enseñar algo que el
 * cliente nunca verá.
 */
export function discountPercent(price: number, discountPrice: number | null): number | null {
  const percent = rawDiscountPercent(price, discountPrice);
  return percent !== null && percent >= 5 ? percent : null;
}

export interface ProductProgress {
  /** Cada tramo de la barra: foto y datos principales, precio, revisión. */
  steps: [boolean, boolean, boolean];
  /** El primer paso sin completar; 3 cuando ya solo queda revisar y guardar. */
  current: 1 | 2 | 3;
}

/**
 * Cuánto le falta al producto, para la barra de tres tramos.
 *
 * Es un indicador y no un asistente: el formulario entero sigue a la
 * vista y crear sin foto está permitido. La foto cuenta para el primer
 * paso porque un producto sin ella se ve incompleto en la carta, y la
 * barra existe para empujar a completarlo.
 */
export function productProgress(form: ProductFormState, hasPhoto: boolean): ProductProgress {
  const basics = hasPhoto && hasValidName(form) && Boolean(form.categoryId);
  const pricing = readPricing(form).ok;
  return {
    steps: [basics, pricing, basics && pricing],
    current: !basics ? 1 : !pricing ? 2 : 3,
  };
}

export interface ChecklistItem {
  label: string;
  done: boolean;
}

/** La lista de "Resumen rápido". Lo que ya está y lo que falta, sin juicio. */
export function productChecklist(form: ProductFormState, hasPhoto: boolean): ChecklistItem[] {
  return [
    { label: 'Foto principal', done: hasPhoto },
    {
      label: 'Datos esenciales',
      done: hasValidName(form) && Boolean(form.categoryId) && readPricing(form).ok,
    },
    { label: 'Descripción', done: form.description.trim().length > 0 },
  ];
}

/**
 * ¿Hay algo escrito que merezca guardarse como borrador?
 *
 * La categoría no cuenta: viene elegida de antemano, así que un
 * formulario recién abierto la trae y sigue estando vacío.
 */
export function hasDraftContent(form: ProductFormState): boolean {
  return Boolean(
    form.name.trim() ||
      form.description.trim() ||
      form.price.trim() ||
      form.discountPrice.trim() ||
      form.prepTimeMinutes.trim() ||
      form.requiresAgeVerification ||
      form.extras.length ||
      form.modifierGroups.length
  );
}
