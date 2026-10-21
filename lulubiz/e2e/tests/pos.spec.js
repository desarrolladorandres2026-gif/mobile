import { expect, test as base } from '@playwright/test';
import { PASSWORD, checkDesign, shot, tokenFromMail } from './helpers.js';

const OWNER = 'rosa@minimercado.co';
const CASHIER = 'camilo@minimercado.co';

let shared;
let tenantId;
const test = base.extend({ page: async ({}, use) => use(shared) });
const nav = (page, name) => page.getByRole('navigation', { name: 'Principal' }).getByRole('link', { name });
const heading = (page, name) => page.getByRole('heading', { name, level: 1 });

async function bootstrap(page, request) {
  await request.post('/__reset');
  const registered = await page.request.post('/v1/auth/register', {
    data: { companyName: 'Minimercado La Esquina SAS', country: 'CO', currency: 'COP', ownerName: 'Rosa Gil', email: OWNER, password: PASSWORD },
  });
  expect(registered.status()).toBe(201);
  tenantId = (await registered.json()).tenantId;
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
  await post('/accounts', { code: '112005', name: 'Datáfono por cobrar', type: 'asset', parentCode: '1' });
  await post('/accounts', { code: '130505', name: 'Clientes nacionales', type: 'asset', parentCode: '1' });
  await post('/accounts', { code: '143505', name: 'Mercancías no fabricadas', type: 'asset', parentCode: '1' });
  await post('/accounts', { code: '2', name: 'Pasivo', type: 'liability', postable: false });
  await post('/accounts', { code: '240805', name: 'IVA por pagar', type: 'liability', parentCode: '2' });
  await post('/accounts', { code: '3', name: 'Patrimonio', type: 'equity', postable: false });
  await post('/accounts', { code: '310505', name: 'Capital social', type: 'equity', parentCode: '3' });
  await post('/accounts', { code: '4', name: 'Ingresos', type: 'income', postable: false });
  await post('/accounts', { code: '413505', name: 'Venta de mercancía', type: 'income', parentCode: '4' });
  await post('/accounts', { code: '429595', name: 'Sobrantes de caja', type: 'income', parentCode: '4' });
  await post('/accounts', { code: '5', name: 'Gastos', type: 'expense', postable: false });
  await post('/accounts', { code: '530595', name: 'Faltantes de caja', type: 'expense', parentCode: '5' });
  await post('/accounts', { code: '6', name: 'Costos de ventas', type: 'cost', postable: false });
  await post('/accounts', { code: '613505', name: 'Costo de mercancía vendida', type: 'cost', parentCode: '6' });
  const settings = await page.request.put(`${base}/invoicing/settings`, {
    data: {
      issuer: { name: 'Minimercado La Esquina SAS', taxIdType: 'NIT', taxId: '890903938', checkDigit: 8, regime: 'responsable_iva', address: { line: 'Carrera 10 # 5-20', city: 'Garzón', region: 'Huila' } },
      accounts: { receivable: '130505', income: '413505', vatPayable: '240805' },
    },
  });
  expect(settings.status()).toBe(200);
  const item = await post('/items', { sku: 'ARROZ-1', name: 'Arroz 500 g', type: 'goods', unit: 'und', inventoryAccount: '143505', cogsAccount: '613505', price: 25_000, vatBps: 1900 });
  await post('/stock/adjustments', { itemId: item._id, date: new Date().toISOString().slice(0, 10), direction: 'in', quantity: 10_000, unitCost: 10_000, counterAccount: '310505', reason: 'Saldo inicial' }, { 'idempotency-key': 'saldo-inicial-aaaaaaaa' });
}

test.describe.serial('punto de venta de punta a punta', () => {
  test.beforeAll(async ({ browser, request }) => {
    shared = await browser.newPage({ baseURL: 'http://127.0.0.1:4100', locale: 'es-CO', viewport: { width: 1366, height: 820 } });
    await bootstrap(shared, request);
  });
  test.afterAll(async () => {
    await shared?.close();
  });

  test('sin cajas avisa y lleva a crearlas', async ({ page }) => {
    await page.goto('/app/vender');
    await expect(heading(page, 'Venta de mostrador')).toBeVisible();
    await expect(page.getByText('No hay cajas')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Cajas' }).last()).toBeVisible();
    await checkDesign(page, 'vender sin cajas');
    await shot(page, 'pos-sin-cajas');
  });

  test('crear una caja con sus cuentas', async ({ page }) => {
    await nav(page, 'Cajas').click();
    await expect(heading(page, 'Cajas')).toBeVisible();
    await page.getByRole('button', { name: 'Nueva caja' }).click();
    await page.getByRole('button', { name: 'Crear caja' }).click();
    await expect(page.getByText('Escribe el código de la caja.')).toBeVisible();
    await page.getByLabel('Código', { exact: true }).fill('caja1');
    await page.getByLabel('Nombre', { exact: true }).fill('Caja del mostrador');
    await page.getByRole('button', { name: 'Crear caja' }).click();
    await expect(page.getByText('La caja necesita su cuenta de efectivo.')).toBeVisible();
    await page.getByLabel('Cuenta de efectivo').fill('110505');
    await page.getByLabel('Cuenta de tarjeta (opcional)').fill('112005');
    await page.getByLabel('Cuenta de faltantes (opcional)').fill('530595');
    await page.getByLabel('Cuenta de sobrantes (opcional)').fill('429595');
    await checkDesign(page, 'nueva caja');
    await shot(page, 'pos-nueva-caja');
    await page.getByRole('button', { name: 'Crear caja' }).click();
    await expect(page.getByText('Caja CAJA1 creada.')).toBeVisible();
    const row = page.getByRole('row', { name: /^CAJA1 / });
    await expect(row).toContainText('Caja del mostrador');
    await expect(row).toContainText('efectivo 110505');
    await expect(row).toContainText('Activa');
  });

  test('abrir el turno con el efectivo inicial', async ({ page }) => {
    await nav(page, 'Vender').click();
    await expect(page.getByText('La caja CAJA1 no tiene un turno abierto')).toBeVisible();
    await page.getByLabel('Efectivo inicial (COP)').fill('50.000');
    await checkDesign(page, 'abrir turno');
    await shot(page, 'pos-abrir-turno');
    await page.getByRole('button', { name: 'Abrir turno' }).click();
    await expect(page.getByText(/turno abierto desde .*: 0 ventas por 0,00 COP\. Efectivo que debe haber: 50\.000,00\./)).toBeVisible();
    await expect(page.getByText('Agrega artículos para empezar la venta.')).toBeVisible();
  });

  test('cobrar un artículo con pago mixto y cambio', async ({ page }) => {
    await page.getByRole('button', { name: /^Cobrar/ }).click();
    await expect(page.getByText('Agrega al menos un artículo o concepto.')).toBeVisible();

    await page.getByRole('button', { name: 'Agregar', exact: true }).click();
    await expect(page.getByText('Escribe el código o el nombre del artículo.')).toBeVisible();
    await page.getByLabel('Artículo', { exact: true }).fill('ARROZ-1');
    await expect(page.getByText('hay 10 UND')).toBeVisible();
    await page.getByRole('button', { name: 'Agregar', exact: true }).click();
    await expect(page.getByRole('row', { name: /Arroz 500 g/ })).toContainText('250,00');
    await page.getByLabel('Cantidad de la línea 1').fill('2');
    await expect(page.getByText('Total a cobrar').locator('..').getByText('595,00')).toBeVisible();

    await page.getByLabel('Tarjeta (COP)').fill('100');
    await expect(page.getByText('Efectivo a cobrar').locator('..').getByText('495,00')).toBeVisible();
    await page.getByLabel('Efectivo recibido (opcional)').fill('500');
    await expect(page.getByText('Cambio: 5,00')).toBeVisible();
    await checkDesign(page, 'venta en curso');
    await shot(page, 'pos-venta');
    await page.getByRole('button', { name: /^Cobrar/ }).click();
    await expect(page.getByText('Venta CAJA1-000001 registrada por 595,00 COP. Cambio: 5,00.')).toBeVisible();
    await expect(page.getByText('Agrega artículos para empezar la venta.')).toBeVisible();
    await expect(page.getByText(/1 venta por 595,00 COP\. Efectivo que debe haber: 50\.495,00\./)).toBeVisible();
  });

  test('un concepto libre se cobra en efectivo', async ({ page }) => {
    await page.getByRole('button', { name: 'Agregar concepto libre' }).click();
    await page.getByLabel('Descripción de la línea 1').fill('Armado de canasta');
    await page.getByLabel('Precio unitario de la línea 1').fill('10.000');
    await expect(page.getByText('Total a cobrar').locator('..').getByText('11.900,00')).toBeVisible();
    await page.getByRole('button', { name: /^Cobrar/ }).click();
    await expect(page.getByText('Venta CAJA1-000002 registrada por 11.900,00 COP.')).toBeVisible();
  });

  test('la venta de más artículos de los que hay se rechaza con el motivo', async ({ page }) => {
    await page.getByLabel('Artículo', { exact: true }).fill('ARROZ-1');
    await expect(page.getByText('hay 8 UND')).toBeVisible();
    await page.getByRole('button', { name: 'Agregar', exact: true }).click();
    await page.getByLabel('Cantidad de la línea 1').fill('50');
    await page.getByRole('button', { name: /^Cobrar/ }).click();
    await expect(page.getByText(/no hay existencias suficientes de ARROZ-1 \(hay 8, se piden 50\)/)).toBeVisible();
    await page.getByRole('button', { name: 'Vaciar' }).click();
  });

  test('turnos y ventas: se ve lo vendido y se anula una venta con motivo', async ({ page }) => {
    await nav(page, 'Turnos y ventas').click();
    await expect(heading(page, 'Turnos y ventas')).toBeVisible();
    const row = page.getByRole('row', { name: /^CAJA1 / }).first();
    await expect(row).toContainText('Abierto');
    await expect(row).toContainText('12.495,00');
    await row.getByRole('button', { name: 'Ver ventas' }).click();
    await expect(page.getByRole('row', { name: /^CAJA1-000001 / })).toContainText('Tarjeta 100,00');
    await checkDesign(page, 'turnos y ventas');
    await shot(page, 'pos-turnos');

    await page.getByRole('row', { name: /^CAJA1-000001 / }).getByRole('button', { name: 'Anular' }).click();
    await page.getByRole('button', { name: 'Sí, anular' }).click();
    await expect(page.getByText('Escribe el motivo de la anulación.')).toBeVisible();
    await page.getByLabel('Motivo de la anulación de CAJA1-000001').fill('El cliente se arrepintió');
    await page.getByRole('button', { name: 'Sí, anular' }).click();
    await expect(page.getByText('Venta CAJA1-000001 anulada.')).toBeVisible();
    await expect(page.getByRole('row', { name: /^CAJA1-000001 / })).toContainText('Anulada');
    await expect(page.getByRole('row', { name: /^CAJA1 / }).first()).toContainText('(1 anuladas)');

    // La mercancía de la venta anulada volvió al inventario y el libro sigue cuadrado.
    await nav(page, 'Existencias').click();
    await expect(page.getByRole('row', { name: /^ARROZ-1 / }).first()).toContainText('10 UND');
    await expect(page.getByRole('row', { name: /^143505 / })).toContainText('Cuadra');
  });

  test('cerrar el turno con un faltante lo asienta y deja la caja sin turno', async ({ page }) => {
    await nav(page, 'Vender').click();
    await page.getByRole('button', { name: 'Cerrar turno' }).first().click();
    // 50.000 de inicio + 11.900 cobrados en efectivo (la venta anulada ya no cuenta).
    await expect(page.getByText('Efectivo que debe haber').locator('..').getByText('61.900,00').first()).toBeVisible();
    await page.getByRole('button', { name: 'Cerrar turno' }).last().click();
    await expect(page.getByText('Escribe el efectivo contado.')).toBeVisible();
    await page.getByLabel('Efectivo contado (COP)').fill('61.000');
    await expect(page.getByText(/Faltante: 900,00\. Se asienta en la cuenta de faltantes de la caja\./)).toBeVisible();
    await checkDesign(page, 'cerrar turno');
    await shot(page, 'pos-cerrar-turno');
    await page.getByRole('button', { name: 'Cerrar turno' }).last().click();
    await expect(page.getByText('Turno cerrado. Esperado 61.900,00, contado 61.000,00: faltante de 900,00.')).toBeVisible();
    await expect(page.getByText('La caja CAJA1 no tiene un turno abierto')).toBeVisible();

    await nav(page, 'Turnos y ventas').click();
    const row = page.getByRole('row', { name: /^CAJA1 / }).first();
    await expect(row).toContainText('Cerrado');
    await expect(row).toContainText('Faltante 900,00');
    await row.getByRole('button', { name: 'Ver ventas' }).click();
    await expect(page.getByRole('button', { name: 'Anular' })).toHaveCount(0);
  });

  test('un cajero ve solo lo suyo: vende y cierra, sin contabilidad ni cajas', async ({ page, browser, request }) => {
    const cashier = await browser.newPage({ baseURL: 'http://127.0.0.1:4100', locale: 'es-CO', viewport: { width: 1366, height: 820 } });
    try {
      const reg = await cashier.request.post('/v1/auth/register', { data: { companyName: 'Empresa de Camilo', country: 'CO', currency: 'COP', ownerName: 'Camilo Ruiz', email: CASHIER, password: PASSWORD } });
      expect(reg.status()).toBe(201);
      const invite = await page.request.post(`/v1/tenants/${tenantId}/members`, { data: { email: CASHIER, role: 'cashier' } });
      expect(invite.status()).toBe(202);
      expect((await cashier.request.post('/v1/auth/login', { data: { email: CASHIER, password: PASSWORD } })).status()).toBe(200);
      const accept = await cashier.request.post('/v1/invitations/accept', { data: { token: await tokenFromMail(request, CASHIER) } });
      expect(accept.status(), await accept.text()).toBe(201);

      // Abre un turno nuevo para que la pantalla de venta tenga qué mostrar.
      const registers = await (await page.request.get(`/v1/tenants/${tenantId}/pos/registers`)).json();
      expect((await page.request.post(`/v1/tenants/${tenantId}/pos/registers/${registers.items[0]._id}/shifts`, { data: { openingCash: 10_000 } })).status()).toBe(201);

      await cashier.goto('/app');
      await cashier.evaluate((id) => window.localStorage.setItem('lulubiz.tenant', id), tenantId);
      await cashier.goto('/app/vender');
      await expect(heading(cashier, 'Venta de mostrador')).toBeVisible();
      const sidebar = cashier.getByRole('navigation', { name: 'Principal' });
      await expect(sidebar.getByRole('link', { name: 'Vender' })).toBeVisible();
      await expect(sidebar.getByRole('link', { name: 'Turnos y ventas' })).toBeVisible();
      await expect(sidebar.getByRole('link', { name: 'Artículos' })).toBeVisible();
      for (const hidden of ['Cajas', 'Asientos', 'Informes', 'Facturas', 'Compras', 'Miembros']) await expect(sidebar.getByRole('link', { name: hidden, exact: true })).toHaveCount(0);
      await checkDesign(cashier, 'vender como cajero');
      await shot(cashier, 'pos-cajero');
    } finally {
      await cashier.close();
    }
  });
});
