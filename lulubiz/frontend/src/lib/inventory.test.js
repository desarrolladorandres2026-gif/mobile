import { describe, expect, it } from 'vitest';
import { validateAdjustment, validateItem, validateTransfer } from './inventory.js';

const item = (patch = {}) => ({
  sku: 'TORN-1',
  name: 'Tornillo 1/2',
  type: 'goods',
  unit: 'und',
  inventoryAccount: '143505',
  cogsAccount: '613505',
  incomeAccount: '',
  price: '',
  vatBps: '',
  minStock: '',
  currency: 'COP',
  ...patch,
});

describe('formulario de artículo', () => {
  it('un bien válido manda sus cuentas y omite lo opcional vacío', () => {
    const r = validateItem(item());
    expect(r.ok).toBe(true);
    expect(r.body).toEqual({ sku: 'TORN-1', type: 'goods', name: 'Tornillo 1/2', unit: 'und', inventoryAccount: '143505', cogsAccount: '613505' });
  });

  it('convierte el precio, el IVA y el mínimo a enteros', () => {
    const r = validateItem(item({ price: '1.250,50', vatBps: '1900', minStock: '2,5', incomeAccount: '413505' }));
    expect(r.body).toMatchObject({ price: 125050, vatBps: 1900, minStock: 2500, incomeAccount: '413505' });
  });

  it('un servicio no manda cuentas de inventario ni mínimo', () => {
    const r = validateItem(item({ type: 'service', inventoryAccount: '', cogsAccount: '', minStock: '5', incomeAccount: '413505' }));
    expect(r.ok).toBe(true);
    expect(r.body).not.toHaveProperty('inventoryAccount');
    expect(r.body).not.toHaveProperty('cogsAccount');
    expect(r.body).not.toHaveProperty('minStock');
  });

  it('señala cada campo malo', () => {
    const r = validateItem(item({ sku: 'con espacio', name: ' ', unit: '', inventoryAccount: 'abc', cogsAccount: '', price: '1.2345,00', minStock: '1,2345', incomeAccount: 'x' }));
    expect(r.ok).toBe(false);
    expect(Object.keys(r.errors).sort()).toEqual(['cogsAccount', 'incomeAccount', 'inventoryAccount', 'minStock', 'name', 'price', 'sku', 'unit']);
    expect(validateItem(item({ sku: '' })).errors.sku).toMatch(/código/);
  });

  it('al editar no manda código, tipo ni cuentas de inventario, y vacía lo que se borró', () => {
    const r = validateItem(item({ price: '', vatBps: '', minStock: '', incomeAccount: '' }), { editing: true });
    expect(r.ok).toBe(true);
    expect(r.body).toEqual({ name: 'Tornillo 1/2', unit: 'und', incomeAccount: null, price: null, vatBps: null, minStock: null });
  });
});

describe('formulario de ajuste', () => {
  const adj = (patch = {}) => ({ itemId: 'a1', warehouseId: '', date: '2026-10-20', direction: 'in', quantity: '10', unitCost: '1.250,50', counterAccount: '310505', reason: 'Saldo inicial', currency: 'COP', ...patch });

  it('una entrada exige costo unitario y lo convierte', () => {
    const r = validateAdjustment(adj());
    expect(r.ok).toBe(true);
    expect(r.body).toEqual({ itemId: 'a1', date: '2026-10-20', direction: 'in', quantity: 10_000, unitCost: 125050, counterAccount: '310505', reason: 'Saldo inicial' });
    expect(validateAdjustment(adj({ unitCost: '' })).errors.unitCost).toBeDefined();
  });

  it('una salida no manda costo y manda la bodega si se eligió', () => {
    const r = validateAdjustment(adj({ direction: 'out', unitCost: '', warehouseId: 'w1' }));
    expect(r.ok).toBe(true);
    expect(r.body).not.toHaveProperty('unitCost');
    expect(r.body.warehouseId).toBe('w1');
  });

  it('rechaza artículo, cantidad, cuenta, motivo y fecha vacíos o inválidos', () => {
    const r = validateAdjustment(adj({ itemId: '', quantity: '0', counterAccount: '', reason: ' ', date: '' }));
    expect(Object.keys(r.errors).sort()).toEqual(['counterAccount', 'date', 'itemId', 'quantity', 'reason']);
    expect(r.body).toBeNull();
  });
});

describe('formulario de traspaso', () => {
  const tr = (patch = {}) => ({ itemId: 'a1', fromWarehouseId: 'w1', toWarehouseId: 'w2', date: '2026-10-20', quantity: '3,5', note: '', ...patch });

  it('valida y convierte la cantidad', () => {
    expect(validateTransfer(tr()).body).toEqual({ itemId: 'a1', fromWarehouseId: 'w1', toWarehouseId: 'w2', date: '2026-10-20', quantity: 3500 });
    expect(validateTransfer(tr({ note: ' Reposición ' })).body.note).toBe('Reposición');
  });

  it('el origen y el destino deben ser distintos', () => {
    const r = validateTransfer(tr({ toWarehouseId: 'w1' }));
    expect(r.ok).toBe(false);
    expect(r.errors.toWarehouseId).toMatch(/otra bodega/);
  });

  it('señala lo que falta', () => {
    const r = validateTransfer(tr({ itemId: '', fromWarehouseId: '', toWarehouseId: '', quantity: 'x', date: '' }));
    expect(Object.keys(r.errors).sort()).toEqual(['date', 'fromWarehouseId', 'itemId', 'quantity', 'toWarehouseId']);
  });
});
