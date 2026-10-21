import { expect, test as base } from '@playwright/test';
import { PASSWORD, checkDesign, shot, tokenFromMail } from './helpers.js';

const OWNER = 'diana@ferreteria.co';
const DAY_MS = 86_400_000;
const iso = (offset = 0) => new Date(Date.now() + offset * DAY_MS).toISOString().slice(0, 10);
const YEAR = new Date().getUTCFullYear();

let shared;
let tenantId;
let invoiceId;
const test = base.extend({ page: async ({}, use) => use(shared) });
const nav = (page, name) => page.getByRole('navigation', { name: 'Principal' }).getByRole('link', { name, exact: true });
const heading = (page, name) => page.getByRole('heading', { name, level: 1 });

async function bootstrap(page, request) {
  await request.post('/__reset');
  const registered = await page.request.post('/v1/auth/register', {
    data: { companyName: 'Ferretería La Esquina SAS', country: 'CO', currency: 'COP', ownerName: 'Diana Mora', email: OWNER, password: PASSWORD },
  });
  expect(registered.status()).toBe(201);
  tenantId = (await registered.json()).tenantId;
  expect((await page.request.post('/v1/auth/verify-email', { data: { token: await tokenFromMail(request, OWNER) } })).status()).toBe(204);
  expect((await page.request.post('/v1/auth/login', { data: { email: OWNER, password: PASSWORD } })).status()).toBe(200);
  const base = `/v1/tenants/${tenantId}`;
  let n = 0;
  const post = async (path, data) => {
    const res = await page.request.post(`${base}${path}`, { data, headers: { 'idempotency-key': `anticipos-${(n += 1)}-aaaaaaaa` } });
    expect(res.status(), `${path}: ${await res.text()}`).toBeLessThan(300);
    return res.json();
  };
  for (const a of [
    { code: '1', name: 'Activo', type: 'asset', postable: false },
    { code: '110505', name: 'Caja', type: 'asset', parentCode: '1' },
    { code: '130505', name: 'Clientes', type: 'asset', parentCode: '1' },
    { code: '133005', name: 'Anticipos a proveedores', type: 'asset', parentCode: '1' },
    { code: '2', name: 'Pasivo', type: 'liability', postable: false },
    { code: '220505', name: 'Proveedores', type: 'liability', parentCode: '2' },
    { code: '240805', name: 'IVA por pagar', type: 'liability', parentCode: '2' },
    { code: '240810', name: 'IVA descontable', type: 'liability', parentCode: '2' },
    { code: '280505', name: 'Anticipos de clientes', type: 'liability', parentCode: '2' },
    { code: '4', name: 'Ingresos', type: 'income', postable: false },
    { code: '413505', name: 'Ventas', type: 'income', parentCode: '4' },
    { code: '5', name: 'Gastos', type: 'expense', postable: false },
    { code: '519595', name: 'Gastos diversos', type: 'expense', parentCode: '5' },
  ]) await post('/accounts', a);
  const saved = await page.request.put(`${base}/invoicing/settings`, {
    data: {
      issuer: { name: 'Ferretería La Esquina SAS', taxIdType: 'NIT', taxId: '890903938', checkDigit: 8, regime: 'responsable_iva', address: { line: 'Carrera 10 # 5-20', city: 'Garzón', region: 'Huila' } },
      accounts: { receivable: '130505', income: '413505', vatPayable: '240805', payable: '220505', vatDeductible: '240810', cash: '110505', customerAdvance: '280505', supplierAdvance: '133005' },
    },
  });
  expect(saved.status()).toBe(200);
  for (const [docType, prefix] of [['invoice', 'FE'], ['credit_note', 'NC']]) {
    await post('/invoicing/resolutions', { docType, prefix, number: '18760000001', from: 1, to: 100, validFrom: `${YEAR - 1}-01-01`, validTo: `${YEAR + 1}-12-31` });
  }
  const cust = (await post('/parties', { name: 'Droguería Los Andes', roles: ['customer'], taxIdType: 'NIT', taxId: '800197268', checkDigit: 4 }))._id;
  await post('/parties', { name: 'Aseo Total SAS', roles: ['supplier'], taxIdType: 'NIT', taxId: '900123456', checkDigit: 8 });
  invoiceId = (await post('/invoices', { customerId: cust, issueDate: iso(-1), paymentMethod: 'credit', dueDate: iso(30), lines: [{ description: 'Mercancía', quantity: 1000, unitPrice: 1_000_000, vatBps: 1900 }] })).invoice._id;
  await post('/purchases', { supplierId: (await (await page.request.get(`${base}/parties?role=supplier`)).json()).items[0]._id, supplierDocNumber: 'SA-1', issueDate: iso(-1), lines: [{ description: 'Aseo', quantity: 1000, unitPrice: 1_000_000, vatBps: 1900, accountId: '519595' }] });
}

const invoiceBalance = async (page) => (await (await page.request.get(`/v1/tenants/${tenantId}/invoices/${invoiceId}`)).json()).balance;

test.describe.serial('anticipos de clientes y a proveedores', () => {
  test.beforeAll(async ({ browser, request }) => {
    shared = await browser.newPage({ baseURL: 'http://127.0.0.1:4100', locale: 'es-CO', viewport: { width: 1366, height: 820 } });
    await bootstrap(shared, request);
  });
  test.afterAll(async () => {
    await shared?.close();
  });

  test('registrar un anticipo de cliente valida el formulario y lo deja sin aplicar', async ({ page }) => {
    await page.goto('/app/anticipos-clientes');
    await expect(heading(page, 'Anticipos de clientes')).toBeVisible();
    await expect(page.getByText('No hay anticipos con este filtro.')).toBeVisible();
    await page.getByRole('button', { name: 'Registrar anticipo' }).click();
    await page.getByRole('button', { name: 'Registrar anticipo' }).last().click();
    await expect(page.getByText('Elige el cliente.')).toBeVisible();
    await expect(page.getByText('Importe no válido. Ejemplo: 500.000')).toBeVisible();
    await expect(page.getByText('Indica la cuenta de caja o bancos donde entra el dinero.')).toBeVisible();

    await page.getByLabel('Buscar cliente').fill('andes');
    await expect(page.getByLabel('Cliente', { exact: true }).getByRole('option', { name: /Droguería Los Andes/ })).toBeAttached();
    await page.getByLabel('Cliente', { exact: true }).selectOption({ label: 'Droguería Los Andes — NIT 800197268' });
    await page.getByLabel('Importe (COP)').fill('5.000');
    await page.getByLabel('Cuenta de caja o bancos').fill('110505');
    await checkDesign(page, 'registrar anticipo');
    await shot(page, 'anticipos-registrar');
    await page.getByRole('button', { name: 'Registrar anticipo' }).last().click();
    await expect(page.getByText('Anticipo RC1 registrado por 5.000,00 COP de Droguería Los Andes.')).toBeVisible();
    const row = page.getByRole('row', { name: /^RC1 / });
    await expect(row).toContainText('Sin aplicar');
    await expect(row).toContainText('5.000,00');
  });

  test('aplicarlo a una factura baja el saldo de la factura sin mover dinero', async ({ page }) => {
    const row = page.getByRole('row', { name: /^RC1 / });
    await row.getByRole('button', { name: 'Ver y aplicar' }).click();
    await page.getByRole('button', { name: 'Aplicar a facturas' }).click();
    await expect(page.getByRole('row', { name: /^FE1 / })).toContainText('11.900,00');
    await page.getByRole('button', { name: 'Aplicar anticipo' }).click();
    await expect(page.getByText('Escribe cuánto aplicar al menos a un documento.')).toBeVisible();
    await page.getByLabel('Aplicar a FE1').fill('6.000');
    await expect(page.getByText('Solo debe 11.900,00.')).toHaveCount(0);
    await page.getByRole('button', { name: 'Aplicar anticipo' }).click();
    await expect(page.getByText(/Se aplican 6.000,00 y el anticipo solo tiene 5.000,00 disponibles/)).toBeVisible();
    await page.getByRole('button', { name: 'Repartir lo disponible' }).click();
    await expect(page.getByLabel('Aplicar a FE1')).toHaveValue('5.000,00'.replace('.', ''));
    await checkDesign(page, 'aplicar anticipo');
    await shot(page, 'anticipos-aplicar');
    await page.getByRole('button', { name: 'Aplicar anticipo' }).click();

    await expect(page.getByRole('row', { name: /^AA1 / })).toContainText('FE1');
    await expect(page.getByRole('row', { name: /^RC1 / })).toContainText('Aplicado del todo');
    expect(await invoiceBalance(page)).toBe(1_190_000 - 500_000);
  });

  test('los anticipos agotados salen del filtro «con saldo» y siguen en «todos»', async ({ page }) => {
    await page.reload();
    await expect(page.getByRole('row', { name: /^RC1 / })).toContainText('Aplicado del todo');
    await page.getByLabel('Mostrar').selectOption({ label: 'Con saldo por aplicar' });
    await expect(page.getByText('No hay anticipos con este filtro.')).toBeVisible();
    await page.getByLabel('Mostrar').selectOption({ label: 'Todos' });
    await expect(page.getByRole('row', { name: /^RC1 / })).toBeVisible();
  });

  test('anular la aplicación devuelve el saldo a la factura y al anticipo; luego el anticipo se anula', async ({ page }) => {
    await page.getByRole('row', { name: /^RC1 / }).getByRole('button', { name: 'Ver y aplicar' }).click();
    await page.getByRole('button', { name: 'Anular aplicación' }).click();
    await page.getByRole('button', { name: 'Sí, anular' }).click();
    await expect(page.getByRole('row', { name: /^AA1 / })).toContainText('Anulada');
    await expect(page.getByRole('row', { name: /^RC1 / })).toContainText('Sin aplicar');
    expect(await invoiceBalance(page)).toBe(1_190_000);

    await page.getByRole('row', { name: /^RC1 / }).getByRole('button', { name: 'Anular', exact: true }).click();
    await page.getByRole('button', { name: 'Sí, anular' }).click();
    await expect(page.getByText('Anticipo RC1 anulado.')).toBeVisible();
    await page.getByLabel('Mostrar').selectOption({ label: 'Anulados' });
    await expect(page.getByRole('row', { name: /^RC1 / })).toContainText('Anulado');
  });

  test('el anticipo a un proveedor se registra y se aplica a una compra', async ({ page }) => {
    await nav(page, 'Anticipos a proveedores').click();
    await expect(heading(page, 'Anticipos a proveedores')).toBeVisible();
    await page.getByRole('button', { name: 'Registrar anticipo' }).click();
    await page.getByLabel('Buscar proveedor').fill('aseo');
    await expect(page.getByLabel('Proveedor', { exact: true }).getByRole('option', { name: /Aseo Total SAS/ })).toBeAttached();
    await page.getByLabel('Proveedor', { exact: true }).selectOption({ label: 'Aseo Total SAS — NIT 900123456' });
    await page.getByLabel('Importe (COP)').fill('4.000');
    await page.getByLabel('Cuenta de caja o bancos').fill('110505');
    await page.getByRole('button', { name: 'Registrar anticipo' }).last().click();
    await expect(page.getByText('Anticipo CE1 registrado por 4.000,00 COP de Aseo Total SAS.')).toBeVisible();

    await page.getByRole('row', { name: /^CE1 / }).getByRole('button', { name: 'Ver y aplicar' }).click();
    await page.getByRole('button', { name: 'Aplicar a compras' }).click();
    await expect(page.getByRole('row', { name: /^FC1 / })).toContainText('11.900,00');
    await page.getByRole('button', { name: 'Repartir lo disponible' }).click();
    await page.getByRole('button', { name: 'Aplicar anticipo' }).click();
    await expect(page.getByRole('row', { name: /^AA3 / })).toContainText('FC1');
    await expect(page.getByRole('row', { name: /^CE1 / })).toContainText('Aplicado del todo');
  });

  test('sin configurar la cuenta de anticipos, el error dice dónde se configura', async ({ page }) => {
    const res = await page.request.put(`/v1/tenants/${tenantId}/invoicing/settings`, {
      data: {
        issuer: { name: 'Ferretería La Esquina SAS', taxIdType: 'NIT', taxId: '890903938', checkDigit: 8, regime: 'responsable_iva', address: { line: 'Carrera 10 # 5-20', city: 'Garzón', region: 'Huila' } },
        accounts: { receivable: '130505', income: '413505', vatPayable: '240805', payable: '220505', vatDeductible: '240810', cash: '110505' },
      },
    });
    expect(res.status()).toBe(200);
    await nav(page, 'Anticipos de clientes').click();
    await page.getByRole('button', { name: 'Registrar anticipo' }).click();
    await page.getByLabel('Buscar cliente').fill('andes');
    await expect(page.getByLabel('Cliente', { exact: true }).getByRole('option', { name: /Droguería Los Andes/ })).toBeAttached();
    await page.getByLabel('Cliente', { exact: true }).selectOption({ label: 'Droguería Los Andes — NIT 800197268' });
    await page.getByLabel('Importe (COP)').fill('1.000');
    await page.getByLabel('Cuenta de caja o bancos').fill('110505');
    await page.getByRole('button', { name: 'Registrar anticipo' }).last().click();
    await expect(page.getByText(/falta configurar la cuenta de anticipos de clientes/)).toBeVisible();
    await expect(page.getByText(/Se configura en Facturación/)).toBeVisible();
  });
});
