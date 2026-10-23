import { expect, test as base } from '@playwright/test';
import { PASSWORD, checkDesign, shot, tokenFromMail, nav } from './helpers.js';

const OWNER = 'rosa@distribuidora.co';
const day = (offset) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const NEXT_YEAR = `${new Date().getUTCFullYear() + 1}-12-31`;
const LAST_YEAR = `${new Date().getUTCFullYear() - 1}-01-01`;

let shared;
const test = base.extend({ page: async ({}, use) => use(shared) });
let counter = 0;

async function bootstrap(page, request) {
  await request.post('/__reset');
  const registered = await page.request.post('/v1/auth/register', {
    data: { companyName: 'Distribuidora Central SAS', country: 'CO', currency: 'COP', ownerName: 'Rosa Gil', email: OWNER, password: PASSWORD },
  });
  expect(registered.status()).toBe(201);
  const { tenantId } = await registered.json();
  expect((await page.request.post('/v1/auth/verify-email', { data: { token: await tokenFromMail(request, OWNER) } })).status()).toBe(204);
  expect((await page.request.post('/v1/auth/login', { data: { email: OWNER, password: PASSWORD } })).status()).toBe(200);
  const base = `/v1/tenants/${tenantId}`;
  const post = async (path, data, headers = {}) => {
    const res = await page.request.post(`${base}${path}`, { data, headers });
    expect(res.status(), `${path}: ${await res.text()}`).toBeLessThan(300);
    return res.json();
  };
  await post('/accounts', { code: '1', name: 'Activo', type: 'asset', postable: false });
  await post('/accounts', { code: '110505', name: 'Caja general', type: 'asset', parentCode: '1' });
  await post('/accounts', { code: '130505', name: 'Clientes nacionales', type: 'asset', parentCode: '1' });
  await post('/accounts', { code: '2', name: 'Pasivo', type: 'liability', postable: false });
  await post('/accounts', { code: '240805', name: 'IVA por pagar', type: 'liability', parentCode: '2' });
  await post('/accounts', { code: '4', name: 'Ingresos', type: 'income', postable: false });
  await post('/accounts', { code: '413505', name: 'Venta de mercancía', type: 'income', parentCode: '4' });
  const andes = await post('/parties', { name: 'Droguería Los Andes', roles: ['customer'], taxIdType: 'NIT', taxId: '800197268', checkDigit: 4 });
  const sur = await post('/parties', { name: 'Ferretería El Sur', roles: ['customer'], taxIdType: 'NIT', taxId: '890903938', checkDigit: 8 });
  const put = await page.request.put(`${base}/invoicing/settings`, {
    data: {
      issuer: { name: 'Distribuidora Central SAS', taxIdType: 'NIT', taxId: '890903938', checkDigit: 8, regime: 'responsable_iva', address: { line: 'Carrera 10 # 5-20', city: 'Garzón', region: 'Huila' } },
      accounts: { receivable: '130505', income: '413505', vatPayable: '240805' },
    },
  });
  expect(put.status()).toBe(200);
  for (const [docType, prefix] of [['invoice', 'FE'], ['credit_note', 'NC']]) {
    await post('/invoicing/resolutions', { docType, prefix, number: '18760000001', from: 1, to: 100, validFrom: LAST_YEAR, validTo: NEXT_YEAR });
  }
  const invoice = (customer, amount, due) =>
    post(
      '/invoices',
      { customerId: customer._id, issueDate: day(-120), dueDate: due, paymentMethod: 'credit', lines: [{ description: 'Mercancía', quantity: 1000, unitPrice: amount, vatBps: 0 }] },
      { 'idempotency-key': `cartera-${(counter += 1)}-aaaaaaaa` },
    );
  await invoice(andes, 10_000_000, day(-45)); // 100.000,00 vencida hace 45 días
  await invoice(andes, 5_000_000, day(20)); // 50.000,00 vigente
  await invoice(sur, 3_000_000, day(-100)); // 30.000,00 vencida hace 100 días
}

test.describe.serial('cartera y recibos de caja', () => {
  test.beforeAll(async ({ browser, request }) => {
    shared = await browser.newPage({ baseURL: 'http://127.0.0.1:4100', locale: 'es-CO', viewport: { width: 1366, height: 820 } });
    await bootstrap(shared, request);
  });
  test.afterAll(async () => {
    await shared?.close();
  });

  test('la cartera por edades reparte lo que deben los clientes', async ({ page }) => {
    await page.goto('/app/cartera');
    await expect(page.getByRole('heading', { name: 'Cartera', level: 1 })).toBeVisible();
    const andes = page.getByRole('row', { name: /Droguería Los Andes/ });
    await expect(andes).toContainText('50.000,00'); // vigente
    await expect(andes).toContainText('100.000,00'); // 31-60 días
    await expect(andes).toContainText('150.000,00'); // total
    await expect(page.getByRole('row', { name: /Ferretería El Sur/ })).toContainText('30.000,00');
    await expect(page.getByRole('row', { name: /^Total/ })).toContainText('180.000,00');
    await checkDesign(page, 'cartera por edades');
    await shot(page, 'cartera-edades');
  });

  test('registrar un cobro desde la cartera: valida, aplica a dos facturas y actualiza la cartera', async ({ page }) => {
    await page.getByRole('row', { name: /Droguería Los Andes/ }).getByRole('button', { name: 'Cobrar' }).click();
    await expect(page.getByRole('heading', { name: 'Registrar cobro' })).toBeVisible();
    await expect(page.getByLabel('Cliente', { exact: true })).toHaveValue(/.+/);
    await expect(page.getByRole('row', { name: /FE1/ })).toBeVisible();

    // Sin cuenta ni importes, el envío explica qué falta.
    await page.getByRole('button', { name: 'Registrar cobro' }).click();
    await expect(page.getByText('Indica cuánto se cobra en al menos una factura.')).toBeVisible();
    await expect(page.getByText('Indica la cuenta de caja o bancos donde entra el dinero.')).toBeVisible();

    // Un importe mayor que el saldo se rechaza en la fila.
    await page.getByLabel('Importe a cobrar de la factura FE2').fill('50.000,01');
    await expect(page.getByText('Supera el saldo de 50.000,00.')).toBeVisible();

    await page.getByRole('row', { name: /FE1/ }).getByRole('button', { name: 'Todo' }).click();
    await expect(page.getByLabel('Importe a cobrar de la factura FE1')).toHaveValue('100.000,00');
    await page.getByLabel('Importe a cobrar de la factura FE2').fill('20.000');
    await page.getByLabel('Cuenta de caja o bancos').fill('110505');
    await expect(page.getByText('Caja general').locator('visible=true')).toBeVisible();
    await expect(page.getByText('Total del recibo: 120.000,00')).toBeVisible();
    await checkDesign(page, 'registrar cobro');
    await shot(page, 'cartera-registrar-cobro');

    await page.getByRole('button', { name: 'Registrar cobro' }).click();
    await expect(page.getByText('Recibo RC1 registrado por 120.000,00.')).toBeVisible();
    const andes = page.getByRole('row', { name: /Droguería Los Andes/ });
    await expect(andes).toContainText('30.000,00'); // lo que queda de FE2
    await expect(andes).not.toContainText('150.000,00');
    await expect(page.getByRole('row', { name: /^Total/ })).toContainText('60.000,00');
    await shot(page, 'cartera-despues-del-cobro');
  });

  test('las facturas muestran lo que falta por cobrar', async ({ page }) => {
    await nav(page, 'Facturas').click();
    await expect(page.getByRole('columnheader', { name: 'Por cobrar' })).toBeVisible();
    await expect(page.getByRole('row', { name: /^FE1 / })).toContainText('0,00');
    await expect(page.getByRole('row', { name: /^FE2 / })).toContainText('30.000,00');
    await checkDesign(page, 'facturas con saldo');
  });

  test('los asientos que genera un documento no ofrecen reversarse', async ({ page }) => {
    await nav(page, 'Asientos').click();
    await expect(page.getByRole('row', { name: /RC/ }).first()).toBeVisible();
    await expect(page.getByRole('row', { name: /RC/ }).first().getByRole('button', { name: 'Revertir' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Revertir' })).toHaveCount(0);
  });

  test('anular el recibo devuelve el saldo a las facturas', async ({ page }) => {
    await nav(page, 'Recibos de caja').click();
    const row = page.getByRole('row', { name: /^RC1 / });
    await expect(row).toContainText('Droguería Los Andes');
    await expect(row).toContainText('120.000,00');
    await expect(row).toContainText('Vigente');
    await row.getByRole('button', { name: 'Ver detalle' }).click();
    await expect(page.getByText(/Cuenta de caja o bancos 110505/)).toBeVisible();
    await checkDesign(page, 'recibos de caja');
    await shot(page, 'recibos-de-caja');

    await row.getByRole('button', { name: 'Anular' }).click();
    await page.getByRole('button', { name: 'Sí, anular' }).click();
    await expect(page.getByText('Recibo RC1 anulado: el saldo volvió a sus facturas.')).toBeVisible();
    await expect(page.getByRole('row', { name: /^RC1 / })).toContainText('Anulado');
    await expect(page.getByRole('row', { name: /^RC1 / }).getByRole('button', { name: 'Anular' })).toHaveCount(0);

    await nav(page, 'Cartera').click();
    await expect(page.getByRole('row', { name: /^Total/ })).toContainText('180.000,00');
  });

  test('en el teléfono la cartera y el cobro no se salen de la pantalla', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto('/app/cartera');
    await expect(page.getByRole('table')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.getByRole('button', { name: 'Registrar cobro' }).click();
    await expect(page.getByLabel('Fecha del cobro')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await shot(page, 'telefono-cartera');
  });
});
