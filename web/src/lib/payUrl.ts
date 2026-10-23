/**
 * Solo se redirige a pagar hacia el dominio de Wompi. La URL la devuelve el
 * servidor, pero mandar a la persona a un destino arbitrario con su sesión
 * abierta es justo lo que una redirección abierta permitiría.
 */
export function isWompiUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && (url.hostname === 'wompi.co' || url.hostname.endsWith('.wompi.co'));
  } catch {
    return false;
  }
}
