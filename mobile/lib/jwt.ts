/**
 * Cuándo vence un JWT, en milisegundos desde epoch, o `null` si no se puede
 * leer.
 *
 * Solo lee el `exp` del payload; **no** verifica la firma. No hace falta:
 * lo único que se decide con esto es si conviene refrescar antes de usar el
 * token, y un token manipulado lo rechazaría el servidor igual.
 */
export function tokenExpiresAt(token: string | null | undefined): number | null {
  if (!token) return null;
  try {
    const payload = token.split('.')[1];
    if (!payload) return null;
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const { exp } = JSON.parse(atob(padded)) as { exp?: unknown };
    return typeof exp === 'number' ? exp * 1000 : null;
  } catch {
    return null;
  }
}
