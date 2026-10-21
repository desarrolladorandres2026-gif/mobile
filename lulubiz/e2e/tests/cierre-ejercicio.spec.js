import { expect, test as base } from '@playwright/test';
import { PASSWORD, checkDesign, shot, tokenFromMail } from './helpers.js';

const OWNER = 'tomas@ferreteria.co';

let shared;
let tenantId;
const test = base.extend({ page: async ({}, use) => use(shared) });
const nav = (page, name) => page.getByRole('navigation', { name: 'Principal' }).getByRole('link', { name, exact: true });
const heading = (page, name) => page.getByRole('heading', { name, level: 1 });

async function bootstrap(page, request) {
  await request.post('/__reset');
  const registered = await page.request.post('/v1/auth/register', {
    data: { companyName: 'Ferretería La Cuarta SAS', country: 'CO', currency: 'COP', ownerName: 'Tomás Rey', email: OWNER, password: PASSWORD },
  });
  expect(registered.status()).toBe(201);
  tenantId = (await registered.json()).tenantId;
  expect((await page.request.post('/v1/auth/verify-email', { data: { token: await tokenFromMail(request, OWNER) } })).status()).toBe(204);
  expect((await page.request.post('/v1/auth/login', { data: { email: OWNER, password: PASSWORD } })).status()).toBe(200);
  const base = `/v1/tenants/${tenantId}`;
  const post = async (path, data, headers = {}) => {
    const res = await page.request.post(`${base}${path}`, { data, headers });
    expect(res.status(), `${path}: ${await res.text()}`).toBeLessThan(300);
  };
  await post('/accounts', { code: '1', name: 'Activo', type: 'asset', postable: false });
  await post('/accounts', { code: '110505', name: 'Caja general', type: 'asset', parentCode: '1' });
  await post('/accounts', { code: '3', name: 'Patrimonio', type: 'equity', postable: false });
  await post('/accounts', { code: '360505', name: 'Utilidad del ejercicio', type: 'equity', parentCode: '3' });
  await post('/accounts', { code: '360510', name: 'Pérdida del ejercicio', type: 'equity', parentCode: '3' });
  await post('/accounts', { code: '4', name: 'Ingresos', type: 'income', postable: false });
  await post('/accounts', { code: '413505', name: 'Venta de mercancía', type: 'income', parentCode: '4' });
  await post('/accounts', { code: '5', name: 'Gastos', type: 'expense', postable: false });
  await post('/accounts', { code: '510506', name: 'Sueldos', type: 'expense', parentCode: '5' });
  let n = 0;
  const journal = (date, lines) => post('/journals', { docType: 'AJ', date: `${date}T12:00:00Z`, currency: 'COP', lines }, { 'idempotency-key': `cierre-${(n += 1)}-aaaaaaaa` });
  for (const [year, income, expense] of [[2024, 200_000, 50_000], [2025, 1_000_000, 400_000]]) {
    await journal(`${year}-03-10`, [{ accountId: '110505', debit: income }, { accountId: '413505', credit: income }]);
    await journal(`${year}-04-10`, [{ accountId: '510506', debit: expense }, { accountId: '110505', credit: expense }]);
  }
}

const pickYear = (page, year) => page.getByLabel('Ejercicio', { exact: true }).selectOption(String(year));

test.describe.serial('cierre de ejercicio de punta a punta', () => {
  test.beforeAll(async ({ browser, request }) => {
    shared = await browser.newPage({ baseURL: 'http://127.0.0.1:4100', locale: 'es-CO', viewport: { width: 1366, height: 820 } });
    await bootstrap(shared, request);
  });
  test.afterAll(async () => {
    await shared?.close();
  });

  test('la vista previa muestra las cuentas y el resultado, y avisa que antes hay que cerrar el año anterior', async ({ page }) => {
    await page.goto('/app/cierre');
    await expect(heading(page, 'Cierre de ejercicio')).toBeVisible();
    await pickYear(page, 2025);
    await expect(page.getByRole('row', { name: /^413505 / })).toContainText('10.000,00');
    await expect(page.getByRole('row', { name: /^510506 / })).toContainText('4.000,00');
    await expect(page.getByText('Utilidad del ejercicio').locator('..').getByText('6.000,00')).toBeVisible();
    await expect(page.getByText('Todavía no se puede cerrar')).toBeVisible();
    await expect(page.getByText('Cierra primero el ejercicio 2024.')).toBeVisible();
    await expect(page.getByText('Todavía no se ha cerrado ningún ejercicio.')).toBeVisible();
    await checkDesign(page, 'cierre bloqueado');
    await shot(page, 'cierre-bloqueado');
  });

  test('se cierra en orden: primero 2024, y el formulario valida la cuenta', async ({ page }) => {
    await pickYear(page, 2024);
    await expect(page.getByText('Todavía no se puede cerrar')).toHaveCount(0);
    await page.getByRole('button', { name: 'Cerrar el ejercicio 2024' }).click();
    await expect(page.getByText('Indica la cuenta de patrimonio donde queda la utilidad.')).toBeVisible();
    await page.getByLabel('Cuenta de la utilidad del ejercicio').fill('413505');
    await page.getByRole('button', { name: 'Cerrar el ejercicio 2024' }).click();
    await expect(page.getByText('la cuenta 413505 debe ser de patrimonio')).toBeVisible();

    await page.getByLabel('Cuenta de la utilidad del ejercicio').fill('360505');
    await page.getByLabel('Cuenta de la pérdida del ejercicio (opcional)').fill('360510');
    await checkDesign(page, 'formulario de cierre');
    await shot(page, 'cierre-formulario');
    await page.getByRole('button', { name: 'Cerrar el ejercicio 2024' }).click();
    await expect(page.getByText('Ejercicio 2024 cerrado: utilidad de 1.500,00 COP. Los doce períodos del año quedaron cerrados.')).toBeVisible();
    await expect(page.getByText('El ejercicio 2024 está cerrado')).toBeVisible();
    await expect(page.getByRole('row', { name: /^2024 / })).toContainText('Utilidad 1.500,00');
    await expect(page.getByRole('row', { name: /^2024 / })).toContainText('CA1');
    await expect(page.getByRole('button', { name: 'Cerrar el ejercicio 2024' })).toHaveCount(0);
  });

  test('cerrar 2025 deja la utilidad en el patrimonio y los informes siguen mostrando la actividad real', async ({ page, request }) => {
    await pickYear(page, 2025);
    await expect(page.getByText('Todavía no se puede cerrar')).toHaveCount(0);
    await page.getByLabel('Cuenta de la utilidad del ejercicio').fill('360505');
    await page.getByRole('button', { name: 'Cerrar el ejercicio 2025' }).click();
    await expect(page.getByText('Ejercicio 2025 cerrado: utilidad de 6.000,00 COP.')).toBeVisible();
    await expect(page.getByRole('row', { name: /^2025 / })).toContainText('Utilidad 6.000,00');
    await checkDesign(page, 'ejercicio cerrado');
    await shot(page, 'cierre-cerrado');

    const sheet = await page.request.get(`/v1/tenants/${tenantId}/reports/balance-sheet?to=2025-12&currency=COP`);
    expect((await sheet.json()).totals).toMatchObject({ equity: 750_000, result: 0 });
    const income = await page.request.get(`/v1/tenants/${tenantId}/reports/income-statement?from=2025-01&to=2025-12&currency=COP`);
    expect((await income.json()).totals).toMatchObject({ income: 1_000_000, expense: 400_000, net: 600_000 });
    void request;
  });

  test('un período del año cerrado ya no se reabre suelto', async ({ page }) => {
    await nav(page, 'Períodos').click();
    await expect(heading(page, 'Períodos')).toBeVisible();
    const row = page.getByRole('row', { name: /^2025-12 / });
    await expect(row).toContainText('Cerrado');
    await row.getByRole('button', { name: 'Reabrir' }).click();
    await page.getByRole('button', { name: /^Sí/ }).click();
    await expect(page.getByText(/lo cerró el cierre del ejercicio 2025: reabre el ejercicio/)).toBeVisible();
  });

  test('reabrir el ejercicio pide el posterior primero y luego reversa el cierre', async ({ page }) => {
    await nav(page, 'Cierre de ejercicio').click();
    await pickYear(page, 2024);
    await page.getByRole('button', { name: 'Reabrir el ejercicio 2024' }).click();
    await page.getByRole('button', { name: 'Sí, reabrir el ejercicio 2024' }).click();
    await expect(page.getByText('el ejercicio 2025 está cerrado: reábrelo primero')).toBeVisible();

    await pickYear(page, 2025);
    await page.getByRole('button', { name: 'Reabrir el ejercicio 2025' }).click();
    await page.getByRole('button', { name: 'Sí, reabrir el ejercicio 2025' }).click();
    await expect(page.getByText('Ejercicio 2025 reabierto: se reversó el asiento de cierre y se reabrieron sus períodos.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cerrar el ejercicio 2025' })).toBeVisible();
    await expect(page.getByRole('row', { name: /^2025 / })).toHaveCount(0);
    await expect(page.getByRole('row', { name: /^2024 / })).toBeVisible();
  });
});
