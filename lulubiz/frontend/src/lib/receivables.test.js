import { describe, expect, it } from 'vitest';
import { validateReceipt } from './receivables.js';

const invoices = [
  { _id: 'a', fullNumber: 'FE1', balance: 11_900_000 },
  { _id: 'b', fullNumber: 'FE2', balance: 5_000_000 },
];
const check = (patch = {}) =>
  validateReceipt({ partyId: 'p1', date: '2026-10-20', depositAccount: '110505', invoices, amounts: { a: '119.000,00' }, currency: 'COP', ...patch });

describe('validación del cobro', () => {
  it('arma las aplicaciones en centavos y suma el total', () => {
    const result = check({ amounts: { a: '119.000,00', b: '20.000' } });
    expect(result.ok).toBe(true);
    expect(result.allocations).toEqual([{ invoiceId: 'a', amount: 11_900_000 }, { invoiceId: 'b', amount: 2_000_000 }]);
    expect(result.total).toBe(13_900_000);
  });

  it('una factura sin texto no se cobra, y se necesita al menos una', () => {
    expect(check({ amounts: { a: '', b: '  ' } }).errors.form).toContain('Indica cuánto se cobra en al menos una factura.');
    expect(check({ amounts: { b: '10' } }).allocations).toEqual([{ invoiceId: 'b', amount: 1000 }]);
  });

  it('rechaza lo que supera el saldo, lo que no es un importe y los ceros', () => {
    const result = check({ amounts: { a: '119.000,01', b: 'abc' } });
    expect(result.ok).toBe(false);
    expect(result.errors.rows.a).toMatch(/Supera el saldo de 119\.000,00/);
    expect(result.errors.rows.b).toMatch(/no válido/);
    expect(check({ amounts: { a: '0' } }).errors.rows.a).toMatch(/mayor que cero/);
  });

  it('no redondea decimales de más', () => {
    expect(check({ amounts: { a: '10,005' } }).errors.rows.a).toMatch(/no válido/);
  });

  it('exige cliente, fecha y una cuenta numérica', () => {
    const result = check({ partyId: '', date: '', depositAccount: 'caja' });
    expect(result.errors.form).toEqual(['Elige el cliente.', 'Elige la fecha del cobro.', 'Indica la cuenta de caja o bancos donde entra el dinero.']);
  });

  it('con un error en una fila no devuelve el aviso de "ninguna factura"', () => {
    const result = check({ amounts: { a: 'xx' } });
    expect(result.errors.form).toEqual([]);
    expect(result.ok).toBe(false);
  });
});
