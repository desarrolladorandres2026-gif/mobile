/**
 * Texto preparado para comparar, gemelo del de `backend/src/utils/text.ts`.
 *
 * Vive duplicado a propósito: el servidor lo necesita para guardar el campo
 * indexado y la app para filtrar la carta de un negocio sin pedir nada a la
 * red. Compartirlo obligaría a un paquete común para nueve líneas.
 *
 * La regla que importa es la misma en los dos lados: en el teclado de un
 * móvil casi nadie escribe las tildes, así que buscar "cafe" tiene que
 * encontrar "Café".
 */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Si `haystack` contiene `needle`, sin que estorben tildes ni mayúsculas. */
export function matches(haystack: string | undefined | null, needle: string): boolean {
  if (!haystack) return false;
  return normalize(haystack).includes(needle);
}
