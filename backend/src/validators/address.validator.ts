import { z } from 'zod';

/**
 * Punto del mapa cuya dirección se quiere conocer.
 *
 * Llega por query, así que todo entra como texto y hay que convertirlo:
 * `z.coerce.number()` es lo que separa el número 2.1958 de la cadena
 * "2.1958", que Mapbox rechazaría.
 *
 * Los rangos son los mismos que los del ping del repartidor, y por el
 * mismo motivo: una coordenada imposible no es un error del usuario, es
 * una petición construida a mano, y no tiene por qué llegar a gastar una
 * llamada de pago a Mapbox para que la rechace él.
 */
export const reverseGeocodeSchema = z.object({
  query: z.object({
    lat: z.coerce.number().min(-90).max(90),
    lng: z.coerce.number().min(-180).max(180),
  }),
});
