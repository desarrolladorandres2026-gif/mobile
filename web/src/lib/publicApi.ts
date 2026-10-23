import { api } from './http';

/** Ciudades donde ZIPP tiene al menos una zona de cobertura activa. */
export async function listCities(): Promise<string[]> {
  const zones = await api<{ city?: string }[]>('/zones');
  const cities = new Set<string>();
  for (const z of zones ?? []) if (z.city) cities.add(z.city);
  return [...cities].sort((a, b) => a.localeCompare(b, 'es'));
}

export type ContactType = 'question' | 'complaint' | 'claim' | 'suggestion' | 'other';

export interface ContactInput {
  name: string;
  contact: string;
  type: ContactType;
  subject?: string;
  detail: string;
  website?: string;
}

export function sendContact(input: ContactInput): Promise<{ message?: string } | undefined> {
  return api('/contact', { method: 'POST', body: input });
}

export function requestDeletionOtp(phone: string): Promise<unknown> {
  return api('/legal/deletion-request/send-otp', { method: 'POST', body: { phone } });
}

export function confirmDeletion(input: { phone: string; otp: string; reason?: string }): Promise<unknown> {
  return api('/legal/deletion-request/confirm', { method: 'POST', body: input });
}

export type PartnerType = 'business' | 'driver';

export interface PartnerInput {
  type: PartnerType;
  name: string;
  phone: string;
  otp: string;
  email?: string;
  city: string;
  businessName?: string;
  category?: string;
  address?: string;
  vehicleType?: 'moto' | 'bicicleta' | 'carro' | 'a_pie';
  experience?: string;
  notes?: string;
  website?: string;
}

export function requestPartnerOtp(phone: string): Promise<unknown> {
  return api('/partners/send-otp', { method: 'POST', body: { phone } });
}

export function submitPartnerApplication(input: PartnerInput): Promise<unknown> {
  return api('/partners/applications', { method: 'POST', body: input });
}
