const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000/api/v1';

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
