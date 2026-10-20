import { describe, expect, it } from 'vitest';
import { validatePayment } from './payables.js';

const purchases = [
  { _id: 'a', fullNumber: 'FC1', balance: 1_165_000 },
  { _id: 'b', fullNumber: 'FC2', balance: 500_000 },
];
const check = (patch = {}) => validatePayment({ partyId: 'p1', date: '2026-10-20', paymentAccount: '110505', purchases, amounts: { a: '11.650,00' }, currency: 'COP', ...patch });

describe('validación del pago', () => {
  it('arma las aplicaciones en centavos y suma el total', () => {
    const result = check({ amounts: { a: '11.650,00', b: '2.000' } });
    expect(result.ok).toBe(true);
    expect(result.allocations).toEqual([{ purchaseId: 'a', amount: 1_165_000 }, { purchaseId: 'b', amount: 200_000 }]);
    expect(result.total).toBe(1_365_000);
  });

  it('necesita al menos una factura y rechaza lo que supera el saldo o no es un importe', () => {
    expect(check({ amounts: {} }).errors.form).toContain('Indica cuánto se paga en al menos una factura.');
    const result = check({ amounts: { a: '11.650,01', b: 'abc' } });
    expect(result.ok).toBe(false);
    expect(result.errors.rows.a).toMatch(/Supera el saldo de 11\.650,00/);
    expect(result.errors.rows.b).toMatch(/no válido/);
    expect(check({ amounts: { a: '0' } }).errors.rows.a).toMatch(/mayor que cero/);
  });

  it('exige proveedor, fecha y cuenta numérica', () => {
    expect(check({ partyId: '', date: '', paymentAccount: 'banco' }).errors.form).toEqual([
      'Elige el proveedor.',
      'Elige la fecha del pago.',
      'Indica la cuenta de caja o bancos de donde sale el dinero.',
    ]);
  });
});
