import { EMPTY_PRODUCT_FORM, hasDraftContent, type ProductFormState } from './productForm';
import type { GroupDraft } from './modifierGroups';

/**
 * Borrador del producto nuevo, guardado en este navegador.
 *
 * Solo el alta. Editar un producto existente no se autoguarda: en el
 * servidor sería publicar a medias —un precio a medio escribir saldría a
 * la carta— y en local mezclaría dos versiones del mismo producto.
 *
 * La foto no entra: un Blob no cabe en localStorage, y guardarlo en
 * IndexedDB para recuperar un recorte que se rehace en diez segundos no
 * compensa. El resumen lo dice ("sin la foto") para que nadie lo descubra
 * al volver.
 *
 * localStorage puede fallar —ventana privada, cuota llena, bloqueado por
 * política—: cada acceso va envuelto y un fallo equivale a "no hay
 * borrador", nunca a un formulario roto.
 */

const VERSION = 1;

const storageKey = (businessId: string) => `zipp:product-draft:${businessId}`;

export interface ProductDraft {
  form: ProductFormState;
  /** Último guardado, en milisegundos desde epoch. */
  savedAt: number;
}

export function loadDraft(businessId: string): ProductDraft | null {
  try {
    const raw = localStorage.getItem(storageKey(businessId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { v?: unknown; savedAt?: unknown; form?: unknown };
    if (parsed.v !== VERSION || typeof parsed.savedAt !== 'number' || !parsed.form) return null;
    return { savedAt: parsed.savedAt, form: sanitize(parsed.form as Record<string, unknown>) };
  } catch {
    return null;
  }
}

/** Devuelve la hora del guardado, o `null` si el navegador no dejó guardar. */
export function saveDraft(businessId: string, form: ProductFormState, now = Date.now()): number | null {
  try {
    localStorage.setItem(storageKey(businessId), JSON.stringify({ v: VERSION, savedAt: now, form }));
    return now;
  } catch {
    return null;
  }
}

export function clearDraft(businessId: string): void {
  try {
    localStorage.removeItem(storageKey(businessId));
  } catch {
    // Sin almacenamiento no hay nada que borrar.
  }
}

/**
 * ¿Se le ofrece este borrador al abrir "Nuevo producto"?
 *
 * TODO(usuario): decidir cuánto vive un borrador. Hoy se recupera siempre
 * que tenga algo escrito, sin importar la edad. Lo que está en juego:
 * · Sin caducidad, un producto que el comercio abandonó hace un mes
 *   reaparece al crear uno nuevo y hay que pulsar "Empezar de cero".
 * · Con una caducidad corta (horas), el que cerró la pestaña a media
 *   carga y vuelve al día siguiente lo pierde todo.
 * `now` y `draft.savedAt` están en milisegundos.
 */
export function isDraftWorthRestoring(draft: ProductDraft, now: number): boolean {
  void now;
  return hasDraftContent(draft.form);
}

/**
 * Campo a campo sobre el formulario vacío.
 *
 * Lo guardó este mismo panel, pero puede venir de una versión anterior
 * del formulario: ninguna clave desconocida entra y ningún campo queda en
 * `undefined`, que convertiría un input controlado en uno libre.
 */
function sanitize(raw: Record<string, unknown>): ProductFormState {
  const text = (value: unknown) => (typeof value === 'string' ? value : '');
  const extras = Array.isArray(raw.extras)
    ? raw.extras.filter(
        (extra): extra is { name: string; price: number } =>
          typeof extra?.name === 'string' && typeof extra?.price === 'number'
      )
    : [];
  const modifierGroups = Array.isArray(raw.modifierGroups)
    ? (raw.modifierGroups as GroupDraft[]).filter(
        (group) => typeof group?.name === 'string' && Array.isArray(group?.options)
      )
    : [];

  return {
    ...EMPTY_PRODUCT_FORM,
    name: text(raw.name),
    description: text(raw.description),
    price: text(raw.price),
    discountPrice: text(raw.discountPrice),
    prepTimeMinutes: text(raw.prepTimeMinutes),
    requiresAgeVerification: raw.requiresAgeVerification === true,
    categoryId: text(raw.categoryId),
    extras: extras.map(({ name, price }) => ({ name, price })),
    modifierGroups,
  };
}
