import { z } from 'zod';

/**
 * Coordenadas de un fix del GPS.
 *
 * Los rangos no son decoración: sin ellos, un `lat: 999` entra en el
 * índice `2dsphere` de MongoDB y hace fallar toda consulta geográfica
 * posterior sobre esa colección — incluida la búsqueda del repartidor más
 * cercano, que dejaría de encontrar a nadie por un dato basura de hace una
 * semana.
 */
const coordinates = {
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
};

export const pingSchema = z.object({
  body: z.object({
    ...coordinates,
    /** Radio de incertidumbre en metros. El servidor descarta los peores. */
    accuracy: z.number().min(0).max(10000).optional(),
    heading: z.number().min(0).max(360).optional(),
    /** m/s. El tope descarta lecturas absurdas del sensor (720 km/h). */
    speed: z.number().min(0).max(200).optional(),
    batteryLevel: z.number().min(0).max(100).optional(),
    /**
     * Si el sistema operativo marcó la posición como simulada.
     *
     * Se acepta y se guarda en vez de rechazarla: un repartidor con una
     * app de ubicación falsa es un caso de fraude que investiga la
     * operación, no un error de red que deba descartarse en silencio.
     * Rechazarlo aquí solo enseñaría a dejar de reportar el campo.
     */
    isMocked: z.boolean().optional(),
    recordedAt: z.coerce.date().optional(),
  }),
});

export const routeSchema = z.object({
  body: z
    .object({
      lat: coordinates.lat.optional(),
      lng: coordinates.lng.optional(),
    })
    .optional()
    .default({}),
});

export const nearestSchema = z.object({
  query: z
    .object({
      orderId: z.string().optional(),
      lat: z.coerce.number().min(-90).max(90).optional(),
      lng: z.coerce.number().min(-180).max(180).optional(),
      limit: z.coerce.number().int().min(1).max(25).optional(),
    })
    // O se pregunta por un pedido, o se pregunta por un punto. Sin esta
    // guarda, una petición sin ninguno de los dos llega al servicio con
    // `NaN` y devuelve una lista vacía sin explicar por qué.
    .refine(
      (q) => !!q.orderId || (typeof q.lat === 'number' && typeof q.lng === 'number'),
      { message: 'Indica orderId, o bien lat y lng' }
    ),
});
