import { expect, test as base } from '@playwright/test';
import { PASSWORD, checkDesign, shot, tokenFromMail } from './helpers.js';

const OWNER = 'carla@constructora.co';
const DAY_MS = 86_400_000;
const iso = (offset = 0) => new Date(Date.now() + offset * DAY_MS).toISOString().slice(0, 10);
const YEAR = new Date().getUTCFullYear();

let shared;
let api;
const test = base.extend({ page: async ({}, use) => use(shared) });
const nav = (page, name) => page.getByRole('navigation', { name: 'Principal' }).getByRole('link', { name, exact: true });
const heading = (page, name) => page.getByRole('heading', { name, level: 1 });

async function bootstrap(page, request) {
  await request.post('/__reset');
  const registered = await page.request.post('/v1/auth/register', {
    data: { companyName: 'Constructora del Huila SAS', country: 'CO', currency: 'COP', ownerName: 'Carla Pérez', email: OWNER, password: PASSWORD },
  });
  expect(registered.status()).toBe(201);
  const { tenantId } = await registered.json();
  expect((await page.request.post('/v1/auth/verify-email', { data: { token: await tokenFromMail(request, OWNER) } })).status()).toBe(204);
  expect((await page.request.post('/v1/auth/login', { data: { email: OWNER, password: PASSWORD } })).status()).toBe(200);
  const base = `/v1/tenants/${tenantId}`;
  let n = 0;
  const post = async (path, data) => {
    const res = await page.request.post(`${base}${path}`, { data, headers: { 'idempotency-key': `centros-${(n += 1)}-aaaaaaaa` } });
    expect(res.status(), `${path}: ${await res.text()}`).toBeLessThan(300);
    return res.json();
  };
  for (const a of [
    { code: '1', name: 'Activo', type: 'asset', postable: false },
    { code: '110505', name: 'Caja', type: 'asset', parentCode: '1' },
    { code: '130505', name: 'Clientes', type: 'asset', parentCode: '1' },
    { code: '2', name: 'Pasivo', type: 'liability', postable: false },
    { code: '240805', name: 'IVA por pagar', type: 'liability', parentCode: '2' },
    { code: '4', name: 'Ingresos', type: 'income', postable: false },
    { code: '413505', name: 'Ventas', type: 'income', parentCode: '4' },
    { code: '5', name: 'Gastos', type: 'expense', postable: false },
    { code: '510506', name: 'Sueldos', type: 'expense', parentCode: '5' },
  ]) await post('/accounts', a);
  const saved = await page.request.put(`${base}/invoicing/settings`, {
    data: {
      issuer: { name: 'Constructora del Huila SAS', taxIdType: 'NIT', taxId: '890903938', checkDigit: 8, regime: 'responsable_iva', address: { line: 'Carrera 10 # 5-20', city: 'Garzón', region: 'Huila' } },
      accounts: { receivable: '130505', income: '413505', vatPayable: '240805', cash: '110505' },
    },
  });
  expect(saved.status()).toBe(200);
  for (const [docType, prefix] of [['invoice', 'FE'], ['credit_note', 'NC']]) {
    await post('/invoicing/resolutions', { docType, prefix, number: '18760000001', from: 1, to: 100, validFrom: `${YEAR - 1}-01-01`, validTo: `${YEAR + 1}-12-31` });
  }
  const customer = (await post('/parties', { name: 'Droguería Los Andes', roles: ['customer'], taxIdType: 'NIT', taxId: '800197268', checkDigit: 4 }))._id;
  return { post, customer };
}

async function report(page, name, { party } = {}) {
  await page.getByLabel('Informe', { exact: true }).selectOption({ label: name });
  await page.getByLabel('Desde').fill(`${YEAR}-01-01`);
  if (party) {
    await page.getByLabel(/^Buscar /).fill(party.search);
    await expect(page.getByLabel('Tercero', { exact: true }).getByRole('option', { name: party.option })).toBeAttached();
    await page.getByLabel('Tercero', { exact: true }).selectOption({ label: party.text });
  }
  await page.getByRole('button', { name: 'Ver informe' }).click();
}

test.describe.serial('centros de costo', () => {
  test.beforeAll(async ({ browser, request }) => {
    shared = await browser.newPage({ baseURL: 'http://127.0.0.1:4100', locale: 'es-CO', viewport: { width: 1366, height: 820 } });
    api = await bootstrap(shared, request);
  });
  test.afterAll(async () => {
    await shared?.close();
  });

  test('sin centros, los formularios no muestran la columna', async ({ page }) => {
    await page.goto('/app/asientos');
    await page.getByRole('button', { name: 'Nuevo asiento' }).click();
    await expect(page.getByLabel('Cuenta de la línea 1')).toBeVisible();
    await expect(page.getByLabel('Centro de costo de la línea 1')).toHaveCount(0);
  });

  test('se crean, se renombran y se desactivan; el código se normaliza y no se repite', async ({ page }) => {
    await page.goto('/app/centros-costo');
    await expect(heading(page, 'Centros de costo')).toBeVisible();
    await expect(page.getByText('Todavía no hay centros de costo.')).toBeVisible();

    await page.getByRole('button', { name: 'Nuevo centro' }).click();
    await page.getByRole('button', { name: 'Crear centro' }).click();
    await expect(page.getByText('Escribe el código del centro.')).toBeVisible();
    await page.getByLabel('Código').fill('norte 1');
    await expect(page.getByLabel('Código')).toHaveValue('NORTE1');
    await page.getByLabel('Código').fill('norte');
    await page.getByLabel('Nombre').fill('Sede norte');
    await page.getByRole('button', { name: 'Crear centro' }).click();
    await expect(page.getByText('Centro NORTE creado.')).toBeVisible();

    await page.getByRole('button', { name: 'Nuevo centro' }).click();
    await page.getByLabel('Código').fill('norte');
    await page.getByLabel('Nombre').fill('Otra');
    await page.getByRole('button', { name: 'Crear centro' }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await page.getByLabel('Código').fill('sur');
    await page.getByLabel('Nombre').fill('Sede sur');
    await page.getByRole('button', { name: 'Crear centro' }).click();
    await expect(page.getByText('Centro SUR creado.')).toBeVisible();

    const row = page.getByRole('row', { name: /NORTE/ });
    await row.getByRole('button', { name: 'Editar' }).click();
    await expect(page.getByLabel('Código')).toBeDisabled();
    await page.getByLabel('Nombre').fill('Sede norte principal');
    await page.getByRole('button', { name: 'Guardar cambios' }).click();
    await expect(page.getByRole('row', { name: /NORTE/ })).toContainText('Sede norte principal');

    await page.getByRole('row', { name: /SUR/ }).getByRole('button', { name: 'Desactivar' }).click();
    await expect(page.getByRole('row', { name: /SUR/ })).toContainText('Inactivo');
    await checkDesign(page, 'centros de costo');
    await shot(page, 'centros-costo');
    await page.getByRole('row', { name: /SUR/ }).getByRole('button', { name: 'Activar' }).click();
    await expect(page.getByRole('row', { name: /SUR/ })).toContainText('Activo');
  });

  test('un asiento manual elige el centro de costo de su línea', async ({ page }) => {
    await nav(page, 'Asientos').click();
    await page.getByRole('button', { name: 'Nuevo asiento' }).click();
    await expect(page.getByLabel('Centro de costo de la línea 1').getByRole('option')).toHaveText(['Sin centro', 'NORTE · Sede norte principal', 'SUR · Sede sur']);
    await page.getByLabel('Cuenta de la línea 1').fill('510506');
    await page.getByLabel('Débito de la línea 1').fill('1000');
    await page.getByLabel('Centro de costo de la línea 1').selectOption('NORTE');
    await page.getByLabel('Cuenta de la línea 2').fill('110505');
    await page.getByLabel('Crédito de la línea 2').fill('1000');
    await page.getByRole('button', { name: 'Registrar asiento' }).click();
    await expect(page.getByText(/Se registró el asiento/)).toBeVisible();
    await checkDesign(page, 'asiento con centro de costo');
  });

  test('una factura elige el centro de cada línea y la caja lo hereda a sus ventas', async ({ page }) => {
    await api.post('/invoices', { customerId: api.customer, issueDate: iso(0), paymentMethod: 'credit', dueDate: iso(30), lines: [{ description: 'Obra norte', quantity: 1000, unitPrice: 1_000_000, vatBps: 1900, costCenter: 'NORTE' }, { description: 'Obra sur', quantity: 1000, unitPrice: 500_000, vatBps: 1900, costCenter: 'SUR' }] });
    await nav(page, 'Facturas').click();
    await page.getByRole('button', { name: 'Nueva factura' }).click();
    await expect(page.getByLabel('Centro de costo de la línea 1')).toBeVisible();
    await page.getByRole('button', { name: 'Cancelar' }).click();
    await nav(page, 'Cajas').click();
    await page.getByRole('button', { name: 'Nueva caja' }).click();
    await expect(page.getByLabel('Centro de costo de la caja')).toBeVisible();
  });

  test('el resultado por centro reparte ingresos y gastos y cuadra con el total', async ({ page }) => {
    await nav(page, 'Libros y estados de cuenta').click();
    await report(page, 'Resultado por centro de costo');
    await expect(page.getByRole('row', { name: /NORTE · Sede norte principal/ })).toContainText('10.000,00');
    await expect(page.getByRole('row', { name: /NORTE · Sede norte principal/ })).toContainText('1.000,00');
    await expect(page.getByRole('row', { name: /NORTE · Sede norte principal/ })).toContainText('9.000,00');
    await expect(page.getByRole('row', { name: /SUR · Sede sur/ })).toContainText('5.000,00');
    await expect(page.getByRole('row', { name: /Sin centro de costo/ })).toContainText('0,00');
    await expect(page.getByText(/Resultado del rango .*: 14\.000,00 COP/)).toBeVisible();
    await checkDesign(page, 'resultado por centro de costo');
    await shot(page, 'centros-resultado');
  });

  test('el auxiliar de un tercero trae su saldo por cuenta y sus movimientos', async ({ page }) => {
    await report(page, 'Auxiliar de un tercero', { party: { search: 'andes', option: /Droguería Los Andes/, text: 'Droguería Los Andes — NIT 800197268' } });
    await expect(page.getByRole('row', { name: /130505/ }).first()).toContainText('17.850,00');
    await expect(page.getByRole('row', { name: /FV1/ })).toContainText('17.850,00');
    await checkDesign(page, 'auxiliar de un tercero');
    await page.getByLabel('Informe', { exact: true }).selectOption({ label: 'Libro de ventas' });
    await page.getByRole('button', { name: 'Ver informe' }).click();
    await page.getByLabel('Informe', { exact: true }).selectOption({ label: 'Auxiliar de un tercero' });
    await page.getByRole('button', { name: 'Ver informe' }).click();
    await expect(page.getByText('Elige el tercero.')).toBeVisible();
  });
});
