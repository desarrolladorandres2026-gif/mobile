import { z } from 'zod';
import { objectId } from './common';

/**
 * Alta y edición de productos del catálogo.
 *
 * Estos esquemas existían pero **no estaban conectados a las rutas**, así
 * que el cuerpo de la petición llegaba tal cual a Mongoose. Eso producía
 * dos cosas malas a la vez: un `categoryId` vacío —lo que manda el panel
 * cuando el comercio todavía no ha creado ninguna categoría— reventaba en
 * un `CastError` que el cliente veía como "Error interno del servidor", y
 * cualquier campo de más se guardaba sin preguntar.
 *
 * `.strict()` no está: zod descarta por defecto las claves que no
 * reconoce, que es justo el comportamiento que se quiere en un panel que
 * puede mandar campos de la interfaz. Lo que no se declara aquí, no llega
 * a la base.
 */

/** Tope real del modelo. Estaba en 500 aquí y en 300 en el esquema. */
const DESCRIPTION_MAX = 300;

const price = z
  .number({
    required_error: 'El precio es requerido',
    invalid_type_error: 'El precio debe ser un número',
  })
  .positive('El precio debe ser positivo');

const extras = z
  .array(
    z.object({
      name: z.string().min(1, 'El adicional necesita un nombre').max(60),
      price: z.number({ invalid_type_error: 'El precio del adicional debe ser un número' }).min(0),
    })
  )
  .max(30, 'Demasiados adicionales para un solo producto');

/**
 * La categoría del producto, con dos mensajes distintos a propósito.
 *
 * El panel manda una cadena vacía cuando el comercio todavía no tiene
 * ninguna categoría —el desplegable no tiene opciones que elegir—, y ese
 * es el caso que más se da al estrenar el negocio. Decirle "identificador
 * inválido" no le dice qué hacer; decirle que cree una categoría, sí.
 */
const categoryIdField = z
  .string({ required_error: 'Elige una categoría. Si no tienes ninguna, créala primero.' })
  .min(1, 'Elige una categoría. Si no tienes ninguna, créala primero.')
  .regex(/^[a-f\d]{24}$/i, 'La categoría seleccionada no es válida');

export const createProductSchema = z.object({
  body: z.object({
    businessId: objectId,
    categoryId: categoryIdField,
    name: z.string().trim().min(2, 'Nombre mínimo 2 caracteres').max(100),
    description: z.string().max(DESCRIPTION_MAX).optional(),
    price,
    discountPrice: z.number().positive().nullable().optional(),
    extras: extras.optional(),
    isAvailable: z.boolean().optional(),
    /** Destaca el producto dentro del propio menú, no en la plataforma. */
    isFeatured: z.boolean().optional(),
  }),
});

export const updateProductSchema = z.object({
  params: z.object({ id: objectId }),
  body: z.object({
    businessId: objectId,
    // Faltaban en el esquema original. No es un detalle: el panel manda
    // los adicionales y la categoría al guardar, así que en cuanto la
    // validación se conectara, editarlos habría dejado de funcionar en
    // silencio.
    categoryId: objectId.optional(),
    name: z.string().trim().min(2).max(100).optional(),
    description: z.string().max(DESCRIPTION_MAX).optional(),
    price: price.optional(),
    discountPrice: z.number().positive().nullable().optional(),
    extras: extras.optional(),
    isAvailable: z.boolean().optional(),
    isFeatured: z.boolean().optional(),
  }),
});

/**
 * Borrado y subida de imagen: el `businessId` viaja en el cuerpo y es lo
 * único que hay que comprobar antes de resolver la propiedad.
 */
export const productOwnerBodySchema = z.object({
  params: z.object({ id: objectId }),
  body: z.object({ businessId: objectId }),
});
