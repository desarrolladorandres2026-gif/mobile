/**
 * Texto preparado para buscar.
 *
 * El índice de texto de Mongo ya ignora las tildes, pero el respaldo por
 * prefijo usa `$regex`, que compara caracteres crudos: "cafe" no encuentra
 * "Café". Y una `collation` insensible tampoco lo arregla, porque `$regex`
 * no puede apoyarse en una. La salida es guardar el nombre ya normalizado
 * y comparar contra eso.
 *
 * No es un caso de borde: en el teclado de un móvil casi nadie escribe las
 * tildes, así que el término sin acentos es el normal, no la excepción.
 */

/**
 * Escapa un término para usarlo dentro de un `$regex` de Mongo sin que sus
 * caracteres se interpreten como sintaxis de expresión regular.
 *
 * Varios listados (`admin.service.ts`, `business.service.ts`, cupones,
 * publicidad, banners de promoción) construían `{ $regex: search }`
 * directamente con lo que escribiera el usuario. Un patrón malicioso tipo
 * `(a+)+$` no permite inyectar datos ajenos —Mongo no ejecuta código—, pero
 * sí puede volver catastróficamente lento el motor de regex del proceso
 * (ReDoS) con una entrada corta. Escapar dos caracteres de más (como una
 * tilde) nunca cambia el resultado de una búsqueda; no escapar uno de menos
 * sí puede tumbar el servidor.
 */
export function escapeRegex(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Longitud mínima de una palabra para que valga la pena indexarla. */
const MIN_TOKEN = 3;

/** Minúsculas, sin tildes y sin espacios de más. */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Las palabras de un texto, ya normalizadas.
 *
 * Se descartan las de una y dos letras: "de", "la", "y" no distinguen nada
 * y solo engordarían el diccionario de corrección, donde cada entrada se
 * compara contra lo que el usuario escribió.
 */
export function tokenize(text: string): string[] {
  return normalize(text)
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= MIN_TOKEN);
}

/**
 * Distancia de edición entre dos palabras, con abandono temprano.
 *
 * Es la base de "quizás quisiste decir": cuenta cuántas letras habría que
 * cambiar, meter o quitar para pasar de una a otra.
 *
 * `max` no es cosmético. Esta función se llama una vez por cada palabra del
 * diccionario, así que sin un tope la corrección de un término costaría
 * varios miles de matrices completas. Cuando el resultado va a superar el
 * máximo tolerado devuelve `max + 1` y corta: al que pregunta solo le
 * interesa si cabe dentro del umbral, no cuánto se pasa.
 */
export function editDistance(a: string, b: string, max = Infinity): number {
  if (a === b) return 0;

  // Dos palabras de longitudes muy distintas no pueden acercarse: cada
  // letra sobrante ya es una edición por sí sola.
  if (Math.abs(a.length - b.length) > max) return max + 1;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  let current = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    let rowMin = current[0];

    for (let j = 1; j <= b.length; j++) {
      const substitution = previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, substitution);
      if (current[j] < rowMin) rowMin = current[j];
    }

    // Ninguna fila posterior puede mejorar la mejor casilla de esta, así que
    // si ya se pasó del tope, seguir calculando no cambia la respuesta.
    if (rowMin > max) return max + 1;

    [previous, current] = [current, previous];
  }

  return previous[b.length];
}
