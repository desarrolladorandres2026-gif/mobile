const EARTH_RADIUS_KM = 6371;

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

export interface LatLng {
  lat: number;
  lng: number;
}

/**
 * Great-circle distance between two points, in kilometres.
 *
 * This is straight-line distance, not driving distance. It is intentional:
 * it needs no external API, is deterministic (so pricing is testable and
 * reproducible), and never fails. When GOOGLE_MAPS_API_KEY is configured a
 * routing provider can refine this, but the platform must remain able to
 * price a delivery with no connectivity.
 */
export function haversineKm(a: LatLng, b: LatLng): number {
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);

  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);

  const h =
    sinLat * sinLat +
    Math.cos(toRadians(a.lat)) * Math.cos(toRadians(b.lat)) * sinLng * sinLng;

  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Great-circle distance in whole metres.
 *
 * Pricing works in integers end to end, so distance crosses into the money
 * layer as metres rather than fractional kilometres.
 */
export function haversineMeters(a: LatLng, b: LatLng): number {
  return Math.round(haversineKm(a, b) * 1000);
}

/** True when the coordinates are usable (present, numeric, in range, not 0,0). */
export function isValidCoordinate(lat?: number | null, lng?: number | null): boolean {
  if (typeof lat !== 'number' || typeof lng !== 'number') return false;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  if (lat < -90 || lat > 90) return false;
  if (lng < -180 || lng > 180) return false;
  // Null Island is almost always a placeholder rather than a real address.
  if (lat === 0 && lng === 0) return false;
  return true;
}

/** Extracts [lng, lat] GeoJSON coordinates into a LatLng, if valid. */
export function fromGeoPoint(point?: {
  coordinates?: number[];
} | null): LatLng | null {
  const coords = point?.coordinates;
  if (!Array.isArray(coords) || coords.length < 2) return null;
  const [lng, lat] = coords;
  if (!isValidCoordinate(lat, lng)) return null;
  return { lat, lng };
}

/** Rounds a money amount to the nearest `step` (e.g. nearest 100 COP). */
export function roundToStep(amount: number, step: number): number {
  if (!step || step <= 1) return Math.round(amount);
  return Math.round(amount / step) * step;
}
