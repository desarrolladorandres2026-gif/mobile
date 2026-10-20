import { expect, test as base } from '@playwright/test';
import { PASSWORD, checkDesign, shot, tokenFromMail } from './helpers.js';

const OWNER = 'hugo@almacen.co';

let shared;
const test = base.extend({ page: async ({}, use) => use(shared) });
const nav = (page, name) => page.getByRole('navigation', { name: 'Principal' }).getByRole('link', { name });
const heading = (page, name) => page.getByRole('heading', { name, level: 1 });

async function bootstrap(page, request) {
  await request.post('/__reset');
  const registered = await page.request.post('/v1/auth/register', {
    data: { companyName: 'Almacén del Huila SAS', country: 'CO', currency: 'COP', ownerName: 'Hugo Paz', email: OWNER, password: PASSWORD },
  });
  expect(registered.status()).toBe(201);
  const { tenantId } = await registered.json();
  expect((await page.request.post('/v1/auth/verify-email', { data: { token: await tokenFromMail(request, OWNER) } })).status()).toBe(204);
  expect((await page.request.post('/v1/auth/login', { data: { email: OWNER, password: PASSWORD } })).status()).toBe(200);
  const base = `/v1/tenants/${tenantId}`;
  const post = async (path, data) => {
    const res = await page.request.post(`${base}${path}`, { data });
    expect(res.status(), `${path}: ${await res.text()}`).toBeLessThan(300);
  };
  await post('/accounts', { code: '1', name: 'Activo', type: 'asset', postable: false });
  await post('/accounts', { code: '110505', name: 'Caja general', type: 'asset', parentCode: '1' });
  await post('/accounts', { code: '130505', name: 'Clientes nacionales', type: 'asset', parentCode: '1' });
  await post('/accounts', { code: '2', name: 'Pasivo', type: 'liability', postable: false });
  await post('/accounts', { code: '220505', name: 'Proveedores nacionales', type: 'liability', parentCode: '2' });
  await post('/accounts', { code: '236540', name: 'Retención en la fuente por compras', type: 'liability', parentCode: '2' });
  await post('/accounts', { code: '240805', name: 'IVA por pagar', type: 'liability', parentCode: '2' });
  await post('/accounts', { code: '240810', name: 'IVA descontable', type: 'liability', parentCode: '2' });
  await post('/accounts', { code: '4', name: 'Ingresos', type: 'income', postable: false });
  await post('/accounts', { code: '413505', name: 'Venta de mercancía', type: 'income', parentCode: '4' });
  await post('/accounts', { code: '5', name: 'Gastos', type: 'expense', postable: false });
  await post('/accounts', { code: '519595', name: 'Gastos diversos', type: 'expense', parentCode: '5' });
  await post('/parties', { name: 'Aseo Total SAS', roles: ['supplier'], taxIdType: 'NIT', taxId: '900123456', checkDigit: 8 });
  const settings = await page.request.put(`${base}/invoicing/settings`, {
    data: {
      issuer: { name: 'Almacén del Huila SAS', taxIdType: 'NIT', taxId: '890903938', checkDigit: 8, regime: 'responsable_iva', address: { line: 'Carrera 10 # 5-20', city: 'Garzón', region: 'Huila' } },
      accounts: { receivable: '130505', income: '413505', vatPayable: '240805' },
    },
  });
  expect(settings.status()).toBe(200);
}

async function fillPurchase(page, docNumber) {
  await page.getByLabel('Buscar proveedor').fill('aseo');
  await expect(page.getByLabel('Proveedor', { exact: true }).getByRole('option', { name: /Aseo Total SAS/ })).toBeAttached();
  await page.getByLabel('Proveedor', { exact: true }).selectOption({ label: 'Aseo Total SAS — NIT 900123456' });
  await page.getByLabel('Número de la factura del proveedor').fill(docNumber);
  await page.getByLabel('Descripción de la línea 1').fill('Servicio de aseo mensual');
  await page.getByLabel('Precio unitario de la línea 1').fill('10.000');
  await page.getByLabel('Cuenta de la línea 1').fill('519595');
}

test.describe.serial('compras, cuentas por pagar y pagos', () => {
  test.beforeAll(async ({ browser, request }) => {
    shared = await browser.newPage({ baseURL: 'http://127.0.0.1:4100', locale: 'es-CO', viewport: { width: 1366, height: 820 } });
    await bootstrap(shared, request);
  });
  test.afterAll(async () => {
    await shared?.close();
  });

  test('sin las cuentas de compras avisa qué falta y no deja registrar', async ({ page }) => {
    await page.goto('/app/compras');
    await expect(heading(page, 'Compras')).toBeVisible();
    await expect(page.getByText('Falta configurar las compras')).toBeVisible();
    await expect(page.getByText(/la cuenta de proveedores y la cuenta de IVA descontable/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Registrar compra' })).toHaveCount(0);
    await checkDesign(page, 'compras sin configurar');
    await shot(page, 'compras-sin-configurar');
  });

  test('configurar las cuentas de compras desde Facturación', async ({ page }) => {
    await nav(page, 'Facturación').click();
    await page.getByLabel('Proveedores (para registrar compras)').fill('220505');
    await page.getByLabel('IVA descontable (para registrar compras)').fill('240810');
    await page.getByRole('button', { name: 'Guardar configuración' }).click();
    await expect(page.getByText('Configuración guardada.')).toBeVisible();
    await nav(page, 'Compras').click();
    await expect(page.getByText('Falta configurar las compras')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Registrar compra' })).toBeVisible();
  });

  test('registrar una compra con IVA y retención: la vista previa dice cuánto se paga al proveedor', async ({ page }) => {
    await page.getByRole('button', { name: 'Registrar compra' }).click();

    // Sin datos, el envío explica qué falta.
    await page.getByRole('button', { name: 'Registrar compra' }).click();
    await expect(page.getByText('Elige el proveedor.').first()).toBeVisible();
    await expect(page.getByText('Agrega al menos una línea.')).toBeVisible();

    await fillPurchase(page, 'sa-1001');
    await page.getByRole('button', { name: 'Agregar retención' }).click();
    await page.getByLabel('Nombre de la retención 1').fill('Retefuente 2,5 %');
    await page.getByLabel('Cuenta de la retención 1').fill('236540');
    await page.getByLabel('Tarifa de la retención 1').fill('2,5');
    await expect(page.getByText('Subtotal').locator('..').getByText('10.000,00').first()).toBeVisible();
    await expect(page.getByText('Total de la factura').locator('..').getByText('11.900,00')).toBeVisible();
    await expect(page.getByText('Menos Retefuente 2,5 %').locator('..').getByText('250,00')).toBeVisible();
    await expect(page.getByText('A pagar al proveedor').locator('..').getByText('11.650,00')).toBeVisible();
    await checkDesign(page, 'registrar compra');
    await shot(page, 'compras-registrar');

    await page.getByRole('button', { name: 'Registrar compra' }).click();
    await expect(page.getByText('Compra FC1 registrada: 11.650,00 por pagar a Aseo Total SAS.')).toBeVisible();
    const row = page.getByRole('row', { name: /^FC1 / });
    await expect(row).toContainText('SA-1001');
    await expect(row).toContainText('11.650,00');
    await expect(row).toContainText('Vigente');
    await checkDesign(page, 'compras');
    await shot(page, 'compras-lista');
  });

  test('la misma factura del proveedor no se registra dos veces', async ({ page }) => {
    await page.getByRole('button', { name: 'Registrar compra' }).click();
    await fillPurchase(page, 'SA-1001');
    await page.getByRole('button', { name: 'Registrar compra' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'ya está registrada' })).toBeVisible();
    await page.getByRole('button', { name: 'Cancelar' }).click();
  });

  test('una nota de proveedor reduce la deuda y devuelve la retención en proporción', async ({ page }) => {
    const row = page.getByRole('row', { name: /^FC1 / });
    await row.getByRole('button', { name: 'Acreditar' }).click();
    await expect(page.getByRole('heading', { name: 'Nota de proveedor a la compra FC1' })).toBeVisible();
    await page.getByLabel('Motivo').fill('Devolución de la mitad del servicio');
    await page.getByLabel('Número de la nota del proveedor').fill('nc-1');
    await page.getByLabel('Qué se acredita').selectOption('lines');
    await page.getByLabel('Cantidad a acreditar de la línea 1').fill('0,5');
    await checkDesign(page, 'nota de proveedor');
    await shot(page, 'compras-nota-proveedor');
    await page.getByRole('button', { name: 'Registrar nota' }).click();
    // Neto 5.000,00 + IVA 950,00 = 5.950,00; retención devuelta 125,00; la deuda baja 5.825,00.
    await expect(page.getByText('Nota NP1 registrada: la deuda con el proveedor baja 5.825,00.')).toBeVisible();
    await expect(page.getByRole('row', { name: /^FC1 / })).toContainText('acreditada en parte');
    await expect(page.getByRole('row', { name: /^FC1 / })).toContainText('5.825,00');

    await nav(page, 'Notas de proveedor').click();
    const note = page.getByRole('row', { name: /^NP1 / });
    await expect(note).toContainText('NC-1');
    await expect(note).toContainText('FC1');
    await expect(note).toContainText('5.950,00');
    await checkDesign(page, 'notas de proveedor');
    await shot(page, 'notas-de-proveedor');
  });

  test('cuentas por pagar: la cartera por edades y el pago desde ella', async ({ page }) => {
    await nav(page, 'Cuentas por pagar').click();
    await expect(heading(page, 'Cuentas por pagar')).toBeVisible();
    const supplier = page.getByRole('row', { name: /Aseo Total SAS/ });
    await expect(supplier).toContainText('5.825,00');
    await expect(page.getByRole('row', { name: /^Total/ })).toContainText('5.825,00');
    await checkDesign(page, 'cuentas por pagar');
    await shot(page, 'cuentas-por-pagar');

    await supplier.getByRole('button', { name: 'Pagar' }).click();
    await expect(page.getByRole('heading', { name: 'Registrar pago' })).toBeVisible();
    await page.getByRole('button', { name: 'Registrar pago' }).click();
    await expect(page.getByText('Indica cuánto se paga en al menos una factura.')).toBeVisible();
    await page.getByLabel('Importe a pagar de la compra FC1').fill('5.825,01');
    await expect(page.getByText('Supera el saldo de 5.825,00.')).toBeVisible();
    await page.getByRole('row', { name: /FC1/ }).getByRole('button', { name: 'Todo' }).click();
    await expect(page.getByLabel('Importe a pagar de la compra FC1')).toHaveValue('5.825,00');
    await page.getByLabel('Cuenta de caja o bancos').fill('110505');
    await expect(page.getByText('Total del pago: 5.825,00')).toBeVisible();
    await checkDesign(page, 'registrar pago');
    await page.getByRole('button', { name: 'Registrar pago' }).click();
    await expect(page.getByText('Comprobante CE1 registrado por 5.825,00.')).toBeVisible();
    await expect(page.getByText('No hay saldos por pagar.')).toBeVisible();
  });

  test('pagos: anular el comprobante devuelve la deuda', async ({ page }) => {
    await nav(page, 'Pagos').click();
    const row = page.getByRole('row', { name: /^CE1 / });
    await expect(row).toContainText('Aseo Total SAS');
    await expect(row).toContainText('5.825,00');
    await row.getByRole('button', { name: 'Ver detalle' }).click();
    await expect(page.getByText(/Cuenta de caja o bancos 110505/)).toBeVisible();
    await checkDesign(page, 'pagos a proveedores');
    await shot(page, 'pagos');
    await row.getByRole('button', { name: 'Anular' }).click();
    await page.getByRole('button', { name: 'Sí, anular' }).click();
    await expect(page.getByText('Comprobante CE1 anulado: la deuda volvió a sus facturas.')).toBeVisible();
    await expect(page.getByRole('row', { name: /^CE1 / })).toContainText('Anulado');
    await nav(page, 'Cuentas por pagar').click();
    await expect(page.getByRole('row', { name: /^Total/ })).toContainText('5.825,00');
  });

  test('anular la nota y luego la compra deja todo en cero', async ({ page }) => {
    await nav(page, 'Notas de proveedor').click();
    await page.getByRole('row', { name: /^NP1 / }).getByRole('button', { name: 'Anular' }).click();
    await page.getByRole('button', { name: 'Sí, anular' }).click();
    await expect(page.getByText(/Nota NP1 anulada/)).toBeVisible();

    await nav(page, 'Cuentas por pagar').click();
    await expect(page.getByRole('row', { name: /^Total/ })).toContainText('11.650,00');

    await nav(page, 'Compras').click();
    const row = page.getByRole('row', { name: /^FC1 / });
    await expect(row.getByRole('button', { name: 'Anular' })).toBeVisible();
    await row.getByRole('button', { name: 'Anular' }).click();
    await page.getByRole('button', { name: 'Sí, anular' }).click();
    await expect(page.getByText('Compra FC1 anulada.')).toBeVisible();
    await expect(page.getByRole('row', { name: /^FC1 / })).toContainText('Anulada');
    await nav(page, 'Cuentas por pagar').click();
    await expect(page.getByText('No hay saldos por pagar.')).toBeVisible();
  });

  test('los asientos de compras y pagos no ofrecen reversarse a mano', async ({ page }) => {
    await nav(page, 'Asientos').click();
    await expect(page.getByRole('row', { name: /FC/ }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Revertir' })).toHaveCount(0);
  });

  test('en el teléfono la lista y el formulario de compra no se salen de la pantalla', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto('/app/compras');
    await expect(page.getByRole('table')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.getByRole('button', { name: 'Registrar compra' }).click();
    await page.getByRole('button', { name: 'Agregar retención' }).click();
    await expect(page.getByLabel('Nombre de la retención 1')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await shot(page, 'telefono-compras');
  });
});
