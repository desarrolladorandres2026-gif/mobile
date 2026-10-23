import { expect, test as base } from '@playwright/test';
import { PASSWORD, checkDesign, shot, tokenFromMail, nav } from './helpers.js';

const OWNER = 'felipe@distribuidora.co';
const Y = new Date().getUTCFullYear() - 1;

let shared;
const test = base.extend({ page: async ({}, use) => use(shared) });
const heading = (page, name) => page.getByRole('heading', { name, level: 1 });

async function bootstrap(page, request) {
  await request.post('/__reset');
  const registered = await page.request.post('/v1/auth/register', {
    data: { companyName: 'Distribuidora Andina SAS', country: 'CO', currency: 'COP', ownerName: 'Felipe Cruz', email: OWNER, password: PASSWORD },
  });
  expect(registered.status()).toBe(201);
  const { tenantId } = await registered.json();
  expect((await page.request.post('/v1/auth/verify-email', { data: { token: await tokenFromMail(request, OWNER) } })).status()).toBe(204);
  expect((await page.request.post('/v1/auth/login', { data: { email: OWNER, password: PASSWORD } })).status()).toBe(200);
  const base = `/v1/tenants/${tenantId}`;
  const post = async (path, data) => {
    const res = await page.request.post(`${base}${path}`, { data, headers: { 'idempotency-key': `plan-${Math.random().toString(16).slice(2)}-aaaaaaaa` } });
    expect(res.status(), `${path}: ${await res.text()}`).toBeLessThan(300);
    return res.json();
  };
  for (const a of [
    { code: '1', name: 'Activo', type: 'asset', postable: false },
    { code: '110505', name: 'Caja', type: 'asset', parentCode: '1' },
    { code: '152405', name: 'Equipo de oficina', type: 'asset', parentCode: '1' },
    { code: '2', name: 'Pasivo', type: 'liability', postable: false },
    { code: '210505', name: 'Obligaciones financieras', type: 'liability', parentCode: '2' },
    { code: '4', name: 'Ingresos', type: 'income', postable: false },
    { code: '413505', name: 'Ventas', type: 'income', parentCode: '4' },
    { code: '5', name: 'Gastos', type: 'expense', postable: false },
    { code: '519595', name: 'Gastos diversos', type: 'expense', parentCode: '5' },
  ]) await post('/accounts', a);
  const entry = (date, lines) => post('/journals', { docType: 'AJ', date: `${date}T12:00:00Z`, currency: 'COP', lines });
  await entry(`${Y}-03-05`, [{ accountId: '110505', debit: 500_000 }, { accountId: '413505', credit: 500_000 }]);
  await entry(`${Y}-03-12`, [{ accountId: '519595', debit: 100_000 }, { accountId: '110505', credit: 100_000 }]);
  await entry(`${Y}-03-15`, [{ accountId: '152405', debit: 400_000 }, { accountId: '110505', credit: 400_000 }]);
  await entry(`${Y}-03-18`, [{ accountId: '110505', debit: 300_000 }, { accountId: '210505', credit: 300_000 }]);
}

test.describe.serial('flujo de efectivo y presupuesto', () => {
  test.beforeAll(async ({ browser, request }) => {
    shared = await browser.newPage({ baseURL: 'http://127.0.0.1:4100', locale: 'es-CO', viewport: { width: 1366, height: 820 } });
    await bootstrap(shared, request);
  });
  test.afterAll(async () => {
    await shared?.close();
  });

  test('el flujo de efectivo separa operación, inversión y financiación', async ({ page }) => {
    await page.goto('/app/flujo-efectivo');
    await expect(heading(page, 'Flujo de efectivo')).toBeVisible();
    await page.getByLabel('Desde').fill(`${Y}-03-01`);
    await page.getByLabel('Hasta').fill(`${Y}-03-31`);
    await page.getByRole('button', { name: 'Ver flujo de efectivo' }).click();
    await expect(page.getByRole('row', { name: /413505 · Ventas/ })).toContainText('5.000,00');
    await expect(page.getByRole('row', { name: /519595 · Gastos diversos/ })).toContainText('-1.000,00');
    await expect(page.getByRole('row', { name: /152405 · Equipo de oficina/ })).toContainText('-4.000,00');
    await expect(page.getByRole('row', { name: /210505 · Obligaciones financieras/ })).toContainText('3.000,00');
    await expect(page.getByRole('row', { name: /Efectivo neto de actividades de inversión/ })).toContainText('-4.000,00');
    await expect(page.getByRole('row', { name: /Efectivo al final/ })).toContainText('3.000,00');
    await expect(page.getByRole('row', { name: /Efectivo al inicio/ })).toContainText('0,00');
    await shot(page, 'flujo-efectivo');
    await checkDesign(page, 'flujo de efectivo');
    await page.getByRole('button', { name: 'Cambiar la clasificación de cuentas' }).click();
    await page.getByLabel('Inversión (prefijos)').fill('99');
    await page.getByRole('button', { name: 'Ver flujo de efectivo' }).click();
    await expect(page.getByRole('row', { name: /Efectivo neto de actividades de inversión/ })).toContainText('0,00');
    await expect(page.getByRole('row', { name: /Efectivo neto de actividades de operación/ })).toHaveText(/0,00$/);
  });

  test('guarda un presupuesto y lo compara con lo real', async ({ page }) => {
    await nav(page, 'Presupuesto').click();
    await expect(heading(page, 'Presupuesto')).toBeVisible();
    await page.getByLabel('Año', { exact: true }).fill(String(Y));
    await page.getByRole('button', { name: 'Guardar presupuesto' }).click();
    await expect(page.getByText('Agrega al menos una línea con importes.')).toBeVisible();
    await page.getByLabel('Cuenta de la línea 1').fill('413505');
    await page.getByLabel('Mar de la línea 1').fill('4.000,00');
    await page.getByRole('button', { name: 'Agregar línea' }).click();
    await page.getByLabel('Cuenta de la línea 2').fill('519595');
    await page.getByLabel('Mar de la línea 2').fill('500,00');
    await page.getByLabel('Abr de la línea 2').fill('abc');
    await page.getByRole('button', { name: 'Guardar presupuesto' }).click();
    await expect(page.getByText('Línea 2, Abr: importe no válido.')).toBeVisible();
    await page.getByLabel('Abr de la línea 2').fill('');
    await page.getByRole('button', { name: 'Guardar presupuesto' }).click();
    await expect(page.getByText(`Presupuesto de ${Y} guardado: 2 líneas.`)).toBeVisible();
    await expect(page.getByLabel('Mar de la línea 1')).toHaveValue('4.000,00');

    await page.getByLabel('Desde (AAAA-MM)').fill(`${Y}-03`);
    await page.getByLabel('Hasta (AAAA-MM)').fill(`${Y}-03`);
    await page.getByRole('button', { name: 'Ver ejecución' }).click();
    const sales = page.getByRole('row', { name: /413505 · Ventas/ });
    await expect(sales).toContainText('4.000,00');
    await expect(sales).toContainText('5.000,00');
    await expect(sales).toContainText('1.000,00');
    await expect(sales).toContainText('+25,0 %');
    const expense = page.getByRole('row', { name: /519595 · Gastos diversos/ });
    await expect(expense).toContainText('500,00');
    await expect(expense).toContainText('+100,0 %');
    await expect(page.getByRole('row', { name: /Resultado/ })).toContainText('4.000,00');
    await shot(page, 'presupuesto');
    await checkDesign(page, 'presupuesto');
  });

  test('repartir un total anual llena los doce meses', async ({ page }) => {
    await page.getByRole('button', { name: 'Agregar línea' }).click();
    await page.getByLabel('Cuenta de la línea 3').fill('519595');
    await page.getByLabel('Repartir un total anual en la última línea con cuenta:').fill('1.200,00');
    await page.getByRole('button', { name: 'Repartir en doce meses' }).click();
    await expect(page.getByLabel('Ene de la línea 3')).toHaveValue('100,00');
    await expect(page.getByLabel('Dic de la línea 3')).toHaveValue('100,00');
  });
});
