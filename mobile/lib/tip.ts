/**
 * La propina al domiciliario: montos, límites y lectura de lo que viaja por
 * la URL entre pantallas.
 *
 * Son pesos fijos y no un porcentaje: el 10 % de un domicilio de $8.000 son
 * $800, que casi no se nota, mientras que a quien reparte le cuesta lo mismo
 * llevar un pedido barato que uno caro. Los mismos montos sirven antes de
 * pedir y después de la entrega.
 */

export const TIP_PRESETS = [1000, 2000, 3000, 5000] as const;

/**
 * Rojo de Rappi. Es el color propio de las pantallas de propina, a pedido
 * del dueño del producto: el resto de la app conserva su paleta. Igual en
 * claro y oscuro, como el resto de colores de marca literales.
 */
export const TIP_ACCENT = '#FF441F';

/** Por debajo de esto no vale el cobro (y el valor libre suele ser un error). */
export const TIP_MIN = 500;

/** Evita el cero de más al teclear. Lo repite el servidor: esto no es la barrera. */
export const TIP_MAX = 20000;

/** Un monto de propina que el servidor aceptaría, o `null` si no lo es. */
export function validTip(amount: number | null | undefined): number | null {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return null;
  const rounded = Math.round(amount);
  return rounded >= TIP_MIN && rounded <= TIP_MAX ? rounded : null;
}

/** Por qué un valor tecleado no sirve, o `undefined` si sirve o está vacío. */
export function tipInputError(digits: string): string | undefined {
  if (!digits) return undefined;
  const amount = Number(digits);
  if (amount < TIP_MIN) return `El mínimo es $${TIP_MIN.toLocaleString('es-CO')}`;
  if (amount > TIP_MAX) return `El máximo es $${TIP_MAX.toLocaleString('es-CO')}`;
  return undefined;
}

/**
 * La propina que llegó por parámetro de ruta. Un valor ilegible o fuera de
 * rango es "sin propina": es la URL, y cualquiera puede escribir cualquier
 * cosa en ella — lo que el servidor cobra lo decide él, no este número.
 */
export function tipFromParam(raw: string | string[] | undefined): number {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value || !/^\d+$/.test(value)) return 0;
  return validTip(Number(value)) ?? 0;
}
