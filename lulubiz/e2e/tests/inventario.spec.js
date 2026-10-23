import { expect, test as base } from '@playwright/test';
import { PASSWORD, checkDesign, shot, tokenFromMail, nav } from './helpers.js';

const OWNER = 'lucia@ferreteria.co';
const nextYear = new Date().getUTCFullYear() + 1;
const lastYear = new Date().getUTCFullYear() - 1;

let shared;
const test = base.extend({ page: async ({}, use) => use(shared) });
const heading = (page, name) => page.getByRole('heading', { name, level: 1 });

async function bootstrap(page, request) {
  await request.post('/__reset');
  const registered = await page.request.post('/v1/auth/register', {
    data: { companyName: 'Ferretería Andina SAS', country: 'CO', currency: 'COP', ownerName: 'Lucía Pérez', email: OWNER, password: PASSWORD },
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
  await post('/accounts', { code: '130505', name: 'Clientes nacionales', type: 'asset', parentCode: '1' });
  await post('/accounts', { code: '143505', name: 'Mercancías no fabricadas', type: 'asset', parentCode: '1' });
  await post('/accounts', { code: '2', name: 'Pasivo', type: 'liability', postable: false });
  await post('/accounts', { code: '220505', name: 'Proveedores nacionales', type: 'liability', parentCode: '2' });
  await post('/accounts', { code: '240805', name: 'IVA por pagar', type: 'liability', parentCode: '2' });
  await post('/accounts', { code: '240810', name: 'IVA descontable', type: 'liability', parentCode: '2' });
  await post('/accounts', { code: '3', name: 'Patrimonio', type: 'equity', postable: false });
  await post('/accounts', { code: '310505', name: 'Capital social', type: 'equity', parentCode: '3' });
  await post('/accounts', { code: '4', name: 'Ingresos', type: 'income', postable: false });
  await post('/accounts', { code: '413505', name: 'Venta de mercancía', type: 'income', parentCode: '4' });
  await post('/accounts', { code: '5', name: 'Gastos', type: 'expense', postable: false });
  await post('/accounts', { code: '529595', name: 'Pérdida de inventario', type: 'expense', parentCode: '5' });
  await post('/accounts', { code: '6', name: 'Costos de ventas', type: 'cost', postable: false });
  await post('/accounts', { code: '613505', name: 'Costo de mercancía vendida', type: 'cost', parentCode: '6' });
  await post('/parties', { name: 'Tornillos del Sur SAS', roles: ['supplier'], taxIdType: 'NIT', taxId: '900123456', checkDigit: 8 });
  await post('/parties', { name: 'Droguería Los Andes', roles: ['customer'], taxIdType: 'NIT', taxId: '800197268', checkDigit: 4 });
  const settings = await page.request.put(`${base}/invoicing/settings`, {
    data: {
      issuer: { name: 'Ferretería Andina SAS', taxIdType: 'NIT', taxId: '890903938', checkDigit: 8, regime: 'responsable_iva', address: { line: 'Carrera 10 # 5-20', city: 'Garzón', region: 'Huila' } },
      accounts: { receivable: '130505', income: '413505', vatPayable: '240805', payable: '220505', vatDeductible: '240810' },
    },
  });
  expect(settings.status()).toBe(200);
  for (const [docType, prefix] of [['invoice', 'FE'], ['credit_note', 'NC']]) {
    await post('/invoicing/resolutions', { docType, prefix, number: '18760000001', from: 1, to: 100, validFrom: `${lastYear}-01-01`, validTo: `${nextYear}-12-31` });
  }
}

/** Escribe el código en el selector de artículo de una línea y espera a que quede elegido (aparece su nombre). */
async function pickItem(page, label, sku, name) {
  await page.getByLabel(label, { exact: true }).fill(sku);
  // El nombre también está en las sugerencias de la lista (ocultas): se espera el que se ve.
  await expect(page.getByText(name).locator('visible=true').first()).toBeVisible();
}

test.describe.serial('inventario de punta a punta', () => {
  test.beforeAll(async ({ browser, request }) => {
    shared = await browser.newPage({ baseURL: 'http://127.0.0.1:4100', locale: 'es-CO', viewport: { width: 1366, height: 820 } });
    await bootstrap(shared, request);
  });
  test.afterAll(async () => {
    await shared?.close();
  });

  test('el menú lateral despliega las secciones del módulo hacia abajo', async ({ page }) => {
    await page.goto('/app/articulos');
    await expect(heading(page, 'Artículos')).toBeVisible();
    const sidebar = page.getByRole('navigation', { name: 'Principal' });
    for (const group of ['Contabilidad', 'Ventas', 'Compras', 'Inventario', 'Administración']) await expect(sidebar.getByRole('button', { name: group, exact: true })).toBeVisible();
    const flyout = sidebar.getByRole('list', { name: 'Inventario' });
    await expect(flyout).toBeVisible();
    await expect(flyout.getByRole('link', { name: 'Existencias', exact: true })).toBeVisible();
    await expect(flyout.getByRole('link', { name: 'Ajustes y traspasos', exact: true })).toBeVisible();
    await expect(sidebar.getByRole('list', { name: 'Ventas' })).toHaveCount(0);
    await sidebar.getByRole('button', { name: 'Ventas', exact: true }).click();
    await expect(sidebar.getByRole('list', { name: 'Ventas' }).getByRole('link', { name: 'Facturas', exact: true })).toBeVisible();
    await sidebar.getByRole('button', { name: 'Ventas', exact: true }).click();
    await expect(sidebar.getByRole('list', { name: 'Ventas' })).toHaveCount(0);
    await expect(page.getByText('No hay artículos con este filtro.')).toBeVisible();
    await checkDesign(page, 'artículos vacío');
    await shot(page, 'articulos-vacio');
  });

  test('crear un artículo valida el formulario y luego lo lista', async ({ page }) => {
    await page.getByRole('button', { name: 'Nuevo artículo' }).click();
    await page.getByRole('button', { name: 'Crear artículo' }).click();
    await expect(page.getByText('Escribe el código del artículo.')).toBeVisible();
    await expect(page.getByText('Escribe el nombre.')).toBeVisible();
    await expect(page.getByText('Indica la cuenta de inventario.')).toBeVisible();

    await page.getByLabel('Código', { exact: true }).fill('TORN-1');
    await page.getByLabel('Nombre', { exact: true }).fill('Tornillo 1/2 pulgada');
    await page.getByLabel('Cuenta de inventario').fill('143505');
    await page.getByLabel('Cuenta de costo de ventas').fill('613505');
    await page.getByLabel('Precio de venta (COP, opcional)').fill('250,00');
    await page.getByLabel('IVA (opcional)').selectOption({ label: '19 %' });
    await page.getByLabel('Mínimo de existencias (opcional)').fill('5');
    await checkDesign(page, 'nuevo artículo');
    await shot(page, 'articulos-nuevo');
    await page.getByRole('button', { name: 'Crear artículo' }).click();
    await expect(page.getByText('Artículo TORN-1 creado.')).toBeVisible();
    const row = page.getByRole('row', { name: /^TORN-1 / });
    await expect(row).toContainText('Tornillo 1/2 pulgada');
    await expect(row).toContainText('Bien');
    await expect(row).toContainText('250,00');
    await expect(row).toContainText('Activo');

    // El mismo código no se repite.
    await page.getByRole('button', { name: 'Nuevo artículo' }).click();
    await page.getByLabel('Código', { exact: true }).fill('torn-1');
    await page.getByLabel('Nombre', { exact: true }).fill('Otro');
    await page.getByLabel('Cuenta de inventario').fill('143505');
    await page.getByLabel('Cuenta de costo de ventas').fill('613505');
    await page.getByRole('button', { name: 'Crear artículo' }).click();
    await expect(page.getByText('ya existe un artículo con el código TORN-1')).toBeVisible();
    await page.getByRole('button', { name: 'Cancelar' }).click();
  });

  test('un ajuste de entrada deja el saldo inicial con su asiento', async ({ page }) => {
    await nav(page, 'Ajustes y traspasos').click();
    await expect(heading(page, 'Ajustes y traspasos')).toBeVisible();
    await page.getByRole('button', { name: 'Ajuste de existencias' }).click();
    await page.getByRole('button', { name: 'Registrar ajuste' }).click();
    await expect(page.getByText('Elige el artículo.')).toBeVisible();
    await expect(page.getByText('Escribe el motivo del ajuste.')).toBeVisible();

    await pickItem(page, 'Artículo', 'TORN-1', 'Tornillo 1/2 pulgada');
    await page.getByLabel('Cantidad', { exact: true }).fill('10');
    await page.getByLabel('Costo unitario (COP)').fill('100,00');
    await page.getByLabel('Cuenta contrapartida').fill('310505');
    await page.getByLabel('Motivo').fill('Saldo inicial');
    await checkDesign(page, 'ajuste de existencias');
    await shot(page, 'inventario-ajuste');
    await page.getByRole('button', { name: 'Registrar ajuste' }).click();
    await expect(page.getByText('MI1 registrado: entran 10 de TORN-1 por 1.000,00 COP.')).toBeVisible();
    const row = page.getByRole('row', { name: /^MI1 / });
    await expect(row).toContainText('Ajuste de entrada');
    await expect(row).toContainText('1.000,00');
  });

  test('una compra con artículo mete la mercancía al inventario sin pedir cuenta', async ({ page }) => {
    await nav(page, 'Compras').click();
    await page.getByRole('button', { name: 'Registrar compra' }).click();
    await page.getByLabel('Proveedor', { exact: true }).fill('Tornillos del Sur SAS — NIT 900123456');
    await page.getByLabel('Número de la factura del proveedor').fill('ts-501');

    // Un código que no está en la lista se señala; el elegido propone su nombre y fija la cuenta de inventario.
    await page.getByLabel('Artículo de la línea 1').fill('NOEXISTE');
    await expect(page.getByText('Elige un código de la lista.')).toBeVisible();
    await pickItem(page, 'Artículo de la línea 1', 'TORN-1', 'Tornillo 1/2 pulgada');
    await expect(page.getByLabel('Descripción de la línea 1')).toHaveValue('Tornillo 1/2 pulgada');
    await expect(page.getByText('143505 (inventario)')).toBeVisible();
    await expect(page.getByLabel('Cuenta de la línea 1')).toHaveCount(0);
    await page.getByLabel('Cantidad de la línea 1').fill('5');
    await page.getByLabel('Precio unitario de la línea 1').fill('120,00');
    await checkDesign(page, 'compra con artículo');
    await shot(page, 'inventario-compra');
    await page.getByRole('button', { name: 'Registrar compra' }).click();
    await expect(page.getByText(/Compra FC1 registrada: 714,00 por pagar a Tornillos del Sur SAS/)).toBeVisible();
  });

  test('una venta con artículo propone precio e IVA, descuenta al costo promedio y registra el costo de ventas', async ({ page }) => {
    await nav(page, 'Facturas').click();
    await page.getByRole('button', { name: 'Nueva factura' }).click();
    await page.getByLabel('Cliente', { exact: true }).fill('Droguería Los Andes — NIT 800197268');

    await pickItem(page, 'Artículo de la línea 1', 'TORN-1', 'hay 15 UND');
    await expect(page.getByLabel('Descripción de la línea 1')).toHaveValue('Tornillo 1/2 pulgada');
    await expect(page.getByLabel('Precio unitario de la línea 1')).toHaveValue('250,00');
    await expect(page.getByLabel('IVA de la línea 1')).toHaveValue('1900');
    await page.getByLabel('Cantidad de la línea 1').fill('3');
    await checkDesign(page, 'factura con artículo');
    await shot(page, 'inventario-factura');
    await page.getByRole('button', { name: 'Emitir factura' }).click();
    await expect(page.getByText(/La factura FE1 emitida y contabilizada/)).toBeVisible();
  });

  test('sin existencias suficientes la factura se rechaza con la cantidad que hay', async ({ page }) => {
    await page.getByRole('button', { name: 'Nueva factura' }).click();
    await page.getByLabel('Cliente', { exact: true }).fill('Droguería Los Andes — NIT 800197268');
    await pickItem(page, 'Artículo de la línea 1', 'TORN-1', 'hay 12 UND');
    await page.getByLabel('Cantidad de la línea 1').fill('100');
    await page.getByRole('button', { name: 'Emitir factura' }).click();
    await expect(page.getByText('no hay existencias suficientes de TORN-1 (hay 12, se piden 100)')).toBeVisible();
    await page.getByRole('button', { name: 'Cancelar' }).click();
  });

  test('las existencias cuadran con el libro y el kardex cuenta lo que pasó', async ({ page }) => {
    await nav(page, 'Existencias').click();
    await expect(heading(page, 'Existencias')).toBeVisible();
    const row = page.getByRole('row', { name: /^TORN-1 / }).first();
    // 10 a 100 + 5 a 120 = 15 und por 1.600,00; se vendieron 3 al promedio (320,00).
    await expect(row).toContainText('12 UND');
    await expect(row).toContainText('1.280,00');
    await expect(page.getByText('Valor total: 1.280,00 COP')).toBeVisible();
    await expect(page.getByRole('row', { name: /^143505 / })).toContainText('Cuadra');
    await expect(page.getByText('El inventario no cuadra con el libro')).toHaveCount(0);
    await expect(page.getByText('Ningún artículo está por debajo de su mínimo.')).toBeVisible();

    await pickItem(page, 'Artículo', 'TORN-1', 'Tornillo 1/2 pulgada');
    await expect(page.getByRole('row', { name: /Venta/ })).toContainText('3');
    await expect(page.getByRole('row', { name: /Compra/ })).toContainText('600,00');
    await expect(page.getByRole('row', { name: /Ajuste de entrada/ })).toContainText('1.000,00');
    await checkDesign(page, 'existencias y kardex');
    await shot(page, 'inventario-existencias');
  });

  test('una nota crédito por devolución regresa los bienes al costo al que salieron', async ({ page }) => {
    await nav(page, 'Facturas').click();
    await page.getByRole('row', { name: /^FE1 / }).getByRole('button', { name: 'Acreditar' }).click();
    await expect(page.getByText('Con este motivo, los bienes acreditados vuelven al inventario al costo al que salieron.')).toBeVisible();
    await shot(page, 'inventario-nota-credito');
    await page.getByRole('button', { name: 'Emitir nota crédito' }).click();
    await expect(page.getByText(/La nota crédito NC1 emitida y contabilizada/)).toBeVisible();

    await nav(page, 'Existencias').click();
    await expect(page.getByRole('row', { name: /^TORN-1 / }).first()).toContainText('1.600,00');
    await expect(page.getByText('Valor total: 1.600,00 COP')).toBeVisible();
    await expect(page.getByRole('row', { name: /^143505 / })).toContainText('Cuadra');
  });

  test('con otra bodega se traspasa mercancía y el valor total no cambia', async ({ page }) => {
    await nav(page, 'Existencias').click();
    await page.getByLabel('Código', { exact: true }).fill('SUR');
    await page.getByLabel('Nombre', { exact: true }).fill('Bodega sur');
    await page.getByRole('button', { name: 'Crear bodega' }).click();
    await expect(page.getByText('Bodega SUR creada.')).toBeVisible();

    await nav(page, 'Ajustes y traspasos').click();
    await page.getByRole('button', { name: 'Traspaso entre bodegas' }).click();
    await page.getByRole('button', { name: 'Registrar traspaso' }).click();
    await expect(page.getByText('Elige el artículo.')).toBeVisible();
    await expect(page.getByText('Elige la bodega de origen.')).toBeVisible();

    await pickItem(page, 'Artículo', 'TORN-1', 'Tornillo 1/2 pulgada');
    await page.getByLabel('Bodega de origen').selectOption({ label: 'PRINCIPAL — Bodega principal' });
    await page.getByLabel('Bodega de destino').selectOption({ label: 'SUR — Bodega sur' });
    await page.getByLabel('Cantidad', { exact: true }).fill('4');
    await page.getByRole('button', { name: 'Registrar traspaso' }).click();
    await expect(page.getByText(/TR1 registrado: 4 de TORN-1 pasan de PRINCIPAL a SUR/)).toBeVisible();
    await checkDesign(page, 'ajustes y traspasos');
    await shot(page, 'inventario-traspaso');

    await nav(page, 'Existencias').click();
    await expect(page.getByText('Valor total: 1.600,00 COP')).toBeVisible();
    await expect(page.getByRole('row', { name: /^TORN-1 .*SUR/ })).toContainText('4 UND');
    await expect(page.getByRole('row', { name: /^TORN-1 .*PRINCIPAL/ })).toContainText('11 UND');
  });
});
