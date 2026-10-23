/**
 * Destino al que volver tras iniciar sesión (`?volver=/pedido`).
 *
 * Solo rutas internas: debe empezar por una sola barra y no por `//` ni
 * `/\`, que los navegadores tratan como un dominio externo. Sin esto, un
 * enlace `?volver=//sitio-malo.com` convertiría el login en una redirección
 * abierta.
 */
/** Tabulaciones y saltos: el parser de URL los quita y `/\t/evil.com` se convertiría en `//evil.com`. */
function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i++) if (value.charCodeAt(i) < 32) return true;
  return false;
}

export function safeNext(value: string | null | undefined, fallback = '/'): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\') || hasControlChars(value)) return fallback;
  return value;
}
