/**
 * El mensaje que de verdad le sirve al comercio.
 *
 * La API contesta a un fallo de validación con `message: "Error de
 * validación"` y el detalle en `errors[]`. El panel mostraba solo
 * `message`, así que un comercio sin categorías que intentaba crear su
 * primer producto leía "Error de validación" en vez de "Elige una
 * categoría. Si no tienes ninguna, créala primero."
 *
 * El orden de preferencia es del más específico al más genérico, y el
 * último recurso es el texto que pase quien llama — nunca el objeto de
 * error crudo, que acaba enseñando cosas como "Request failed with status
 * code 400".
 */

/** Cuerpo de error que devuelve la API de ZIPP. */
interface ApiErrorBody {
  message?: string;
  code?: string;
  errors?: Array<string | { field?: string; message?: string } | null>;
}

/** Lo poco que estas funciones necesitan saber de un error de axios. */
interface ApiErrorShape {
  code?: string;
  response?: { status?: number; data?: ApiErrorBody };
}

/**
 * Un `catch` recibe `unknown`, que es la verdad: ahí puede llegar
 * cualquier cosa. El estrechamiento se hace **una vez, aquí**, en vez de
 * declarar `catch (err: any)` en cada pantalla — que es lo que había y lo
 * que permitía que un `err.response.data.mesage` mal escrito compilara y
 * mostrara `undefined` al usuario.
 */
function asApiError(error: unknown): ApiErrorShape {
  return typeof error === 'object' && error !== null ? (error as ApiErrorShape) : {};
}

export function apiMessage(
  error: unknown,
  fallback = 'Algo no salió bien. Inténtalo de nuevo.'
): string {
  const data = asApiError(error).response?.data;

  const detail = data?.errors?.[0];
  if (typeof detail === 'string') return detail;
  if (detail && typeof detail === 'object' && detail.message) return detail.message;

  if (data?.message && data.message !== 'Error de validación') return data.message;

  // Sin respuesta del servidor: o no hay red, o el backend no está arriba.
  // Decirlo es más útil que repetir el mensaje genérico de axios.
  if (asApiError(error).code === 'ERR_NETWORK') {
    return 'No pudimos conectar con ZIPP. Revisa tu conexión.';
  }

  return data?.message || fallback;
}

/** Etiqueta estable del error, cuando el backend la manda. */
export function apiErrorCode(error: unknown): string | null {
  return asApiError(error).response?.data?.code ?? null;
}

/** Código HTTP de la respuesta, cuando la hubo. */
export function apiStatus(error: unknown): number | null {
  return asApiError(error).response?.status ?? null;
}

/**
 * El error de un campo concreto, ya formateado como "campo: motivo".
 *
 * El backend manda los fallos de validación en `errors[]` con el `field`
 * prefijado por su ubicación (`body.code`, `body.value`). Al administrador
 * no le dice nada ese prefijo — lo que necesita saber es qué casilla del
 * formulario que tiene delante está mal.
 *
 * Devuelve `null` cuando el error no es de validación de campo, para que
 * quien llama caiga en `apiMessage`.
 */
export function apiFieldMessage(error: unknown): string | null {
  const detail = asApiError(error).response?.data?.errors?.[0];
  if (!detail || typeof detail !== 'object') return null;
  const { field, message } = detail as { field?: string; message?: string };
  if (!field || !message) return null;
  return `${field.replace(/^body\./, '')}: ${message}`;
}
