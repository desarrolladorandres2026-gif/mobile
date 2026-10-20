import { expect, test as base } from '@playwright/test';
import { PASSWORD, checkDesign, shot, tokenFromMail } from './helpers.js';

const OWNER = 'sofia@distribuciones.co';
const month = new Date().toISOString().slice(0, 7);
const nextYear = new Date().getUTCFullYear() + 1;
const lastYear = new Date().getUTCFullYear() - 1;

const nav = (page, name) => page.getByRole('navigation', { name: 'Principal' }).getByRole('link', { name });
const heading = (page, name) => page.getByRole('heading', { name, level: 1 });

let tenantId;
let shared;
const test = base.extend({ page: async ({}, use) => use(shared) });

/** Prepara la empresa por la API (rápido) para que el recorrido se centre en lo que se prueba por la interfaz. */
async function bootstrap(page, request) {
  await request.post('/__reset');
  const registered = await page.request.post('/v1/auth/register', {
    data: { companyName: 'Distribuciones del Sur SAS', country: 'CO', currency: 'COP', ownerName: 'Sofía Mora', email: OWNER, password: PASSWORD },
  });
  expect(registered.status()).toBe(201);
  tenantId = (await registered.json()).tenantId;
  const token = await tokenFromMail(request, OWNER);
  expect((await page.request.post('/v1/auth/verify-email', { data: { token } })).status()).toBe(204);
  expect((await page.request.post('/v1/auth/login', { data: { email: OWNER, password: PASSWORD } })).status()).toBe(200);
  const base = `/v1/tenants/${tenantId}`;
  const post = async (path, data) => expect((await page.request.post(`${base}${path}`, { data })).status(), path).toBeLessThan(300);
  await post('/accounts', { code: '1', name: 'Activo', type: 'asset', postable: false });
  await post('/accounts', { code: '130505', name: 'Clientes nacionales', type: 'asset', parentCode: '1' });
  await post('/accounts', { code: '2', name: 'Pasivo', type: 'liability', postable: false });
  await post('/accounts', { code: '240805', name: 'IVA por pagar', type: 'liability', parentCode: '2' });
  await post('/accounts', { code: '4', name: 'Ingresos', type: 'income', postable: false });
  await post('/accounts', { code: '413505', name: 'Venta de mercancía', type: 'income', parentCode: '4' });
  await post('/parties', { name: 'Droguería Los Andes', roles: ['customer'], taxIdType: 'NIT', taxId: '800197268', checkDigit: 4 });
  await post('/parties', { name: 'Cliente RECHAZAR', roles: ['customer'], taxIdType: 'CC', taxId: '1075123456' });
  await post('/parties', { name: 'Cliente TIMEOUT', roles: ['customer'], taxIdType: 'CC', taxId: '1075123457' });
}

async function chooseCustomer(page, search, optionName) {
  await page.getByLabel('Buscar cliente').fill(search);
  await expect(page.getByLabel('Cliente', { exact: true }).getByRole('option', { name: optionName })).toBeAttached();
  await page.getByLabel('Cliente', { exact: true }).selectOption({ label: optionName });
}

async function fillLine(page, n, { description, quantity, unitPrice, discount, vat }) {
  await page.getByLabel(`Descripción de la línea ${n}`).fill(description);
  await page.getByLabel(`Cantidad de la línea ${n}`).fill(quantity);
  await page.getByLabel(`Precio unitario de la línea ${n}`).fill(unitPrice);
  if (discount) await page.getByLabel(`Descuento de la línea ${n}`).fill(discount);
  if (vat) await page.getByLabel(`IVA de la línea ${n}`).selectOption({ label: vat });
}

test.describe.serial('facturación electrónica de punta a punta', () => {
  // Una sola página para todo el recorrido: la sesión del propietario se crea una vez por la API.
  test.beforeAll(async ({ browser, request }) => {
    shared = await browser.newPage({ baseURL: 'http://127.0.0.1:4100', locale: 'es-CO', viewport: { width: 1366, height: 820 } });
    await bootstrap(shared, request);
  });
  test.afterAll(async () => {
    await shared?.close();
  });

  test('sin configurar avisa qué falta y que es modo de pruebas', async ({ page }) => {
    await page.goto('/app/facturas');
    await expect(heading(page, 'Facturas')).toBeVisible();
    await expect(page.getByText('Modo de pruebas: estos documentos no tienen validez ante la DIAN')).toBeVisible();
    await expect(page.getByText('Falta configurar la facturación')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Nueva factura' })).toHaveCount(0);
    await checkDesign(page, 'facturas sin configurar');
    await shot(page, 'facturas-sin-configurar');
  });

  test('configurar emisor, cuentas y resoluciones; el dígito del NIT se calcula solo', async ({ page }) => {
    await nav(page, 'Facturación').click();
    await expect(heading(page, 'Facturación electrónica')).toBeVisible();
    await page.getByLabel('Nombre o razón social').fill('Distribuciones del Sur SAS');
    await page.getByLabel('Número de documento').fill('890903938');
    await expect(page.getByLabel('Dígito')).toHaveValue('8');
    await page.getByLabel('Dirección').fill('Carrera 10 # 5-20');
    await page.getByLabel('Ciudad').fill('Garzón');
    await page.getByLabel('Departamento').fill('Huila');
    await page.getByLabel('Cuentas por cobrar (clientes)').fill('130505');
    await page.getByLabel('Ingresos por ventas (por defecto)').fill('413505');
    await page.getByLabel('IVA por pagar').fill('240805');
    await expect(page.getByText('Clientes nacionales').locator('visible=true')).toBeVisible(); // el nombre de la cuenta aparece al elegirla
    await shot(page, 'facturacion-configuracion');
    await page.getByRole('button', { name: 'Guardar configuración' }).click();
    await expect(page.getByText('Configuración guardada.')).toBeVisible();

    for (const [docType, prefix] of [['Facturas', 'FE'], ['Notas crédito', 'NC']]) {
      await page.getByRole('button', { name: 'Nueva resolución' }).click();
      await page.getByLabel('Para', { exact: true }).selectOption({ label: docType });
      await page.getByLabel('Prefijo').fill(prefix);
      await page.getByLabel('Número de la resolución').fill('18760000001');
      await page.getByLabel('Desde', { exact: true }).fill('1');
      await page.getByLabel('Hasta', { exact: true }).fill('100');
      await page.getByLabel('Vigente desde').fill(`${lastYear}-01-01`);
      await page.getByLabel('Vigente hasta').fill(`${nextYear}-12-31`);
      await page.getByRole('button', { name: 'Crear resolución' }).click();
      await expect(page.getByText('Resolución creada.')).toBeVisible();
    }
    await expect(page.getByText('Lista para emitir')).toBeVisible();
    await expect(page.getByRole('row', { name: /Facturas.*FE/ })).toContainText('Vigente');
    await checkDesign(page, 'configuración de facturación');
    await shot(page, 'facturacion-resoluciones');

    // Un rango solapado se rechaza con un mensaje claro.
    await page.getByRole('button', { name: 'Nueva resolución' }).click();
    await page.getByLabel('Prefijo').fill('FE');
    await page.getByLabel('Número de la resolución').fill('otra');
    await page.getByLabel('Desde', { exact: true }).fill('50');
    await page.getByLabel('Hasta', { exact: true }).fill('150');
    await page.getByLabel('Vigente desde').fill(`${lastYear}-01-01`);
    await page.getByLabel('Vigente hasta').fill(`${nextYear}-12-31`);
    await page.getByRole('button', { name: 'Crear resolución' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'se solapa' })).toBeVisible();
  });

  test('emitir una factura: valida antes de enviar, muestra la vista previa y la emite y contabiliza', async ({ page }) => {
    await page.goto('/app/facturas');
    await page.getByRole('button', { name: 'Nueva factura' }).click();

    // Sin datos, el envío explica qué falta.
    await page.getByRole('button', { name: 'Emitir factura' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Elige el cliente.' }).first()).toBeVisible();
    await expect(page.getByText('Agrega al menos una línea.')).toBeVisible();

    await chooseCustomer(page, 'droguer', 'Droguería Los Andes — NIT 800197268');
    await fillLine(page, 1, { description: 'Consultoría', quantity: '2', unitPrice: '50.000', vat: '19 %' });
    await page.getByRole('button', { name: 'Agregar línea' }).click();
    await fillLine(page, 2, { description: 'Mercancía', quantity: '1', unitPrice: '20.000', discount: '10', vat: '5 %' });

    // La vista previa coincide al centavo con lo que calcula el servidor.
    await expect(page.getByText('Subtotal').locator('..').getByText('118.000,00')).toBeVisible();
    await expect(page.getByText('Total a cobrar').locator('..').getByText('137.900,00')).toBeVisible();
    await expect(page.getByText(/IVA 19 % sobre 100\.000,00/)).toBeVisible();
    await expect(page.getByText(/IVA 5 % sobre 18\.000,00/)).toBeVisible();
    await checkDesign(page, 'nueva factura');
    await shot(page, 'nueva-factura');

    await page.getByRole('button', { name: 'Emitir factura' }).click();
    await expect(page.getByText(/La factura FE1 emitida y contabilizada\. \(Modo de pruebas/)).toBeVisible();
    const row = page.getByRole('row', { name: /^FE1 / });
    await expect(row).toContainText('Droguería Los Andes');
    await expect(row).toContainText('137.900,00');
    await expect(row).toContainText('Emitida · pruebas');

    await row.getByRole('button', { name: 'Ver detalle' }).click();
    await expect(page.getByText(/SANDBOX-/)).toBeVisible();
    await expect(page.getByText(/simulado: sin validez ante la DIAN/)).toBeVisible();
    await checkDesign(page, 'facturas con detalle');
    await shot(page, 'factura-detalle');
  });

  test('notas crédito: por cantidades, luego por lo que queda; la factura refleja cada paso', async ({ page }) => {
    await page.goto('/app/facturas');
    const row = page.getByRole('row', { name: /^FE1 / }).first();
    await row.getByRole('button', { name: 'Ver detalle' }).click();
    await row.getByRole('button', { name: 'Acreditar' }).click();
    await expect(page.getByRole('heading', { name: 'Nota crédito a la factura FE1' })).toBeVisible();

    await page.getByLabel('Qué se acredita').selectOption('lines');
    await page.getByLabel('Cantidad a acreditar de la línea 1').fill('1');
    await checkDesign(page, 'nota crédito por líneas');
    await shot(page, 'nota-credito-lineas');
    await page.getByRole('button', { name: 'Emitir nota crédito' }).click();
    await expect(page.getByText(/La nota crédito NC1 emitida y contabilizada/)).toBeVisible();
    await expect(page.getByRole('row', { name: /^FE1 / })).toContainText('acreditada en parte');

    // Pedir más de lo que queda se rechaza antes de enviar.
    await page.getByRole('row', { name: /^FE1 / }).getByRole('button', { name: 'Acreditar' }).click();
    await page.getByLabel('Qué se acredita').selectOption('lines');
    await page.getByLabel('Cantidad a acreditar de la línea 1').fill('5');
    await page.getByRole('button', { name: 'Emitir nota crédito' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'solo quedan 1 por acreditar' })).toBeVisible();

    await page.getByLabel('Qué se acredita').selectOption('all');
    await page.getByRole('button', { name: 'Emitir nota crédito' }).click();
    await expect(page.getByText(/La nota crédito NC2 emitida y contabilizada/)).toBeVisible();
    await expect(page.getByRole('row', { name: /^FE1 / })).toContainText('acreditada del todo');
    await expect(page.getByRole('row', { name: /^FE1 / }).getByRole('button', { name: 'Acreditar' })).toHaveCount(0);

    await nav(page, 'Notas crédito').click();
    await expect(page.getByRole('row', { name: /^NC1 / })).toContainText('FE1');
    await expect(page.getByRole('row', { name: /^NC2 / })).toContainText('FE1');
    await checkDesign(page, 'notas crédito');
    await shot(page, 'notas-credito');
  });

  test('la contabilidad cuadra: las dos notas compensan exactamente la factura', async ({ page }) => {
    await nav(page, 'Saldos').click();
    await page.getByLabel('Cuenta').fill('130505');
    await page.getByRole('button', { name: 'Consultar saldo' }).click();
    const row = page.getByRole('row', { name: /130505/ });
    await expect(row.getByRole('cell', { name: '137.900,00' })).toHaveCount(2); // débitos y créditos
    await expect(row).toContainText('0,00');
    await page.getByLabel('Cuenta').fill('240805');
    await page.getByRole('button', { name: 'Consultar saldo' }).click();
    await expect(page.getByRole('row', { name: /240805/ }).getByRole('cell', { name: '19.900,00' })).toHaveCount(2);
    expect(month).toMatch(/^\d{4}-\d{2}$/);
  });

  test('un rechazo del proveedor se explica; sin respuesta queda pendiente y se reintenta', async ({ page }) => {
    await page.goto('/app/facturas');
    await page.getByRole('button', { name: 'Nueva factura' }).click();
    await chooseCustomer(page, 'RECHAZAR', 'Cliente RECHAZAR — CC 1075123456');
    await fillLine(page, 1, { description: 'Servicio', quantity: '1', unitPrice: '10.000', vat: '0 %' });
    await page.getByRole('button', { name: 'Emitir factura' }).click();
    await expect(page.getByText(/FE2 fue rechazada por el proveedor: Rechazo simulado/)).toBeVisible();
    await expect(page.getByRole('row', { name: /^FE2 / })).toContainText('Rechazada');
    await shot(page, 'factura-rechazada');

    await page.getByRole('button', { name: 'Nueva factura' }).click();
    await chooseCustomer(page, 'TIMEOUT', 'Cliente TIMEOUT — CC 1075123457');
    await fillLine(page, 1, { description: 'Servicio', quantity: '1', unitPrice: '10.000', vat: '0 %' });
    await page.getByRole('button', { name: 'Emitir factura' }).click();
    await expect(page.getByText(/El proveedor no respondió\. La factura FE3 quedó pendiente de envío/)).toBeVisible();
    const pending = page.getByRole('row', { name: /^FE3 / });
    await expect(pending).toContainText('Pendiente de envío');
    await pending.getByRole('button', { name: 'Reintentar envío' }).click();
    await expect(page.getByText(/La factura FE3 emitida y contabilizada/)).toBeVisible();
    await expect(page.getByRole('row', { name: /^FE3 / })).toContainText('Emitida');

    await page.getByLabel('Estado').selectOption('rejected');
    await expect(page.getByRole('row', { name: /^FE2 / })).toBeVisible();
    await expect(page.getByRole('row', { name: /^FE3 / })).toHaveCount(0);
  });

  test('en el teléfono la lista y el formulario no se salen de la pantalla', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto('/app/facturas');
    await expect(page.getByRole('table')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.getByRole('button', { name: 'Nueva factura' }).click();
    await expect(page.getByLabel('Descripción de la línea 1')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await shot(page, 'telefono-factura');
  });
});
