import { expect, test as base } from '@playwright/test';
import { PASSWORD, checkDesign, shot, tokenFromMail, nav } from './helpers.js';

const OWNER = 'diana@servicios.co';
const DAY_MS = 86_400_000;
const iso = (offset = 0) => new Date(Date.now() + offset * DAY_MS).toISOString().slice(0, 10);
const YEAR = new Date().getUTCFullYear();

let shared;
const test = base.extend({ page: async ({}, use) => use(shared) });
const heading = (page, name) => page.getByRole('heading', { name, level: 1 });

async function bootstrap(page, request) {
  await request.post('/__reset');
  const registered = await page.request.post('/v1/auth/register', {
    data: { companyName: 'Servicios del Sur SAS', country: 'CO', currency: 'COP', ownerName: 'Diana Rojas', email: OWNER, password: PASSWORD },
  });
  expect(registered.status()).toBe(201);
  const { tenantId } = await registered.json();
  expect((await page.request.post('/v1/auth/verify-email', { data: { token: await tokenFromMail(request, OWNER) } })).status()).toBe(204);
  expect((await page.request.post('/v1/auth/login', { data: { email: OWNER, password: PASSWORD } })).status()).toBe(200);
  const base = `/v1/tenants/${tenantId}`;
  let n = 0;
  const post = async (path, data) => {
    const res = await page.request.post(`${base}${path}`, { data, headers: { 'idempotency-key': `comercial-${(n += 1)}-aaaaaaaa` } });
    expect(res.status(), `${path}: ${await res.text()}`).toBeLessThan(300);
    return res.json();
  };
  for (const a of [
    { code: '1', name: 'Activo', type: 'asset', postable: false },
    { code: '110505', name: 'Caja', type: 'asset', parentCode: '1' },
    { code: '130505', name: 'Clientes', type: 'asset', parentCode: '1' },
    { code: '2', name: 'Pasivo', type: 'liability', postable: false },
    { code: '220505', name: 'Proveedores', type: 'liability', parentCode: '2' },
    { code: '240805', name: 'IVA por pagar', type: 'liability', parentCode: '2' },
    { code: '240810', name: 'IVA descontable', type: 'liability', parentCode: '2' },
    { code: '4', name: 'Ingresos', type: 'income', postable: false },
    { code: '413505', name: 'Ventas', type: 'income', parentCode: '4' },
    { code: '5', name: 'Gastos', type: 'expense', postable: false },
    { code: '519595', name: 'Gastos diversos', type: 'expense', parentCode: '5' },
  ]) await post('/accounts', a);
  const saved = await page.request.put(`${base}/invoicing/settings`, {
    data: {
      issuer: { name: 'Servicios del Sur SAS', taxIdType: 'NIT', taxId: '890903938', checkDigit: 8, regime: 'responsable_iva', address: { line: 'Carrera 10 # 5-20', city: 'Garzón', region: 'Huila' } },
      accounts: { receivable: '130505', income: '413505', vatPayable: '240805', payable: '220505', vatDeductible: '240810', cash: '110505' },
    },
  });
  expect(saved.status()).toBe(200);
  for (const [docType, prefix] of [['invoice', 'FE'], ['credit_note', 'NC']]) {
    await post('/invoicing/resolutions', { docType, prefix, number: '18760000001', from: 1, to: 100, validFrom: `${YEAR - 1}-01-01`, validTo: `${YEAR + 1}-12-31` });
  }
  await post('/parties', { name: 'Droguería Los Andes', roles: ['customer'], taxIdType: 'NIT', taxId: '800197268', checkDigit: 4 });
  await post('/parties', { name: 'Aseo Total SAS', roles: ['supplier'], taxIdType: 'NIT', taxId: '900123456', checkDigit: 8 });
}

async function pickParty(page, { label, search, option, text }) {
  await page.getByLabel(label, { exact: true }).fill(text);
}

const CUSTOMER = { label: 'Cliente', search: 'andes', option: /Droguería Los Andes/, text: 'Droguería Los Andes — NIT 800197268' };
const SUPPLIER = { label: 'Proveedor', search: 'aseo', option: /Aseo Total SAS/, text: 'Aseo Total SAS — NIT 900123456' };

test.describe.serial('documentos comerciales', () => {
  test.beforeAll(async ({ browser, request }) => {
    shared = await browser.newPage({ baseURL: 'http://127.0.0.1:4100', locale: 'es-CO', viewport: { width: 1366, height: 820 } });
    await bootstrap(shared, request);
  });
  test.afterAll(async () => {
    await shared?.close();
  });

  test('una cotización se crea, se acepta y se convierte en factura', async ({ page }) => {
    await page.goto('/app/cotizaciones');
    await expect(heading(page, 'Cotizaciones')).toBeVisible();
    await expect(page.getByText('No hay cotizaciones con este filtro.')).toBeVisible();
    await page.getByRole('button', { name: 'Nueva cotización' }).click();
    await page.getByRole('button', { name: 'Crear cotización' }).click();
    await expect(page.getByText('Elige el cliente.').first()).toBeVisible();
    await expect(page.getByText('Agrega al menos una línea.')).toBeVisible();
    await pickParty(page, CUSTOMER);
    await page.getByLabel('Descripción de la línea 1').fill('Mantenimiento de equipos');
    await page.getByLabel('Cantidad de la línea 1').fill('2');
    await page.getByLabel('Precio unitario de la línea 1').fill('5.000,00');
    await expect(page.getByText('11.900,00').first()).toBeVisible();
    await checkDesign(page, 'nueva cotización');
    await page.getByRole('button', { name: 'Crear cotización' }).click();
    await expect(page.getByText('Cotización COT-1 creada por 11.900,00.')).toBeVisible();

    const row = page.getByRole('row', { name: /COT-1/ });
    await expect(row).toContainText('Abierta');
    await row.getByRole('button', { name: 'Ver detalle' }).click();
    await expect(page.getByText('Mantenimiento de equipos')).toBeVisible();
    await shot(page, 'cotizaciones');
    await row.getByRole('button', { name: 'Aceptar' }).click();
    await expect(page.getByRole('row', { name: /COT-1/ })).toContainText('Aceptada');

    await page.getByRole('row', { name: /COT-1/ }).getByRole('button', { name: 'Facturar' }).click();
    await page.getByRole('button', { name: 'Emitir factura' }).click();
    await expect(page.getByText(/Factura FE\d+ emitida desde COT-1\./)).toBeVisible();
    await expect(page.getByRole('row', { name: /COT-1/ })).toContainText('Facturada FE');
    await checkDesign(page, 'cotización facturada');

    await nav(page, 'Facturas').click();
    await expect(page.getByRole('row', { name: /Droguería Los Andes/ })).toContainText('11.900,00');
  });

  test('una orden de compra se recibe y queda como factura de compra', async ({ page }) => {
    await nav(page, 'Órdenes de compra').click();
    await expect(heading(page, 'Órdenes de compra')).toBeVisible();
    await page.getByRole('button', { name: 'Nueva orden' }).click();
    await pickParty(page, SUPPLIER);
    await page.getByLabel('Descripción de la línea 1').fill('Insumos de aseo');
    await page.getByLabel('Precio unitario de la línea 1').fill('10.000,00');
    await page.getByRole('button', { name: 'Crear orden' }).click();
    await expect(page.getByText('Indica la cuenta o elige un artículo.')).toBeVisible();
    await page.getByLabel('Cuenta de la línea 1').fill('519595');
    await page.getByRole('button', { name: 'Crear orden' }).click();
    await expect(page.getByText('Orden OC-1 creada por 11.900,00.')).toBeVisible();

    const row = page.getByRole('row', { name: /OC-1/ });
    await row.getByRole('button', { name: 'Recibir' }).click();
    await page.getByRole('button', { name: 'Registrar la compra' }).click();
    await expect(page.getByText('Escribe el número de la factura del proveedor.')).toBeVisible();
    await page.getByLabel('Número de la factura del proveedor').fill('SA-501');
    await page.getByRole('button', { name: 'Registrar la compra' }).click();
    await expect(page.getByText(/Compra FC1 registrada desde OC-1: 11.900,00 por pagar\./)).toBeVisible();
    await expect(page.getByRole('row', { name: /OC-1/ })).toContainText('Recibida FC1');
    await checkDesign(page, 'órdenes de compra');
    await shot(page, 'ordenes-compra');
  });

  test('una nota débito del proveedor aumenta lo que se le debe', async ({ page }) => {
    await nav(page, 'Compras').click();
    const row = page.getByRole('row', { name: /FC1/ });
    await row.getByRole('button', { name: 'Nota débito' }).click();
    await page.getByRole('button', { name: 'Registrar nota débito' }).click();
    await expect(page.getByText('Escribe el número.')).toBeVisible();
    await page.getByLabel('Número de la nota del proveedor').fill('ND-1');
    await page.getByLabel('Concepto').fill('Intereses de mora');
    await page.getByLabel(/^Valor antes de IVA/).fill('1.000,00');
    await page.getByLabel('Cuenta del gasto, costo o activo').fill('519595');
    await page.getByRole('button', { name: 'Registrar nota débito' }).click();
    await expect(page.getByText(/Nota débito NDP1 registrada: la deuda con el proveedor sube 1.000,00\./)).toBeVisible();
    await expect(page.getByRole('row', { name: /NDP1/ })).toContainText('1.000,00');
    await expect(page.getByRole('row', { name: /NDP1/ }).getByRole('button', { name: 'Acreditar' })).toHaveCount(0);
    await checkDesign(page, 'nota débito de proveedor');
  });

  test('una factura recurrente genera las vencidas y se puede pausar', async ({ page }) => {
    await nav(page, 'Facturas recurrentes').click();
    await expect(heading(page, 'Facturas recurrentes')).toBeVisible();
    await page.getByRole('button', { name: 'Nueva plantilla' }).click();
    await page.getByRole('button', { name: 'Crear plantilla' }).click();
    await expect(page.getByText('Escribe el nombre de la plantilla.')).toBeVisible();
    await page.getByLabel('Nombre de la plantilla').fill('Mantenimiento mensual');
    await pickParty(page, CUSTOMER);
    await page.getByLabel('Primera factura').fill(iso(-40));
    await page.getByLabel('Descripción de la línea 1').fill('Servicio de mantenimiento');
    await page.getByLabel('Precio unitario de la línea 1').fill('2.000,00');
    await page.getByRole('button', { name: 'Crear plantilla' }).click();
    await expect(page.getByText(/Plantilla «Mantenimiento mensual» creada/)).toBeVisible();
    await expect(page.getByRole('row', { name: /Mantenimiento mensual/ })).toContainText('vencida');
    await shot(page, 'facturas-recurrentes');

    await page.getByRole('button', { name: 'Generar las vencidas' }).click();
    await expect(page.getByText('Se emitieron 2 facturas.')).toBeVisible();
    const row = page.getByRole('row', { name: /Mantenimiento mensual/ });
    await expect(row).toContainText('Activa');
    await expect(row).toContainText('FE');
    await expect(row).not.toContainText('vencida');
    await page.getByRole('button', { name: 'Generar las vencidas' }).click();
    await expect(page.getByText('No había facturas vencidas por generar.')).toBeVisible();
    await checkDesign(page, 'facturas recurrentes');

    await row.getByRole('button', { name: 'Pausar' }).click();
    await expect(page.getByRole('row', { name: /Mantenimiento mensual/ })).toContainText('Pausada');
    await page.getByRole('row', { name: /Mantenimiento mensual/ }).getByRole('button', { name: 'Reanudar' }).click();
    await expect(page.getByRole('row', { name: /Mantenimiento mensual/ })).toContainText('Activa');

    await nav(page, 'Facturas').click();
    await expect(page.getByRole('row', { name: /Droguería Los Andes/ })).toHaveCount(3); // la de la cotización y las dos de la plantilla
  });
});
