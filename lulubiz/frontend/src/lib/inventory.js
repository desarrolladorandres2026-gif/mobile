import { parseQuantity } from './invoicing.js';
import { parseAmount } from './money.js';

export const ITEM_TYPES = [
  { value: 'goods', label: 'Bien (maneja existencias)' },
  { value: 'service', label: 'Servicio (sin existencias)' },
];

export const MOVEMENT_TYPES = {
  purchase_in: 'Compra',
  purchase_void: 'Compra anulada',
  purchase_return: 'Devolución a proveedor',
  purchase_return_void: 'Devolución a proveedor anulada',
  sale_out: 'Venta',
  sale_return: 'Devolución de cliente',
  adjust_in: 'Ajuste de entrada',
  adjust_out: 'Ajuste de salida',
  transfer_out: 'Traspaso (sale)',
  transfer_in: 'Traspaso (entra)',
};

const ACCOUNT = /^\d{1,12}$/;
const SKU = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Cantidad opcional: vacío es «sin valor»; si hay texto debe ser una cantidad válida. */
function optionalQuantity(text) {
  if (!String(text ?? '').trim()) return { value: undefined };
  const value = parseQuantity(text);
  return value === null ? { error: 'Cantidad no válida (hasta 3 decimales).' } : { value };
}

/**
 * Validación del formulario de artículo. Un bien lleva cuenta de inventario y de costo de ventas; un servicio no.
 * Con `editing`, el código, el tipo y las cuentas de inventario y costo ya no se envían (el servidor no los deja cambiar).
 */
export function validateItem({ sku, name, type, unit, inventoryAccount, cogsAccount, incomeAccount, price, vatBps, minStock, currency }, { editing = false } = {}) {
  const errors = {};
  const goods = type === 'goods';
  if (!editing) {
    if (!sku.trim()) errors.sku = 'Escribe el código del artículo.';
    else if (!SKU.test(sku.trim())) errors.sku = 'El código admite letras, números, punto, guion y guion bajo.';
  }
  if (!name.trim()) errors.name = 'Escribe el nombre.';
  if (!unit.trim()) errors.unit = 'Escribe la unidad (UND, KG, CAJA…).';
  if (goods && !editing) {
    if (!ACCOUNT.test(inventoryAccount.trim())) errors.inventoryAccount = 'Indica la cuenta de inventario.';
    if (!ACCOUNT.test(cogsAccount.trim())) errors.cogsAccount = 'Indica la cuenta de costo de ventas.';
  }
  if (incomeAccount.trim() && !ACCOUNT.test(incomeAccount.trim())) errors.incomeAccount = 'Código de cuenta numérico.';
  const amount = price.trim() ? parseAmount(price, currency) : undefined;
  if (amount === null) errors.price = 'Precio no válido. Ejemplo: 1.250.000,50';
  const stock = goods ? optionalQuantity(minStock) : { value: undefined };
  if (stock.error) errors.minStock = stock.error;

  const body = {
    ...(editing ? {} : { sku: sku.trim(), type }),
    name: name.trim(),
    unit: unit.trim(),
    ...(editing || !goods ? {} : { inventoryAccount: inventoryAccount.trim(), cogsAccount: cogsAccount.trim() }),
    ...(incomeAccount.trim() ? { incomeAccount: incomeAccount.trim() } : editing ? { incomeAccount: null } : {}),
    ...(amount !== undefined && amount !== null ? { price: amount } : editing ? { price: null } : {}),
    ...(vatBps !== '' && vatBps !== undefined ? { vatBps: Number(vatBps) } : editing ? { vatBps: null } : {}),
    ...(stock.value !== undefined ? { minStock: stock.value } : editing && goods ? { minStock: null } : {}),
  };
  return { ok: Object.keys(errors).length === 0, errors, body };
}

const isDay = (text) => /^\d{4}-\d{2}-\d{2}$/.test(text);

/** Ajuste manual: una entrada trae su costo unitario; una salida sale al costo promedio. */
export function validateAdjustment({ itemId, warehouseId, date, direction, quantity, unitCost, counterAccount, reason, currency }) {
  const errors = {};
  if (!itemId) errors.itemId = 'Elige el artículo.';
  if (!isDay(date)) errors.date = 'Elige la fecha.';
  const milli = parseQuantity(quantity);
  if (milli === null) errors.quantity = 'Cantidad no válida (hasta 3 decimales).';
  let cost;
  if (direction === 'in') {
    cost = parseAmount(unitCost, currency);
    if (cost === null || !unitCost.trim()) errors.unitCost = 'Costo unitario no válido. Ejemplo: 1.250,50';
  }
  if (!ACCOUNT.test(counterAccount.trim())) errors.counterAccount = direction === 'in' ? 'Indica la cuenta de la contrapartida (por ejemplo, capital).' : 'Indica la cuenta de la contrapartida (por ejemplo, pérdida de inventario).';
  if (!reason.trim()) errors.reason = 'Escribe el motivo del ajuste.';
  const ok = Object.keys(errors).length === 0;
  return {
    ok,
    errors,
    body: ok
      ? {
          itemId,
          ...(warehouseId ? { warehouseId } : {}),
          date,
          direction,
          quantity: milli,
          ...(direction === 'in' ? { unitCost: cost } : {}),
          counterAccount: counterAccount.trim(),
          reason: reason.trim(),
        }
      : null,
  };
}

export function validateTransfer({ itemId, fromWarehouseId, toWarehouseId, date, quantity, note }) {
  const errors = {};
  if (!itemId) errors.itemId = 'Elige el artículo.';
  if (!fromWarehouseId) errors.fromWarehouseId = 'Elige la bodega de origen.';
  if (!toWarehouseId) errors.toWarehouseId = 'Elige la bodega de destino.';
  if (fromWarehouseId && fromWarehouseId === toWarehouseId) errors.toWarehouseId = 'El destino debe ser otra bodega.';
  if (!isDay(date)) errors.date = 'Elige la fecha.';
  const milli = parseQuantity(quantity);
  if (milli === null) errors.quantity = 'Cantidad no válida (hasta 3 decimales).';
  const ok = Object.keys(errors).length === 0;
  return { ok, errors, body: ok ? { itemId, fromWarehouseId, toWarehouseId, date, quantity: milli, ...(note.trim() ? { note: note.trim() } : {}) } : null };
}
