import { expect, test as base } from '@playwright/test';
import { PASSWORD, checkDesign, shot, tokenFromMail } from './helpers.js';

const OWNER = 'bruno@ferreteria.co';
const DAY_MS = 86_400_000;
const iso = (offset = 0) => new Date(Date.now() + offset * DAY_MS).toISOString().slice(0, 10);
const dmy = (offset) => iso(offset).split('-').reverse().join('/');
const YEAR = new Date().getUTCFullYear();

let shared;
const test = base.extend({ page: async ({}, use) => use(shared) });
const nav = (page, name) => page.getByRole('navigation', { name: 'Principal' }).getByRole('link', { name, exact: true });
const heading = (page, name) => page.getByRole('heading', { name, level: 1 });

async function bootstrap(page, request) {
  await request.post('/__reset');
  const registered = await page.request.post('/v1/auth/register', {
    data: { companyName: 'Ferretería El Tornillo SAS', country: 'CO', currency: 'COP', ownerName: 'Bruno Díaz', email: OWNER, password: PASSWORD },
  });
  expect(registered.status()).toBe(201);
  const { tenantId } = await registered.json();
  expect((await page.request.post('/v1/auth/verify-email', { data: { token: await tokenFromMail(request, OWNER) } })).status()).toBe(204);
  expect((await page.request.post('/v1/auth/login', { data: { email: OWNER, password: PASSWORD } })).status()).toBe(200);
  const base = `/v1/tenants/${tenantId}`;
  let n = 0;
  const post = async (path, data) => {
    const res = await page.request.post(`${base}${path}`, { data, headers: { 'idempotency-key': `banco-${(n += 1)}-aaaaaaaa` } });
    expect(res.status(), `${path}: ${await res.text()}`).toBeLessThan(300);
    return res.json();
  };
  for (const a of [
    { code: '1', name: 'Activo', type: 'asset', postable: false },
    { code: '111005', name: 'Bancos', type: 'asset', parentCode: '1' },
    { code: '4', name: 'Ingresos', type: 'income', postable: false },
    { code: '413505', name: 'Ventas', type: 'income', parentCode: '4' },
    { code: '421005', name: 'Intereses', type: 'income', parentCode: '4' },
    { code: '5', name: 'Gastos', type: 'expense', postable: false },
    { code: '530505', name: 'Gastos bancarios', type: 'expense', parentCode: '5' },
    { code: '519595', name: 'Gastos diversos', type: 'expense', parentCode: '5' },
  ]) await post('/accounts', a);
  const entry = (date, lines) => post('/journals', { docType: 'AJ', date: `${date}T12:00:00Z`, currency: 'COP', lines });
  await entry(iso(-3), [{ accountId: '111005', debit: 1_000_000 }, { accountId: '413505', credit: 1_000_000 }]); // consignación que el banco ya tiene
  await entry(iso(-2), [{ accountId: '111005', debit: 500_000 }, { accountId: '413505', credit: 500_000 }]); // en tránsito
  await entry(iso(-2), [{ accountId: '519595', debit: 200_000 }, { accountId: '111005', credit: 200_000 }]); // cheque sin cobrar
}

const csv = [
  'Fecha,Descripción,Referencia,Valor',
  `${dmy(-3)},Consignación cliente,R-1,"10.000,00"`,
  `${dmy(-1)},Comisión manejo,,"-50,00"`,
  `${dmy(-1)},Intereses ahorros,,"20,00"`,
].join('\n');

test.describe.serial('conciliación bancaria', () => {
  test.beforeAll(async ({ browser, request }) => {
    shared = await browser.newPage({ baseURL: 'http://127.0.0.1:4100', locale: 'es-CO', viewport: { width: 1366, height: 820 } });
    await bootstrap(shared, request);
  });
  test.afterAll(async () => {
    await shared?.close();
  });

  test('carga el extracto desde un CSV y volver a cargarlo no duplica', async ({ page }) => {
    await page.goto('/app/conciliacion');
    await expect(heading(page, 'Conciliación bancaria')).toBeVisible();
    await expect(page.getByText('Elige la cuenta de bancos para empezar.')).toBeVisible();
    await page.getByLabel('Cuenta de bancos').selectOption({ label: '111005 · Bancos' });
    await page.getByLabel('Desde').fill(`${YEAR}-01-01`);
    await expect(page.getByText('No hay líneas del extracto en este rango.')).toBeVisible();

    await page.getByRole('button', { name: 'Cargar extracto' }).click();
    await page.getByLabel('O pega el contenido').fill(csv);
    await page.getByRole('button', { name: 'Revisar extracto' }).click();
    await expect(page.getByText('3 líneas listas')).toBeVisible();
    await page.getByRole('button', { name: 'Cargar 3 líneas' }).click();
    await expect(page.getByText('Se cargaron 3 líneas nuevas.')).toBeVisible();
    await expect(page.getByRole('row', { name: /Consignación cliente/ })).toContainText('10.000,00');
    await expect(page.getByRole('row', { name: /Comisión manejo/ })).toContainText('-50,00');
    await checkDesign(page, 'extracto cargado');

    await page.getByRole('button', { name: 'Revisar extracto' }).click();
    await page.getByRole('button', { name: 'Cargar 3 líneas' }).click();
    await expect(page.getByText('Se cargaron 0 líneas nuevas y se saltaron 3 que ya estaban.')).toBeVisible();
    await page.getByRole('button', { name: 'Cerrar', exact: true }).click();
  });

  test('revisa un extracto con problemas sin cargar nada de más', async ({ page }) => {
    await page.getByRole('button', { name: 'Cargar extracto' }).click();
    await page.getByLabel('O pega el contenido').fill('Fecha,Descripción,Valor\n32/13/2026,Mala,"1,00"\nhoy,Peor,"2,00"');
    await page.getByRole('button', { name: 'Revisar extracto' }).click();
    await expect(page.getByText('0 líneas listas y 2 con problemas, que se omiten.')).toBeVisible();
    await expect(page.getByRole('button', { name: /^Cargar \d+ línea/ })).toHaveCount(0);
    await page.getByLabel('O pega el contenido').fill('Descripción,Valor\nx,"1,00"');
    await page.getByRole('button', { name: 'Revisar extracto' }).click();
    await expect(page.getByText('El archivo no trae: fecha.')).toBeVisible();
    await page.getByRole('button', { name: 'Cerrar', exact: true }).click();
  });

  test('la conciliación automática une la consignación y la comisión se contabiliza desde el extracto', async ({ page }) => {
    await page.getByRole('button', { name: 'Conciliar automáticamente' }).click();
    await expect(page.getByText(/Se concilió 1 línea\./)).toBeVisible();
    await expect(page.getByRole('row', { name: /Consignación cliente/ })).toContainText('Conciliada con AJ');

    const fee = page.getByRole('row', { name: /Comisión manejo/ });
    await fee.getByRole('button', { name: 'Contabilizar' }).click();
    await page.getByRole('button', { name: 'Contabilizar y conciliar' }).click();
    await expect(page.getByText('Elige la cuenta contra la que se contabiliza.')).toBeVisible();
    await page.getByLabel('Cuenta del gasto o del pasivo').fill('530505');
    await expect(page.locator('p', { hasText: 'Gastos bancarios' })).toBeVisible();
    await page.getByRole('button', { name: 'Contabilizar y conciliar' }).click();
    await expect(page.getByRole('heading', { name: /^Contabilizar «/ })).toHaveCount(0);
    await expect(page.getByRole('row', { name: /Comisión manejo/ })).toContainText('Conciliada con CB1');
    await checkDesign(page, 'extracto conciliado');
    await shot(page, 'conciliacion-extracto');

    // Los intereses siguen sin conciliar; no hay nada parecido en el libro.
    const interest = page.getByRole('row', { name: /Intereses ahorros/ });
    await expect(interest).toContainText('Sin conciliar');
    await interest.getByRole('button', { name: 'Buscar en el libro' }).click();
    await expect(page.getByText('No hay ninguna en el libro.')).toBeVisible();
  });

  test('el resumen separa lo pendiente del libro y del banco, y cuadra', async ({ page }) => {
    await page.getByRole('tab', { name: 'Conciliación y cierre' }).click();
    await page.getByLabel('Conciliar al').fill(iso(-1));
    await page.getByRole('button', { name: 'Ver conciliación' }).click();
    await expect(page.getByText('Escribe el saldo final del extracto')).toBeVisible();
    await page.getByLabel(/^Saldo del extracto/).fill('9.970,00');
    await page.getByRole('button', { name: 'Ver conciliación' }).click();
    await expect(page.getByText('La conciliación cuadra.')).toBeVisible();
    await expect(page.getByText('12.970,00')).toHaveCount(2);
    await expect(page.getByRole('heading', { name: 'Pendiente del libro (2)' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Pendiente del banco (1)' })).toBeVisible();
    await expect(page.getByRole('row', { name: /-2\.000,00/ })).toBeVisible();
    await checkDesign(page, 'resumen de conciliación');
    await shot(page, 'conciliacion-resumen');

    // Un saldo mal digitado se ve en la diferencia y no deja cerrar.
    await page.getByLabel(/^Saldo del extracto/).fill('9.000,00');
    await page.getByRole('button', { name: 'Ver conciliación' }).click();
    await expect(page.getByText(/No cuadra: diferencia de 970,00/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cerrar la conciliación' })).toHaveCount(0);
  });

  test('cierra la conciliación, lo cerrado no se altera y se puede reabrir', async ({ page }) => {
    await page.getByLabel(/^Saldo del extracto/).fill('9.970,00');
    await page.getByRole('button', { name: 'Ver conciliación' }).click();
    await page.getByRole('button', { name: 'Cerrar la conciliación' }).click();
    await expect(page.getByText(/Conciliación cerrada al/)).toBeVisible();
    await expect(page.getByRole('row', { name: /Cerrada/ })).toContainText('9.970,00');
    await expect(page.getByText(/^Cerrada hasta el/)).toBeVisible();

    await page.getByRole('tab', { name: 'Extracto' }).click();
    await page.getByLabel('Desde').fill(`${YEAR}-01-01`);
    const sale = page.getByRole('row', { name: /Consignación cliente/ });
    await sale.getByRole('button', { name: 'Deshacer' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'cerrada hasta el' })).toBeVisible();

    await page.getByRole('tab', { name: 'Conciliación y cierre' }).click();
    await page.getByRole('row', { name: /Cerrada/ }).getByRole('button', { name: 'Reabrir' }).click();
    await expect(page.getByText('Conciliación reabierta.')).toBeVisible();
    await expect(page.getByRole('row', { name: /Reabierta/ })).toBeVisible();
    await checkDesign(page, 'conciliación reabierta');
  });
});
