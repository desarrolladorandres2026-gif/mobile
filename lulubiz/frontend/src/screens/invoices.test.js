import { describe, expect, it } from 'vitest';
import { outcomeNotice, validateInvoice } from './Invoices.jsx';

const line = (patch = {}) => ({ description: 'Consultoría', quantity: '2', unitPrice: '50.000', discount: '', vatBps: 1900, accountId: '', ...patch });
const check = (patch = {}) =>
  validateInvoice({ customerId: 'c1', issueDate: '2026-10-20', paymentMethod: 'cash', dueDate: '', currency: 'COP', lines: [line()], ...patch });

describe('validación del formulario de factura', () => {
  it('arma las líneas en unidades enteras y calcula la vista previa igual que el servidor', () => {
    const result = check({ lines: [line(), line({ description: 'Mercancía', quantity: '1', unitPrice: '20.000', discount: '10', vatBps: 500 })] });
    expect(result.ok).toBe(true);
    expect(result.prepared.map(({ _preview, ...l }) => l)).toEqual([
      { description: 'Consultoría', quantity: 2000, unitPrice: 5_000_000, vatBps: 1900 },
      { description: 'Mercancía', quantity: 1000, unitPrice: 2_000_000, discountBps: 1000, vatBps: 500 },
    ]);
    // Importes en centavos: 118 000,00 de subtotal y 137 900,00 de total.
    expect(result.totals).toMatchObject({ subtotal: 11_800_000, tax: 1_990_000, total: 13_790_000 });
    expect(result.totals.taxByRate.map((r) => r.vatBps)).toEqual([500, 1900]);
  });

  it('exige cliente, fecha y al menos una línea con importe', () => {
    expect(check({ customerId: '' }).errors.form).toContain('Elige el cliente.');
    expect(check({ issueDate: '' }).errors.form).toContain('Elige la fecha de emisión.');
    const empty = check({ lines: [line({ description: '', unitPrice: '', quantity: '1' })] });
    expect(empty.ok).toBe(false);
    expect(empty.errors.form).toContain('Agrega al menos una línea.');
  });

  it('una venta a crédito necesita vencimiento y este no puede ser anterior a la emisión', () => {
    expect(check({ paymentMethod: 'credit' }).errors.form.join(' ')).toMatch(/vencimiento/);
    expect(check({ paymentMethod: 'credit', dueDate: '2026-09-01' }).errors.form.join(' ')).toMatch(/anterior/);
    expect(check({ paymentMethod: 'credit', dueDate: '2026-11-20' }).ok).toBe(true);
  });

  it('marca cada campo mal escrito sin redondear nada', () => {
    const result = check({ lines: [line({ description: '', quantity: '1,2345', unitPrice: '12,345', discount: '120', accountId: 'abc' })] });
    expect(result.ok).toBe(false);
    expect(result.errors.lines[0]).toMatchObject({
      description: expect.any(String),
      quantity: expect.stringMatching(/Cantidad/),
      unitPrice: expect.stringMatching(/Precio/),
      discount: expect.stringMatching(/Descuento/),
      accountId: expect.stringMatching(/numérico/),
    });
  });

  it('un precio vacío en una línea con descripción es un error, no un cero silencioso', () => {
    const result = check({ lines: [line({ unitPrice: '' })] });
    expect(result.ok).toBe(false);
    expect(result.errors.lines[0].unitPrice).toBeDefined();
  });

  it('un total en cero no se emite', () => {
    const result = check({ lines: [line({ unitPrice: '0' })] });
    expect(result.ok).toBe(false);
    expect(result.errors.form).toContain('El total debe ser mayor que cero.');
  });

  it('el descuento del 100 % deja la línea en cero y el documento inválido', () => {
    expect(check({ lines: [line({ discount: '100' })] }).errors.form).toContain('El total debe ser mayor que cero.');
  });
});

describe('mensajes del resultado de emitir', () => {
  const issued = (extra = {}) => ({ invoice: { fullNumber: 'FE12', status: 'issued', accounting: { status: 'posted' }, provider: { sandbox: false }, ...extra } });

  it('emitida y contabilizada es un éxito', () => {
    expect(outcomeNotice(issued(), 'La factura')).toEqual({ kind: 'success', text: 'La factura FE12 emitida y contabilizada.' });
  });

  it('con el simulador avisa que no tiene validez', () => {
    expect(outcomeNotice(issued({ provider: { sandbox: true } }), 'La factura').text).toMatch(/sin validez ante la DIAN/);
  });

  it('rechazada muestra el motivo del proveedor, como error', () => {
    const result = outcomeNotice({ rejected: true, invoice: { fullNumber: 'FE3', status: 'rejected', rejection: { message: 'NIT del adquirente inválido' } } }, 'La factura');
    expect(result.kind).toBe('error');
    expect(result.text).toMatch(/FE3 fue rechazada.*NIT del adquirente inválido/);
  });

  it('pendiente explica que no se contabilizó y qué hacer', () => {
    const result = outcomeNotice({ pending: true, invoice: { fullNumber: 'FE4', status: 'pending_provider' } }, 'La factura');
    expect(result.kind).toBe('info');
    expect(result.text).toMatch(/Reintentar envío/);
    expect(result.text).toMatch(/No se contabilizó/);
  });

  it('emitida con la contabilización pendiente lo dice con la causa y no la presenta como éxito completo', () => {
    const result = outcomeNotice(issued({ accounting: { status: 'pending', error: 'el período 2026-10 está cerrado' } }), 'La factura');
    expect(result.kind).toBe('info');
    expect(result.text).toMatch(/falta contabilizarla.*cerrado/);
  });

  it('funciona también para notas crédito', () => {
    expect(outcomeNotice({ note: { fullNumber: 'NC1', status: 'issued', accounting: { status: 'posted' } } }, 'La nota crédito').text).toMatch(/La nota crédito NC1 emitida/);
  });
});
