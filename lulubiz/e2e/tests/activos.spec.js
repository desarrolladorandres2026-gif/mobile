import { expect, test as base } from '@playwright/test';
import { PASSWORD, checkDesign, shot, tokenFromMail, nav } from './helpers.js';

const OWNER = 'elena@oficinas.co';

/** `AAAA-MM` de hace `back` meses. */
const ym = (back = 0) => {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() - back, 1);
  return d.toISOString().slice(0, 7);
};

let shared;
const test = base.extend({ page: async ({}, use) => use(shared) });
const heading = (page, name) => page.getByRole('heading', { name, level: 1 });

async function bootstrap(page, request) {
  await request.post('/__reset');
  const registered = await page.request.post('/v1/auth/register', {
    data: { companyName: 'Oficinas del Valle SAS', country: 'CO', currency: 'COP', ownerName: 'Elena Mora', email: OWNER, password: PASSWORD },
  });
  expect(registered.status()).toBe(201);
  const { tenantId } = await registered.json();
  expect((await page.request.post('/v1/auth/verify-email', { data: { token: await tokenFromMail(request, OWNER) } })).status()).toBe(204);
  expect((await page.request.post('/v1/auth/login', { data: { email: OWNER, password: PASSWORD } })).status()).toBe(200);
  const base = `/v1/tenants/${tenantId}`;
  let n = 0;
  const post = async (path, data) => {
    const res = await page.request.post(`${base}${path}`, { data, headers: { 'idempotency-key': `activos-${(n += 1)}-aaaaaaaa` } });
    expect(res.status(), `${path}: ${await res.text()}`).toBeLessThan(300);
    return res.json();
  };
  for (const a of [
    { code: '1', name: 'Activo', type: 'asset', postable: false },
    { code: '111005', name: 'Bancos', type: 'asset', parentCode: '1' },
    { code: '152405', name: 'Equipo de oficina', type: 'asset', parentCode: '1' },
    { code: '159205', name: 'Depreciación acumulada', type: 'asset', parentCode: '1' },
    { code: '3', name: 'Patrimonio', type: 'equity', postable: false },
    { code: '310505', name: 'Capital', type: 'equity', parentCode: '3' },
    { code: '4', name: 'Ingresos', type: 'income', postable: false },
    { code: '429581', name: 'Utilidad en venta de activos', type: 'income', parentCode: '4' },
    { code: '5', name: 'Gastos', type: 'expense', postable: false },
    { code: '516005', name: 'Gasto por depreciación', type: 'expense', parentCode: '5' },
  ]) await post('/accounts', a);
  // El costo del equipo ya está en el libro, como si viniera de la compra.
  await post('/journals', { docType: 'AJ', date: `${ym(2)}-01T12:00:00Z`, currency: 'COP', lines: [{ accountId: '152405', debit: 1_200_000 }, { accountId: '310505', credit: 1_200_000 }] });
}

test.describe.serial('activos fijos', () => {
  test.beforeAll(async ({ browser, request }) => {
    shared = await browser.newPage({ baseURL: 'http://127.0.0.1:4100', locale: 'es-CO', viewport: { width: 1366, height: 820 } });
    await bootstrap(shared, request);
  });
  test.afterAll(async () => {
    await shared?.close();
  });

  test('registra un activo con validaciones y vista previa de la cuota', async ({ page }) => {
    await page.goto('/app/activos-fijos');
    await expect(heading(page, 'Activos fijos')).toBeVisible();
    await expect(page.getByText('Todavía no hay activos fijos.')).toBeVisible();
    await page.getByRole('button', { name: 'Nuevo activo' }).click();
    await page.getByRole('button', { name: 'Registrar activo' }).click();
    await expect(page.getByText('Escribe el nombre del activo.')).toBeVisible();
    await expect(page.getByText('Costo no válido. Ejemplo: 4.500.000,00')).toBeVisible();
    await page.getByLabel('Código', { exact: true }).fill('eq-1');
    await page.getByLabel('Nombre', { exact: true }).fill('Computador portátil');
    await page.getByLabel('Fecha de adquisición').fill(`${ym(2)}-01`);
    await page.getByLabel(/^Costo/).fill('12.000,00');
    await page.getByLabel('Vida útil (meses)').fill('12');
    await page.getByLabel('Cuenta del activo').fill('152405');
    await page.getByLabel('Cuenta de depreciación acumulada').fill('159205');
    await page.getByLabel('Cuenta del gasto de depreciación').fill('516005');
    await expect(page.getByText('La cuota del primer mes sería de 1.000,00.')).toBeVisible();
    await checkDesign(page, 'nuevo activo fijo');
    await page.getByRole('button', { name: 'Registrar activo' }).click();
    await expect(page.getByText('Activo EQ-1 registrado. Cuota mensual de 1.000,00.')).toBeVisible();
    await expect(page.getByRole('row', { name: /EQ-1/ })).toContainText('12.000,00');
  });

  test('contabiliza los tres meses que se deben y el activo cuadra con el libro', async ({ page }) => {
    await page.getByLabel('Hasta el período').fill(ym(0));
    await page.getByRole('button', { name: 'Contabilizar depreciación' }).click();
    await expect(page.getByText(new RegExp(`Depreciación de ${ym(0)} contabilizada en DP\\d+: 3\\.000,00 en 1 activo\\.`))).toBeVisible();
    const row = page.getByRole('row', { name: /EQ-1/ });
    await expect(row).toContainText('3 de 12');
    await expect(row).toContainText('9.000,00');
    await expect(page.getByText('Las fichas cuadran con el libro.')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Depreciaciones contabilizadas' })).toBeVisible();
    await page.getByRole('button', { name: 'Contabilizar depreciación' }).click();
    await expect(page.getByText(`No había nada que depreciar hasta ${ym(0)}.`)).toBeVisible();
    await shot(page, 'activos-fijos');
    await checkDesign(page, 'activos fijos');
  });

  test('muestra el calendario y da de baja con utilidad', async ({ page }) => {
    await page.getByRole('row', { name: /EQ-1/ }).getByRole('button', { name: 'Ver calendario' }).click();
    await expect(page.getByRole('row', { name: /Contabilizada/ })).toHaveCount(3);
    await expect(page.getByRole('row', { name: /Pendiente/ })).toHaveCount(9);
    await page.getByRole('button', { name: 'Dar de baja o vender' }).click();
    await page.getByLabel(/^Precio de venta/).fill('10.000,00');
    await page.getByRole('button', { name: 'Dar de baja', exact: true }).click();
    await expect(page.getByText('Indica la cuenta donde entra el dinero de la venta.')).toBeVisible();
    await expect(page.getByText('La venta deja utilidad: indica la cuenta de la utilidad.')).toBeVisible();
    await page.getByLabel('Cuenta donde entra el dinero').fill('111005');
    await page.getByLabel('Cuenta de la utilidad').fill('429581');
    await checkDesign(page, 'baja de activo');
    await page.getByRole('button', { name: 'Dar de baja', exact: true }).click();
    await expect(page.getByText('Activo EQ-1 dado de baja.')).toBeVisible();
    await expect(page.getByRole('row', { name: /EQ-1/ }).first()).toContainText('Dado de baja');
    await expect(page.getByText('No hay activos en uso.')).toBeVisible();
  });
});
