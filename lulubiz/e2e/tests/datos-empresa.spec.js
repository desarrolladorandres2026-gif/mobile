import { readFileSync } from 'node:fs';
import { expect, test as base } from '@playwright/test';
import { PASSWORD, checkDesign, shot, tokenFromMail, nav } from './helpers.js';

const OWNER = 'rosa@minimercado.co';

let shared;
let tenantId;
const test = base.extend({ page: async ({}, use) => use(shared) });
const heading = (page, name) => page.getByRole('heading', { name, level: 1 });

async function bootstrap(page, request) {
  await request.post('/__reset');
  const registered = await page.request.post('/v1/auth/register', {
    data: { companyName: 'Minimercado La Esquina SAS', country: 'CO', currency: 'COP', ownerName: 'Rosa Pérez', email: OWNER, password: PASSWORD },
  });
  expect(registered.status()).toBe(201);
  tenantId = (await registered.json()).tenantId;
  expect((await page.request.post('/v1/auth/verify-email', { data: { token: await tokenFromMail(request, OWNER) } })).status()).toBe(204);
  expect((await page.request.post('/v1/auth/login', { data: { email: OWNER, password: PASSWORD } })).status()).toBe(200);
  const base = `/v1/tenants/${tenantId}`;
  expect((await page.request.post(`${base}/accounts`, { data: { code: '1', name: 'Activo', type: 'asset', postable: false } })).status()).toBe(201);
  expect((await page.request.post(`${base}/accounts`, { data: { code: '110505', name: 'Caja general', type: 'asset', parentCode: '1' } })).status()).toBe(201);
}

test.describe.serial('datos de la empresa', () => {
  test.beforeAll(async ({ browser, request }) => {
    shared = await browser.newPage({ baseURL: 'http://127.0.0.1:4100', locale: 'es-CO', viewport: { width: 1366, height: 820 }, acceptDownloads: true });
    await bootstrap(shared, request);
  });
  test.afterAll(async () => {
    await shared?.close();
  });

  test('el propietario descarga una copia completa que empieza y termina con marcas', async ({ page }) => {
    await page.goto('/app/primeros-pasos');
    await nav(page, 'Datos de la empresa').click();
    await expect(heading(page, 'Datos de la empresa')).toBeVisible();
    await expect(page.getByText('El borrado definitivo no se hace desde la aplicación')).toBeVisible();
    await checkDesign(page, 'datos de la empresa');
    await shot(page, 'datos-empresa');

    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Descargar los datos de la empresa' }).click()]);
    expect(download.suggestedFilename()).toMatch(/^lulubiz-.*\.ndjson$/);
    const lines = readFileSync(await download.path(), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    expect(lines[0]).toMatchObject({ type: 'start', format: 'lulubiz-export/1' });
    expect(lines.at(-1)).toMatchObject({ type: 'end', counts: { tenants: 1, memberships: 1, accounts: 2 } });
    expect(lines.filter((l) => l.collection === 'accounts')).toHaveLength(2);
    await expect(page.getByText('Descarga lista')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Descargar los datos de la empresa' })).toBeVisible();
  });

  test('queda en la auditoría', async ({ page }) => {
    const audit = await (await page.request.get(`/v1/tenants/${tenantId}/audit`)).json();
    expect(audit.items.filter((e) => e.action === 'tenant.export')).toHaveLength(1);
  });
});
