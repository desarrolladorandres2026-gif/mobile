/**
 * Compara `1.2.10` con `1.10.0` sin que gane el orden alfabético.
 *
 * Vive aparte de `VersionGate` a propósito: es una comparación de texto pura
 * y el componente la reexporta. Meterla en el componente hacía que probarla
 * arrastrara toda la UI (Reanimated incluido) solo para verificar una
 * función que no toca React en absoluto.
 */
export function isOlder(current: string, minimum: string): boolean {
  const a = current.split('.').map((n) => parseInt(n, 10) || 0);
  const b = minimum.split('.').map((n) => parseInt(n, 10) || 0);

  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) return left < right;
  }
  return false;
}
