import { z } from 'zod';

/**
 * Un identificador de MongoDB, comprobado antes de tocar la base.
 *
 * Vivía copiado dentro de `payment.validator.ts`. Sacarlo no es cosmética:
 * un id con forma inválida que llega hasta Mongoose provoca un `CastError`
 * —no un error de validación— y el cliente recibe un 500 genérico en vez
 * de saber qué campo mandó mal. Comprobarlo aquí convierte ese 500 en un
 * 400 que dice cuál es el campo.
 */
export const objectId = z
  .string()
  .regex(/^[a-f\d]{24}$/i, 'Identificador inválido');

/**
 * Dinero en pesos colombianos.
 *
 * Entero y no negativo: aquí no hay centavos, y un precio con decimales
 * acaba en totales que no cuadran al sumarlos.
 */
export const copAmount = z
  .number({ invalid_type_error: 'Debe ser un número' })
  .int('Debe ser un valor entero en pesos')
  .nonnegative('No puede ser negativo');
