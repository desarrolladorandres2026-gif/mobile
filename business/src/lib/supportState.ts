/**
 * Cuándo un caso de soporte está esperando al comercio.
 *
 * Una sola regla para la lista, el punto del menú lateral y el hilo: si cada
 * uno la escribiera por su cuenta, el punto del menú diría una cosa y la lista
 * otra. Hay algo nuevo para el comercio cuando ZIPP respondió y lo último del
 * hilo lo escribió ZIPP.
 */
export function awaitingYou(ticket: {
  status: string;
  responses?: Array<{ from?: 'staff' | 'requester' }>;
}): boolean {
  const last = ticket.responses?.[ticket.responses.length - 1];
  return ticket.status === 'answered' && last?.from !== 'requester';
}
