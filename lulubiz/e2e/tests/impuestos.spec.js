import { expect, test as base } from '@playwright/test';
import { PASSWORD, checkDesign, shot, tokenFromMail, nav } from './helpers.js';

const OWNER = 'hector@comercial.co';
const DAY_MS = 86_400_000;
const iso = (offset = 0) => new Date(Date.now() + offset * DAY_MS).toISOString().slice(0, 10);
const YEAR = new Date().getUTCFullYear();

let shared;
const test = base.extend({ page: async ({}, use) => use(shared) });
const heading = (page, name) => page.getByRole('heading', { name, level: 1 });

async function bootstrap(page, request) {
  await request.post('/__reset');
  const registered = await page.request.post('/v1/auth/register', {
    data: { companyName: 'Comercial del Centro SAS', country: 'CO', currency: 'COP', ownerName: 'Héctor Mejía', email: OWNER, password: PASSWORD },
  });
  expect(registered.status()).toBe(201);
  const { tenantId } = await registered.json();
  expect((await page.request.post('/v1/auth/verify-email', { data: { token: await tokenFromMail(request, OWNER) } })).status()).toBe(204);
  expect((await page.request.post('/v1/auth/login', { data: { email: OWNER, password: PASSWORD } })).status()).toBe(200);
  const base = `/v1/tenants/${tenantId}`;
  let n = 0;
  const post = async (path, data) => {
    const res = await page.request.post(`${base}${path}`, { data, headers: { 'idempotency-key': `impuestos-${(n += 1)}-aaaaaaaa` } });
    expect(res.status(), `${path}: ${await res.text()}`).toBeLessThan(300);
    return res.json();
  };
  for (const a of [
    { code: '1', name: 'Activo', type: 'asset', postable: false },
    { code: '110505', name: 'Caja', type: 'asset', parentCode: '1' },
    { code: '130505', name: 'Clientes', type: 'asset', parentCode: '1' },
    { code: '135515', name: 'Saldo a favor de IVA', type: 'asset', parentCode: '1' },
    { code: '135595', name: 'Retención en la fuente a favor', type: 'asset', parentCode: '1' },
    { code: '2', name: 'Pasivo', type: 'liability', postable: false },
    { code: '220505', name: 'Proveedores', type: 'liability', parentCode: '2' },
    { code: '236540', name: 'Retención en la fuente por compras', type: 'liability', parentCode: '2' },
    { code: '240805', name: 'IVA por pagar', type: 'liability', parentCode: '2' },
    { code: '240810', name: 'IVA descontable', type: 'liability', parentCode: '2' },
    { code: '241005', name: 'IVA por pagar a la DIAN', type: 'liability', parentCode: '2' },
    { code: '4', name: 'Ingresos', type: 'income', postable: false },
    { code: '413505', name: 'Ventas', type: 'income', parentCode: '4' },
    { code: '5', name: 'Gastos', type: 'expense', postable: false },
    { code: '519595', name: 'Gastos diversos', type: 'expense', parentCode: '5' },
  ]) await post('/accounts', a);
  const saved = await page.request.put(`${base}/invoicing/settings`, {
    data: {
      issuer: { name: 'Comercial del Centro SAS', taxIdType: 'NIT', taxId: '890903938', checkDigit: 8, regime: 'responsable_iva', address: { line: 'Carrera 10 # 5-20', city: 'Garzón', region: 'Huila' } },
      accounts: { receivable: '130505', income: '413505', vatPayable: '240805', payable: '220505', vatDeductible: '240810', cash: '110505' },
    },
  });
  expect(saved.status()).toBe(200);
  for (const [docType, prefix] of [['invoice', 'FE'], ['credit_note', 'NC']]) {
    await post('/invoicing/resolutions', { docType, prefix, number: '18760000001', from: 1, to: 100, validFrom: `${YEAR - 1}-01-01`, validTo: `${YEAR + 1}-12-31` });
  }
  const customer = (await post('/parties', { name: 'Droguería Los Andes', roles: ['customer'], taxIdType: 'NIT', taxId: '800197268', checkDigit: 4 }))._id;
  const supplier = (await post('/parties', { name: 'Aseo Total SAS', roles: ['supplier'], taxIdType: 'NIT', taxId: '900123456', checkDigit: 8 }))._id;
  const a = await post('/invoices', { customerId: customer, issueDate: iso(-2), paymentMethod: 'cash', lines: [{ description: 'Equipos', quantity: 1000, unitPrice: 1_000_000, vatBps: 1900 }, { description: 'Alimentos', quantity: 1000, unitPrice: 500_000, vatBps: 500 }] });
  await post('/invoices', { customerId: customer, issueDate: iso(-1), paymentMethod: 'cash', lines: [{ description: 'Libros', quantity: 1000, unitPrice: 300_000, vatBps: 0 }] });
  await post('/invoices', { customerId: customer, issueDate: iso(-3), paymentMethod: 'credit', dueDate: iso(30), lines: [{ description: 'Mantenimiento', quantity: 1000, unitPrice: 1_000_000, vatBps: 1900 }] });
  await post(`/invoices/${a.invoice._id}/credit-notes`, { reasonCode: '3', lines: [{ lineIndex: 0, quantity: 250 }] });
  const p = await post('/purchases', { supplierId: supplier, supplierDocNumber: 'SA-1', issueDate: iso(-2), lines: [{ description: 'Aseo', quantity: 1000, unitPrice: 2_000_000, vatBps: 1900, accountId: '519595' }], withholdings: [{ name: 'Retefuente 2,5 %', accountId: '236540', basis: 'subtotal', rateBps: 250 }] });
  await post(`/purchases/${p.purchase._id}/credit-notes`, { reason: 'Devolución', supplierDocNumber: 'NC-1', lines: [{ lineIndex: 0, quantity: 500 }] });
}

test.describe.serial('impuestos', () => {
  test.beforeAll(async ({ browser, request }) => {
    shared = await browser.newPage({ baseURL: 'http://127.0.0.1:4100', locale: 'es-CO', viewport: { width: 1366, height: 820 } });
    await bootstrap(shared, request);
  });
  test.afterAll(async () => {
    await shared?.close();
  });

  test('el informe de IVA separa generado y descontable y cuadra con el libro', async ({ page }) => {
    await page.goto('/app/impuestos');
    await expect(heading(page, 'Impuestos')).toBeVisible();
    await page.getByLabel('Desde').first().fill(iso(-5));
    await page.getByLabel('Hasta').first().fill(iso(0));
    await page.getByRole('button', { name: 'Ver IVA' }).click();
    await expect(page.getByRole('row', { name: /Tarifa 19 %/ }).first()).toContainText('3.325,00');
    await expect(page.getByRole('row', { name: /Tarifa 5 %/ })).toContainText('250,00');
    await expect(page.getByRole('row', { name: /^Total/ }).first()).toContainText('3.575,00');
    await expect(page.getByText(/IVA por pagar: 1\.675,00/)).toBeVisible();
    await expect(page.getByText('Cuadra con los documentos.')).toHaveCount(2);
    await shot(page, 'impuestos-iva');
    await checkDesign(page, 'informe de IVA');
  });

  test('cierra el IVA del rango con la cuenta de IVA por pagar y lo anula', async ({ page }) => {
    await page.getByRole('button', { name: 'Cerrar el IVA de este rango' }).click();
    await expect(page.getByText('IVA generado en el libro')).toBeVisible();
    await page.getByRole('button', { name: 'Cerrar el IVA del rango' }).click();
    await expect(page.getByText('Indica la cuenta de IVA por pagar a la DIAN.')).toBeVisible();
    await page.getByLabel('Cuenta de IVA por pagar a la DIAN').fill('241005');
    await page.getByRole('button', { name: 'Cerrar el IVA del rango' }).click();
    await expect(page.getByText(/Cierre CI\d+ registrado\./)).toBeVisible();
    const row = page.getByRole('row', { name: /CI\d+ .*Vigente/ });
    await expect(row).toContainText('Por pagar 1.675,00');
    await checkDesign(page, 'cierre de IVA');
    await row.getByRole('button', { name: 'Anular' }).click();
    await expect(page.getByText(/Cierre CI\d+ anulado\./)).toBeVisible();
    await expect(page.getByRole('row', { name: /CI\d+ .*Anulado/ })).toBeVisible();
  });

  test('un cobro con la retención que practicó el cliente baja la cartera y no entra como dinero', async ({ page }) => {
    await nav(page, 'Cartera').click();
    await page.getByRole('row', { name: /Droguería Los Andes/ }).getByRole('button', { name: 'Cobrar' }).click();
    await page.getByRole('row', { name: /FE3/ }).getByRole('button', { name: 'Todo' }).click();
    await page.getByLabel('Cuenta de caja o bancos').fill('110505');
    await page.getByRole('button', { name: 'Agregar retención' }).click();
    await page.getByLabel('Nombre de la retención 1').fill('Retefuente 2,5 %');
    await page.getByLabel('Cuenta de la retención 1').fill('135595');
    await page.getByLabel('Valor de la retención 1').fill('250,00');
    await expect(page.getByText(/Total del recibo: 11\.900,00\. Retenciones: 250,00\. Entra a caja o bancos: 11\.650,00\./)).toBeVisible();
    await checkDesign(page, 'cobro con retención');
    await page.getByRole('button', { name: 'Registrar cobro' }).click();
    await expect(page.getByText('Recibo RC1 registrado por 11.900,00.')).toBeVisible();
  });

  test('las retenciones salen por concepto y por proveedor, y el certificado se imprime', async ({ page }) => {
    await nav(page, 'Impuestos').click();
    await page.getByLabel('Desde').nth(1).fill(`${YEAR}-01-01`);
    await page.getByLabel('Hasta').nth(1).fill(iso(0));
    await page.getByRole('button', { name: 'Ver retenciones' }).click();
    await expect(page.getByRole('row', { name: /Retefuente 2,5 % · cuenta 236540/ })).toContainText('250,00');
    await expect(page.getByRole('row', { name: /Aseo Total SAS/ }).first()).toContainText('250,00');
    await expect(page.getByRole('row', { name: /Retefuente 2,5 % · cuenta 135595/ })).toContainText('250,00');
    await expect(page.getByText(/Por cliente: Droguería Los Andes 250,00/)).toBeVisible();
    await page.getByLabel('Proveedor', { exact: true }).fill('Aseo Total SAS — NIT 900123456');
    await page.getByRole('button', { name: 'Ver certificado' }).click();
    const cert = page.getByRole('region', { name: 'Certificado de retenciones de Aseo Total SAS' });
    await expect(cert).toContainText('certifica que practicó');
    await expect(cert).toContainText('Total retenido: 250,00');
    await shot(page, 'impuestos-retenciones');
    await checkDesign(page, 'retenciones y certificado');
  });

  test('el ICA toma el ingreso neto del libro, excluye lo que se indique y valida la tarifa', async ({ page }) => {
    await nav(page, 'Impuestos').click();
    await page.getByLabel('Desde').nth(2).fill(`${YEAR}-01-01`);
    await page.getByLabel('Hasta').nth(2).fill(iso(0));
    await page.getByRole('button', { name: 'Calcular el ICA' }).click();
    await expect(page.getByText('Escribe la tarifa por mil, entre 0 y 100 (por ejemplo 9,66).')).toBeVisible();
    await page.getByLabel('Tarifa por mil').fill('9,66');
    await page.getByRole('button', { name: 'Calcular el ICA' }).click();
    await expect(page.getByRole('row', { name: /413505 · Ventas/ })).toContainText('25.500,00');
    await expect(page.getByText('ICA a 9,66 por mil')).toBeVisible();
    await expect(page.locator('dd', { hasText: '246,33' })).toBeVisible();
    await page.getByLabel('Cuentas de ingreso excluidas').fill('413505');
    await page.getByRole('button', { name: 'Calcular el ICA' }).click();
    await expect(page.getByRole('row', { name: /413505 · Ventas/ })).toContainText('Excluida');
    await expect(page.locator('dd', { hasText: '0,00' }).last()).toBeVisible();
    await shot(page, 'impuestos-ica');
    await checkDesign(page, 'informe de ICA');
  });

  test('la base de exógena suma por tercero, neta de notas, y el tope oculta terceros sin tocar los totales', async ({ page }) => {
    await nav(page, 'Impuestos').click();
    await page.getByLabel('Año').nth(1).fill(String(YEAR));
    await page.getByRole('button', { name: 'Ver la base de exógena' }).click();
    await expect(page.getByRole('row', { name: /Droguería Los Andes — NIT 800197268/ }).first()).toContainText('25.500,00');
    await expect(page.getByRole('row', { name: /Aseo Total SAS — NIT 900123456/ }).first()).toContainText('10.000,00');
    await expect(page.getByText(/Ingresos totales: 25.500,00/)).toBeVisible();
    await page.getByLabel('Tope mínimo por tercero').fill('300.000,00');
    await page.getByRole('button', { name: 'Ver la base de exógena' }).click();
    await expect(page.getByText('Sin ingresos con terceros.')).toBeVisible();
    await expect(page.getByText(/Ingresos totales: 25.500,00/)).toBeVisible();
    await shot(page, 'impuestos-exogena');
    await checkDesign(page, 'base de exógena');
  });
});
