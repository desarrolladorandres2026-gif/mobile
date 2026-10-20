import { expect, test as base } from '@playwright/test';
import { PASSWORD, checkDesign, shot, tokenFromMail } from './helpers.js';

const OWNER = 'marta@contadores.co';
const MONTH = new Date().toISOString().slice(0, 7);
const DAY = `${MONTH}-10T12:00:00Z`;

let shared;
const test = base.extend({ page: async ({}, use) => use(shared) });
const nav = (page, name) => page.getByRole('navigation', { name: 'Principal' }).getByRole('link', { name });
let counter = 0;

async function bootstrap(page, request) {
  await request.post('/__reset');
  const registered = await page.request.post('/v1/auth/register', {
    data: { companyName: 'Contadores Asociados SAS', country: 'CO', currency: 'COP', ownerName: 'Marta Ríos', email: OWNER, password: PASSWORD },
  });
  expect(registered.status()).toBe(201);
  const { tenantId } = await registered.json();
  const token = await tokenFromMail(request, OWNER);
  expect((await page.request.post('/v1/auth/verify-email', { data: { token } })).status()).toBe(204);
  expect((await page.request.post('/v1/auth/login', { data: { email: OWNER, password: PASSWORD } })).status()).toBe(200);
  const base = `/v1/tenants/${tenantId}`;
  const account = async (data) => expect((await page.request.post(`${base}/accounts`, { data })).status()).toBe(201);
  await account({ code: '1', name: 'Activo', type: 'asset', postable: false });
  await account({ code: '110505', name: 'Caja general', type: 'asset', parentCode: '1' });
  await account({ code: '3', name: 'Patrimonio', type: 'equity', postable: false });
  await account({ code: '310505', name: 'Capital social', type: 'equity', parentCode: '3' });
  await account({ code: '4', name: 'Ingresos', type: 'income', postable: false });
  await account({ code: '413535', name: 'Ventas', type: 'income', parentCode: '4' });
  await account({ code: '5', name: 'Gastos', type: 'expense', postable: false });
  await account({ code: '510506', name: 'Sueldos', type: 'expense', parentCode: '5' });
  const journal = async (debit, credit, amount) => {
    const res = await page.request.post(`${base}/journals`, {
      headers: { 'idempotency-key': `informes-${(counter += 1)}-aaaaaaaa` },
      data: { docType: 'CG', date: DAY, currency: 'COP', lines: [{ accountId: debit, debit: amount }, { accountId: credit, credit: amount }] },
    });
    expect(res.status(), await res.text()).toBe(201);
  };
  await journal('110505', '310505', 5_000_000);
  await journal('110505', '413535', 1_200_000);
  await journal('510506', '110505', 400_000);
  // Más de una página en el libro auxiliar de la caja (100 por página).
  for (let i = 0; i < 100; i += 1) await journal('110505', '413535', 100);
}

async function generate(page, report) {
  await page.getByLabel('Informe').selectOption(report);
  await page.getByRole('button', { name: 'Generar informe' }).click();
}

test.describe.serial('informes contables', () => {
  test.beforeAll(async ({ browser, request }) => {
    shared = await browser.newPage({ baseURL: 'http://127.0.0.1:4100', locale: 'es-CO', viewport: { width: 1366, height: 820 } });
    await bootstrap(shared, request);
  });
  test.afterAll(async () => {
    await shared?.close();
  });

  test('balance de prueba: grupos sumados, totales iguales y comprobación de que cuadra', async ({ page }) => {
    await page.goto('/app/informes');
    await expect(page.getByRole('heading', { name: 'Informes', level: 1 })).toBeVisible();
    await page.getByLabel('Desde el período').fill(MONTH);
    await generate(page, 'trial-balance');
    await expect(page.getByText('El informe cuadra.')).toBeVisible();
    const caja = page.getByRole('row', { name: /^110505 · Caja general/ });
    // Importes del asiento en centavos: 5.000.000 + 1.200.000 + 100 × 100 − 400.000 = 5.810.000 centavos = 58.100,00
    await expect(caja.getByRole('cell').last()).toHaveText('58.100,00');
    await expect(page.getByRole('row', { name: /^1 · Activo/ }).getByRole('cell').last()).toHaveText('58.100,00');
    const totals = page.getByRole('row', { name: /^Totales/ });
    const [debits, credits] = [await totals.getByRole('cell').nth(2).textContent(), await totals.getByRole('cell').nth(3).textContent()];
    expect(debits).toBe(credits);
    expect(debits).toMatch(/^[0-9.]+,[0-9]{2}$/);
    await checkDesign(page, 'informe balance de prueba');
    await shot(page, 'informe-balance-prueba');
  });

  test('estado de resultados: utilidad bruta y neta', async ({ page }) => {
    await generate(page, 'income-statement');
    await expect(page.getByText('Utilidad neta del período: 8.100,00')).toBeVisible();
    await expect(page.getByRole('row', { name: /Total ingresos/ })).toContainText('12.100,00');
    await expect(page.getByRole('row', { name: /Total gastos/ })).toContainText('4.000,00');
    await checkDesign(page, 'informe estado de resultados');
    await shot(page, 'informe-estado-resultados');
  });

  test('balance general: activos igual a pasivo, patrimonio y resultado', async ({ page }) => {
    await generate(page, 'balance-sheet');
    await expect(page.getByText('El informe cuadra.')).toBeVisible();
    await expect(page.getByRole('row', { name: /Total activos/ })).toContainText('58.100,00');
    await expect(page.getByText(/Pasivo \+ patrimonio \+ resultado:/)).toContainText('58.100,00');
    await checkDesign(page, 'informe balance general');
    await shot(page, 'informe-balance-general');
  });

  test('libro auxiliar: pide la cuenta, pagina y termina en el mismo saldo del balance', async ({ page }) => {
    await page.getByLabel('Informe').selectOption('general-ledger');
    await page.getByLabel('Desde el período').fill(MONTH);
    await page.getByRole('button', { name: 'Generar informe' }).click();
    // Sin cuenta el navegador no deja enviar.
    await expect(page.getByLabel('Cuenta')).toBeVisible();
    await page.getByLabel('Cuenta').fill('110505');
    await expect(page.getByText('Caja general').locator('visible=true')).toBeVisible();
    await page.getByRole('button', { name: 'Generar informe' }).click();
    await expect(page.getByRole('row', { name: /Saldo inicial/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cargar más movimientos' })).toBeVisible();
    await expect(page.getByRole('row', { name: /Saldo final/ })).toHaveCount(0);
    await shot(page, 'informe-libro-auxiliar-primera-pagina');

    await page.getByRole('button', { name: 'Cargar más movimientos' }).click();
    const closing = page.getByRole('row', { name: /Saldo final/ });
    await expect(closing).toBeVisible();
    await expect(closing.getByRole('cell').last()).toHaveText('58.100,00');
    await expect(page.getByRole('button', { name: 'Cargar más movimientos' })).toHaveCount(0);
    expect(await page.getByRole('row').count()).toBe(1 + 1 + 103 + 1); // cabecera, saldo inicial, asientos, saldo final
    await checkDesign(page, 'informe libro auxiliar');
    await shot(page, 'informe-libro-auxiliar');
  });

  test('un rango invertido se explica y en el teléfono no desborda', async ({ page }) => {
    await page.getByLabel('Informe').selectOption('trial-balance');
    await page.getByLabel('Desde el período').fill('2999-12');
    await page.getByRole('button', { name: 'Generar informe' }).click();
    await expect(page.getByRole('alert')).toContainText('posterior');
    await page.getByLabel('Desde el período').fill(MONTH);
    await page.getByRole('button', { name: 'Generar informe' }).click();
    await page.setViewportSize({ width: 390, height: 800 });
    await expect(page.getByRole('table')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await shot(page, 'telefono-informe');
    await nav(page, 'Informes').click();
  });
});
