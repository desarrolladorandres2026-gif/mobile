import { useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import { DEFAULT_CITY } from './api';
import { listCities } from './publicApi';

const STORAGE_KEY = 'zipp_city';
const listeners = new Set<() => void>();

function read(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

let chosen: string | null = read();

export function setCity(city: string): void {
  chosen = city;
  try {
    localStorage.setItem(STORAGE_KEY, city);
  } catch {
    // Sin almacenamiento: la elección vale mientras la pestaña esté abierta.
  }
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Ciudades con cobertura activa (las que tienen al menos una zona) y la que
 * está elegida. Si la elegida ya no tiene cobertura, o nunca se eligió, se usa
 * la ciudad por defecto cuando existe y, si no, la primera con cobertura.
 */
export function useCity(): { city: string; cities: string[] } {
  const stored = useSyncExternalStore(subscribe, () => chosen, () => null);
  const { data } = useQuery({ queryKey: ['cities'], queryFn: listCities, staleTime: 10 * 60_000, retry: false });
  const cities = data ?? [];

  if (stored && (cities.length === 0 || cities.includes(stored))) return { city: stored, cities };
  if (cities.length === 0 || cities.includes(DEFAULT_CITY)) return { city: DEFAULT_CITY, cities };
  return { city: cities[0], cities };
}
