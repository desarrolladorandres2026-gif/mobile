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

/**
 * Texto que se está escribiendo en el buscador de direcciones.
 *
 * El mínimo de tres caracteres no es cosmético: con uno o dos, Mapbox
 * devuelve el callejero entero de Colombia ordenado por azar, y cada
 * pulsación se cobra igual que una búsqueda útil. Por debajo de tres
 * letras no hay nada que buscar todavía, solo cuota que gastar.
 *
 * `lat`/`lng` sesgan los resultados hacia donde está el usuario. Van
 * juntos o no van: media coordenada no sesga nada, y aceptarla en
 * silencio escondería un error del cliente detrás de resultados
 * inexplicablemente lejanos.
 */
export const searchPlacesSchema = z.object({
  body: z.object({}).optional(),
  query: z
    .object({
      q: z.string().trim().min(3, 'Escribe al menos 3 letras').max(120),
      lat: z.coerce.number().min(-90).max(90).optional(),
      lng: z.coerce.number().min(-180).max(180).optional(),
    })
    .refine((v) => (v.lat === undefined) === (v.lng === undefined), {
      message: 'lat y lng deben ir juntos',
    }),
  params: z.object({}).optional(),
});

/**
 * Cambios sobre una dirección existente.
 *
 * Todo es opcional porque corregir el piso no debería obligar a reenviar
 * la calle, el punto y el nombre. Lo que no está declarado —`isDefault`,
 * `userId`— se descarta: el middleware sustituye el cuerpo por lo que
 * valida el esquema, así que un cliente no puede colar por aquí campos
 * que el servicio no espera. Marcar la principal tiene su propia ruta.
 *
 * `params` declara `id` explícitamente. Omitirlo no lo dejaría intacto:
 * el middleware reemplaza `req.params` por lo validado, y un esquema
 * vacío borraría el identificador de la ruta.
 */
export const updateAddressSchema = z.object({
  body: z.object({
    label: z.string().trim().min(1).max(40).optional(),
    address: z.string().trim().min(1).max(200).optional(),
    apartment: z.string().trim().max(60).optional(),
    neighborhood: z.string().trim().max(80).optional(),
    city: z.string().trim().max(80).optional(),
    details: z.string().trim().max(300).optional(),
    latitude: z.coerce.number().min(-90).max(90).optional(),
    longitude: z.coerce.number().min(-180).max(180).optional(),
  }),
  query: z.object({}).optional(),
  params: z.object({ id: z.string() }),
});
