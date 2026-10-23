import { API_URL } from './config';
import type { ModifierGroup } from './modifiers';

export interface LegalDocument {
  _id: string;
  kind: string;
  version: string;
  title: string;
  content: string;
  effectiveAt: string;
}

export async function getLegalDocuments(): Promise<LegalDocument[]> {
  const res = await fetch(`${API_URL}/legal/documents`);
  if (!res.ok) throw new Error('No se pudieron cargar los documentos legales');
  const body = await res.json();
  return body.data as LegalDocument[];
}

/**
 * Ficha pública de un negocio: lo que se ve al abrir el enlace del botón
 * "Compartir" de la app. Ver `GET /businesses/slug/:slug/share` en el
 * backend — es un proyecto de campos aparte, sin comisión ni datos internos,
 * porque quien la pide puede ser cualquiera en internet.
 */
export interface SharedBusiness {
  _id: string;
  name: string;
  slug: string;
  description?: string;
  logo?: string | null;
  coverImage?: string | null;
  brandColor?: string | null;
  category: string;
  address: string;
  phone: string;
  rating: number;
  totalReviews: number;
  deliveryTime: number;
  minOrder: number;
  freeDeliveryThreshold: number;
  showPromoBanner: boolean;
  isActive: boolean;
  location?: { coordinates: [number, number] };
}

/** `null` cuando el negocio no existe o nunca se aprobó — nunca lanza por eso. */
export async function getSharedBusiness(slug: string): Promise<SharedBusiness | null> {
  const res = await fetch(`${API_URL}/businesses/slug/${encodeURIComponent(slug)}/share`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('No se pudo cargar este negocio');
  const body = await res.json();
  return body.data as SharedBusiness;
}

/** Un día del horario semanal, en hora de Colombia. */
export interface DaySchedule { open: string; close: string; isOpen: boolean }
export type WeekSchedule = Record<
  'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday',
  DaySchedule
>;

/** Fila del listado público: lo mismo que la ficha, sin el piso del domicilio. */
export interface BusinessListItem {
  _id: string;
  name: string;
  slug: string;
  logo?: string | null;
  category: string;
  rating: number;
  totalReviews: number;
  deliveryTime: number;
  minOrder: number;
  freeDeliveryThreshold: number;
  showPromoBanner: boolean;
  schedule?: WeekSchedule;
  city: string;
  isFeatured?: boolean;
}

/** Ficha completa, con `deliveryFeeFrom`: el "Desde $X" del domicilio (puede faltar). */
export interface BusinessDetail extends BusinessListItem {
  description?: string;
  coverImage?: string | null;
  address: string;
  phone: string;
  deliveryFeeFrom?: number | null;
}

export interface MenuCategory { _id: string; name: string; sortOrder: number }

export interface MenuProduct {
  _id: string;
  categoryId: string;
  name: string;
  description?: string;
  image?: string | null;
  price: number;
  discountPrice?: number | null;
  isAvailable?: boolean;
  /** Grupos de opciones (tipo de carne, salsas…). Cada uno trae su mínimo y máximo. */
  modifierGroups?: ModifierGroup[];
  requiresAgeVerification?: boolean;
}

export interface Storefront {
  business: BusinessDetail;
  categories: MenuCategory[];
  products: MenuProduct[];
}

export const DEFAULT_CITY = 'Garzón';

export async function listBusinesses(params: { category?: string; search?: string; city?: string }): Promise<BusinessListItem[]> {
  const query = new URLSearchParams({ city: params.city ?? DEFAULT_CITY, limit: '50' });
  if (params.category) query.set('category', params.category);
  if (params.search) query.set('search', params.search);
  const res = await fetch(`${API_URL}/businesses?${query}`);
  if (!res.ok) throw new Error('No se pudieron cargar los comercios');
  const body = await res.json();
  return (body.data ?? []) as BusinessListItem[];
}

/** `null` si el negocio no existe o no está aprobado. */
export async function getStorefrontBySlug(slug: string): Promise<Storefront | null> {
  const bySlug = await fetch(`${API_URL}/businesses/slug/${encodeURIComponent(slug)}`);
  if (bySlug.status === 404) return null;
  if (!bySlug.ok) throw new Error('No se pudo cargar este comercio');
  const business = (await bySlug.json()).data as BusinessDetail;

  const res = await fetch(`${API_URL}/businesses/${business._id}/storefront`);
  if (!res.ok) throw new Error('No se pudo cargar la carta de este comercio');
  const data = (await res.json()).data as Storefront;
  return { ...data, business: { ...business, ...data.business } };
}
