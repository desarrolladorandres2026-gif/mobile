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

describe('retenciones del cliente en el recibo', () => {
  const invoices = [{ _id: 'i1', fullNumber: 'FE1', balance: 1_190_000 }];
  const base = { partyId: 'p1', date: '2026-10-20', depositAccount: '110505', invoices, amounts: { i1: '11.900,00' }, currency: 'COP' };
  const row = (patch = {}) => ({ name: 'Retefuente 2,5 %', accountId: '135595', amount: '250,00', ...patch });

  it('suma lo retenido y dice cuánto entra a caja', () => {
    const r = validateReceipt({ ...base, withholdingRows: [row(), row({ name: 'ReteIVA', accountId: '135596', amount: '285,00' }), { name: '', accountId: '', amount: '' }] });
    expect(r.ok).toBe(true);
    expect(r.withholdings).toEqual([{ name: 'Retefuente 2,5 %', accountId: '135595', amount: 25_000 }, { name: 'ReteIVA', accountId: '135596', amount: 28_500 }]);
    expect(r).toMatchObject({ total: 1_190_000, withheld: 53_500, received: 1_136_500 });
  });

  it('sin retenciones todo entra a caja', () => {
    expect(validateReceipt(base)).toMatchObject({ ok: true, withheld: 0, received: 1_190_000, withholdings: [] });
  });

  it('señala el nombre, la cuenta y el valor, y que algo tiene que entrar a caja', () => {
    expect(validateReceipt({ ...base, withholdingRows: [row({ name: ' ' })] }).errors.form).toEqual(['Retención 1: escribe su nombre.']);
    expect(validateReceipt({ ...base, withholdingRows: [row({ accountId: 'x' })] }).errors.form).toEqual(['Retención 1: indica la cuenta de activo donde queda a favor.']);
    expect(validateReceipt({ ...base, withholdingRows: [row({ amount: '0' })] }).errors.form).toEqual(['Retención 1: valor no válido.']);
    expect(validateReceipt({ ...base, withholdingRows: [row({ amount: '11.900,00' })] }).errors.form).toEqual(['Las retenciones deben ser menores que el cobro: algo tiene que entrar a caja o bancos.']);
  });
});
