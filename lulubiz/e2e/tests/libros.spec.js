import { expect, test as base } from '@playwright/test';
import { PASSWORD, checkDesign, shot, tokenFromMail } from './helpers.js';

const OWNER = 'olga@distribuciones.co';
const DAY_MS = 86_400_000;
const iso = (offset = 0) => new Date(Date.now() + offset * DAY_MS).toISOString().slice(0, 10);
const YEAR = new Date().getUTCFullYear();

let shared;
const test = base.extend({ page: async ({}, use) => use(shared) });
const nav = (page, name) => page.getByRole('navigation', { name: 'Principal' }).getByRole('link', { name, exact: true });
const heading = (page, name) => page.getByRole('heading', { name, level: 1 });

async function bootstrap(page, request) {
  await request.post('/__reset');
  const registered = await page.request.post('/v1/auth/register', {
    data: { companyName: 'Distribuciones del Norte SAS', country: 'CO', currency: 'COP', ownerName: 'Olga Ruiz', email: OWNER, password: PASSWORD },
  });
  expect(registered.status()).toBe(201);
  const { tenantId } = await registered.json();
  expect((await page.request.post('/v1/auth/verify-email', { data: { token: await tokenFromMail(request, OWNER) } })).status()).toBe(204);
  expect((await page.request.post('/v1/auth/login', { data: { email: OWNER, password: PASSWORD } })).status()).toBe(200);
  const base = `/v1/tenants/${tenantId}`;
  let n = 0;
  const post = async (path, data) => {
    const res = await page.request.post(`${base}${path}`, { data, headers: { 'idempotency-key': `libros-${(n += 1)}-aaaaaaaa` } });
    expect(res.status(), `${path}: ${await res.text()}`).toBeLessThan(300);
    return res.json();
  };
  for (const a of [
    { code: '1', name: 'Activo', type: 'asset', postable: false },
    { code: '110505', name: 'Caja', type: 'asset', parentCode: '1' },
    { code: '130505', name: 'Clientes', type: 'asset', parentCode: '1' },
    { code: '2', name: 'Pasivo', type: 'liability', postable: false },
    { code: '220505', name: 'Proveedores', type: 'liability', parentCode: '2' },
    { code: '236540', name: 'Retención en la fuente', type: 'liability', parentCode: '2' },
    { code: '240805', name: 'IVA por pagar', type: 'liability', parentCode: '2' },
    { code: '240810', name: 'IVA descontable', type: 'liability', parentCode: '2' },
    { code: '4', name: 'Ingresos', type: 'income', postable: false },
    { code: '413505', name: 'Ventas', type: 'income', parentCode: '4' },
    { code: '5', name: 'Gastos', type: 'expense', postable: false },
    { code: '519595', name: 'Gastos diversos', type: 'expense', parentCode: '5' },
  ]) await post('/accounts', a);
  const saved = await page.request.put(`${base}/invoicing/settings`, {
    data: {
      issuer: { name: 'Distribuciones del Norte SAS', taxIdType: 'NIT', taxId: '890903938', checkDigit: 8, regime: 'responsable_iva', address: { line: 'Carrera 10 # 5-20', city: 'Garzón', region: 'Huila' } },
      accounts: { receivable: '130505', income: '413505', vatPayable: '240805', payable: '220505', vatDeductible: '240810', cash: '110505' },
    },
  });
  expect(saved.status()).toBe(200);
  for (const [docType, prefix] of [['invoice', 'FE'], ['credit_note', 'NC']]) {
    await post('/invoicing/resolutions', { docType, prefix, number: '18760000001', from: 1, to: 100, validFrom: `${YEAR - 1}-01-01`, validTo: `${YEAR + 1}-12-31` });
  }
  const cust1 = (await post('/parties', { name: 'Droguería Los Andes', roles: ['customer'], taxIdType: 'NIT', taxId: '800197268', checkDigit: 4 }))._id;
  const cust2 = (await post('/parties', { name: 'Papelería Central', roles: ['customer'], taxIdType: 'NIT', taxId: '800250119', checkDigit: 1 }))._id;
  const supplier = (await post('/parties', { name: 'Aseo Total SAS', roles: ['supplier'], taxIdType: 'NIT', taxId: '900123456', checkDigit: 8 }))._id;
  const a = (await post('/invoices', { customerId: cust1, issueDate: iso(-1), paymentMethod: 'credit', dueDate: iso(30), lines: [{ description: 'Mercancía', quantity: 1000, unitPrice: 1_000_000, vatBps: 1900 }] })).invoice;
  await post('/invoices', { customerId: cust2, issueDate: iso(0), paymentMethod: 'cash', lines: [{ description: 'Papel', quantity: 1000, unitPrice: 500_000, vatBps: 0 }] });
  await post(`/invoices/${a._id}/credit-notes`, { reasonCode: '3', lines: [{ lineIndex: 0, quantity: 250 }] });
  await post('/receipts', { partyId: cust1, date: iso(0), depositAccount: '110505', allocations: [{ invoiceId: a._id, amount: 500_000 }] });
  const purchase = (
    await post('/purchases', {
      supplierId: supplier,
      supplierDocNumber: 'SA-1',
      issueDate: iso(-1),
      dueDate: iso(30),
      lines: [{ description: 'Aseo', quantity: 1000, unitPrice: 1_000_000, vatBps: 1900, accountId: '519595' }],
      withholdings: [{ name: 'Retefuente 2,5 %', accountId: '236540', basis: 'subtotal', rateBps: 250 }],
    })
  ).purchase;
  await post(`/purchases/${purchase._id}/credit-notes`, { reason: 'Devolución', supplierDocNumber: 'NC-9', lines: [{ lineIndex: 0, quantity: 500 }] });
  await post('/payments', { partyId: supplier, date: iso(0), paymentAccount: '110505', allocations: [{ purchaseId: purchase._id, amount: 300_000 }] });
}

async function report(page, name, { from = `${YEAR}-01-01`, party } = {}) {
  await page.getByLabel('Informe', { exact: true }).selectOption({ label: name });
  await page.getByLabel('Desde').fill(from);
  if (party) {
    await page.getByLabel(/^Buscar /).fill(party.search);
    await expect(page.getByLabel(party.label, { exact: true }).getByRole('option', { name: party.option })).toBeAttached();
    await page.getByLabel(party.label, { exact: true }).selectOption({ label: party.text });
  }
  await page.getByRole('button', { name: 'Ver informe' }).click();
}

test.describe.serial('libros y estados de cuenta', () => {
  test.beforeAll(async ({ browser, request }) => {
    shared = await browser.newPage({ baseURL: 'http://127.0.0.1:4100', locale: 'es-CO', viewport: { width: 1366, height: 820 } });
    await bootstrap(shared, request);
  });
  test.afterAll(async () => {
    await shared?.close();
  });

  test('el libro de ventas lista facturas y notas con su base e IVA por tarifa', async ({ page }) => {
    await page.goto('/app/libros');
    await expect(heading(page, 'Libros y estados de cuenta')).toBeVisible();
    await report(page, 'Libro de ventas');
    await expect(page.getByRole('row', { name: /FE1 / })).toContainText('Droguería Los Andes');
    await expect(page.getByRole('row', { name: /FE1 / })).toContainText('11.900,00');
    await expect(page.getByRole('row', { name: /Nota crédito/ })).toContainText('-2.975,00');
    await expect(page.getByRole('columnheader', { name: 'Base 19 %' })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'IVA 0 %' })).toBeVisible();
    await expect(page.getByText('Documentos').locator('..').getByText('3', { exact: true })).toBeVisible();
    await expect(page.getByText('Total', { exact: true }).locator('..').getByText('13.925,00')).toBeVisible();
    await checkDesign(page, 'libro de ventas');
    await shot(page, 'libros-ventas');
  });

  test('el libro de compras muestra las retenciones y lo que se paga', async ({ page }) => {
    await report(page, 'Libro de compras');
    await expect(page.getByRole('row', { name: /SA-1/ }).first()).toContainText('250,00');
    await expect(page.getByRole('row', { name: /Nota de proveedor/ })).toContainText('-5.825,00');
    await expect(page.getByText('Retenciones').last().locator('..').getByText('125,00')).toBeVisible();
    await checkDesign(page, 'libro de compras');
  });

  test('el estado de cuenta de un cliente lleva el saldo y cuadra con su factura', async ({ page }) => {
    await report(page, 'Estado de cuenta de un cliente', { party: { search: 'andes', label: 'Cliente', option: /Droguería Los Andes/, text: 'Droguería Los Andes — NIT 800197268' } });
    await expect(page.getByRole('row', { name: /Factura FE1/ })).toContainText('11.900,00');
    await expect(page.getByRole('row', { name: /Nota crédito/ })).toContainText('8.925,00');
    await expect(page.getByRole('row', { name: /Recibo de caja/ })).toContainText('3.925,00');
    await expect(page.getByText(/Debe al .*: 3\.925,00 COP/)).toBeVisible();
    await checkDesign(page, 'estado de cuenta de cliente');
    await shot(page, 'libros-cliente');
  });

  test('el estado de cuenta de un proveedor y las ventas por cliente', async ({ page }) => {
    await report(page, 'Estado de cuenta de un proveedor', { party: { search: 'aseo', label: 'Proveedor', option: /Aseo Total SAS/, text: 'Aseo Total SAS — NIT 900123456' } });
    await expect(page.getByRole('row', { name: /Comprobante de egreso|Pago/ })).toContainText('2.825,00');
    await expect(page.getByText(/Se le debe al .*: 2\.825,00 COP/)).toBeVisible();

    await report(page, 'Ventas netas por cliente');
    const first = page.getByRole('row', { name: /Droguería Los Andes/ });
    await expect(first).toContainText('8.925,00');
    await expect(page.getByRole('row', { name: /Papelería Central/ })).toContainText('5.000,00');
    await expect(page.getByText(/Ventas netas: 13\.925,00 COP/)).toBeVisible();
  });

  test('pide el tercero y valida las fechas antes de consultar', async ({ page }) => {
    await page.getByLabel('Informe', { exact: true }).selectOption({ label: 'Estado de cuenta de un cliente' });
    await page.getByRole('button', { name: 'Ver informe' }).click();
    await expect(page.getByText('Elige el cliente.')).toBeVisible();
    await page.getByLabel('Informe', { exact: true }).selectOption({ label: 'Libro de ventas' });
    await page.getByLabel('Desde').fill(iso(5));
    await page.getByLabel('Hasta').fill(iso(1));
    await page.getByRole('button', { name: 'Ver informe' }).click();
    await expect(page.getByText('La fecha inicial no puede ser posterior a la final.')).toBeVisible();
  });
});
