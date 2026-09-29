import api from '../services/api';

/**
 * El perfil completo del negocio, tal y como lo guarda `qk.settings`.
 *
 * Lo leen dos pantallas: Perfil, que es la dueña de la edición, y el
 * formulario del producto, que solo necesita el tipo de negocio y el
 * tiempo general para la vista previa. Comparten caché, así que tienen
 * que compartir también la función: dos `queryFn` distintas bajo la misma
 * clave acabarían guardando dos formas del mismo dato.
 */
export interface BusinessSettings {
  _id: string;
  /** Clave del tipo de negocio (`restaurant`, `fast_food`…). */
  category?: string;
  /** Minutos generales de preparación: los hereda todo plato sin tiempo propio. */
  deliveryTime?: number;
  [field: string]: unknown;
}

/** No hay endpoint de "un negocio mío": se pide la lista y se busca en ella. */
export async function fetchBusinessSettings(businessId: string): Promise<BusinessSettings> {
  const { data } = await api.get('/businesses/my/businesses');
  const found = (data.data as BusinessSettings[]).find((business) => business._id === businessId);
  if (!found) throw new Error('No tienes acceso al perfil de este negocio.');
  return found;
}
