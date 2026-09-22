import { declinedMessage } from '../lib/paymentCopy';

describe('declinedMessage', () => {
  it('sin motivo, tranquiliza y sugiere qué hacer', () => {
    expect(declinedMessage(undefined, 'Prueba otro método.')).toBe('No se hizo ningún cobro. Prueba otro método.');
    expect(declinedMessage('   ', 'Prueba otro método.')).toBe('No se hizo ningún cobro. Prueba otro método.');
  });

  it('con motivo, lo antepone y siempre aclara que no hubo cobro', () => {
    expect(declinedMessage('La tarjeta está vencida.', 'x')).toBe('La tarjeta está vencida. No se hizo ningún cobro.');
  });

  it('cierra con punto un motivo que llega sin él', () => {
    expect(declinedMessage('Pedido no encontrado', 'x')).toBe('Pedido no encontrado. No se hizo ningún cobro.');
  });
});
