const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Ejecuta `fn(session)` dentro de una transacción de MongoDB con lectura `snapshot` y escritura
 * `majority`. El controlador repite la función completa si la transacción choca con otra
 * (error transitorio), así que `fn` no debe tener efectos fuera de la base de datos.
 */
export async function withTransaction(client, fn) {
  const session = client.startSession();
  try {
    let result;
    let attempt = 0;
    await session.withTransaction(
      async () => {
        // Los reintentos por choque con otra transacción no esperan nada por sí solos: sin pausa, varios
        // escritores se reintentan a la vez y vuelven a chocar. Una espera aleatoria creciente los desfasa.
        if (attempt > 0) await sleep(Math.random() * Math.min(50, 4 * 2 ** attempt));
        attempt += 1;
        result = await fn(session);
      },
      { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } },
    );
    return result;
  } finally {
    await session.endSession();
  }
}

export const DUPLICATE_KEY = 11000;

/** `true` si el error es una clave duplicada del índice con ese nombre. */
export function isDuplicate(err, indexName) {
  return err?.code === DUPLICATE_KEY && String(err.message ?? '').includes(indexName);
}
