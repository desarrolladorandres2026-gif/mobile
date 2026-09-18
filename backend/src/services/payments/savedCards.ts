import { Types } from 'mongoose';
import { SavedCard, ISavedCard, toPublicCard } from '../../models';
import { AppError } from '../../middlewares';
import { PaymentProvider } from './provider';

/**
 * Tarjetas guardadas: el "pagar con un toque" del segundo pedido.
 *
 * Funciones sueltas y no métodos de `PaymentService` para no crear un ciclo
 * de imports con el registro de proveedores: quien necesita la pasarela la
 * recibe como argumento.
 */

/** Lo que la tokenización devolvió al dispositivo para pintar la tarjeta. */
export interface CardDisplay {
  brand: string;
  lastFour: string;
  expMonth: string;
  expYear: string;
}

export async function listSavedCards(userId: string) {
  const cards = await SavedCard.find({ userId }).sort({ lastUsedAt: -1 }).limit(10);
  return cards.map(toPublicCard);
}

/**
 * Crea la fuente de pago en la pasarela y la recuerda para este usuario.
 *
 * Los datos de `display` los manda la app, que los recibió de Wompi al
 * tokenizar. Son cosméticos —solo se le muestran de vuelta a la misma
 * persona— y el esquema ya los acotó por forma; ninguno sirve para cobrar.
 */
export async function saveCardFromToken(
  provider: PaymentProvider,
  input: {
    userId: string;
    token: string;
    display: CardDisplay;
    customerEmail: string;
    acceptanceToken: string;
    personalDataAuthToken?: string;
  }
): Promise<ISavedCard> {
  if (!provider.createPaymentSource) {
    throw new AppError(`El proveedor de pagos "${provider.name}" no permite guardar tarjetas`, 501);
  }

  // Guardar una tarjeta es tratar datos personales, y Wompi lo exige con su
  // propio consentimiento. Sin él no se guarda, en vez de guardar sin él.
  if (!input.personalDataAuthToken) {
    throw new AppError(
      'Para guardar la tarjeta tienes que aceptar el tratamiento de datos personales',
      400,
      'PERSONAL_DATA_AUTH_REQUIRED'
    );
  }

  let source: { id: number };
  try {
    source = await provider.createPaymentSource({
      token: input.token,
      customerEmail: input.customerEmail,
      acceptanceToken: input.acceptanceToken,
      personalDataAuthToken: input.personalDataAuthToken,
    });
  } catch (error) {
    throw new AppError(
      ((error as Error).message || 'No pudimos guardar la tarjeta').slice(0, 300),
      502,
      'GATEWAY_REJECTED'
    );
  }

  // Upsert por (usuario, proveedor, fuente): la misma tarjeta guardada dos
  // veces es la misma fila, con la fecha de uso al día.
  const card = await SavedCard.findOneAndUpdate(
    { userId: input.userId, provider: provider.name, gatewaySourceId: source.id },
    {
      $set: { ...input.display, lastUsedAt: new Date() },
      $setOnInsert: { userId: input.userId, provider: provider.name, gatewaySourceId: source.id },
    },
    { upsert: true, new: true, runValidators: true }
  );

  return card!;
}

/**
 * La tarjeta guardada `savedCardId`, **solo si es de `userId`** y la emitió
 * el proveedor activo.
 *
 * Ajena e inexistente responden igual: un 403 confirmaría que ese id existe
 * y es de otra persona.
 */
export async function resolveSavedCard(
  provider: PaymentProvider,
  userId: string,
  savedCardId: string
): Promise<ISavedCard> {
  const notFound = new AppError('Tarjeta no encontrada', 404, 'SAVED_CARD_NOT_FOUND');
  if (!Types.ObjectId.isValid(savedCardId)) throw notFound;

  const card = await SavedCard.findOne({ _id: savedCardId, userId, provider: provider.name });
  if (!card) throw notFound;

  return card;
}

export async function touchSavedCard(cardId: string): Promise<void> {
  await SavedCard.updateOne({ _id: cardId }, { $set: { lastUsedAt: new Date() } });
}

/**
 * Olvida la tarjeta. Con eso basta para que no pueda volver a usarse desde
 * Zipp: la app no conoce el id de la fuente en Wompi, así que sin esta fila
 * no hay camino hasta ella.
 */
export async function deleteSavedCard(userId: string, cardId: string): Promise<void> {
  if (!Types.ObjectId.isValid(cardId)) {
    throw new AppError('Tarjeta no encontrada', 404, 'SAVED_CARD_NOT_FOUND');
  }
  const result = await SavedCard.deleteOne({ _id: cardId, userId });
  if (!result.deletedCount) {
    throw new AppError('Tarjeta no encontrada', 404, 'SAVED_CARD_NOT_FOUND');
  }
}
