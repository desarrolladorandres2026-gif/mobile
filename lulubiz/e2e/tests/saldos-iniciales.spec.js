import { expect, test as base } from '@playwright/test';
import { PASSWORD, checkDesign, shot, tokenFromMail, nav } from './helpers.js';

const OWNER = 'sara@ferreteria.co';

let shared;
let tenantId;
const test = base.extend({ page: async ({}, use) => use(shared) });
const heading = (page, name) => page.getByRole('heading', { name, level: 1 });

async function bootstrap(page, request) {
  await request.post('/__reset');
  const registered = await page.request.post('/v1/auth/register', {
    data: { companyName: 'Ferretería El Tornillo SAS', country: 'CO', currency: 'COP', ownerName: 'Sara Ruiz', email: OWNER, password: PASSWORD },
  });
  expect(registered.status()).toBe(201);
  tenantId = (await registered.json()).tenantId;
  expect((await page.request.post('/v1/auth/verify-email', { data: { token: await tokenFromMail(request, OWNER) } })).status()).toBe(204);
  expect((await page.request.post('/v1/auth/login', { data: { email: OWNER, password: PASSWORD } })).status()).toBe(200);
  const base = `/v1/tenants/${tenantId}`;
  for (const body of [
    { code: '1', name: 'Activo', type: 'asset', postable: false },
    { code: '110505', name: 'Caja general', type: 'asset', parentCode: '1' },
    { code: '130505', name: 'Clientes', type: 'asset', parentCode: '1' },
    { code: '3', name: 'Patrimonio', type: 'equity', postable: false },
    { code: '310505', name: 'Capital social', type: 'equity', parentCode: '3' },
  ]) expect((await page.request.post(`${base}/accounts`, { data: body })).status()).toBe(201);
  expect(
    (await page.request.post(`${base}/parties`, { data: { name: 'Droguería Los Andes', roles: ['customer'], taxIdType: 'NIT', taxId: '800197268', checkDigit: 4 } })).status(),
  ).toBe(201);
}

const paste = async (page, csv) => {
  await page.getByLabel('O pega el contenido').fill(csv);
  await page.getByRole('button', { name: 'Revisar archivo' }).click();
};

test.describe.serial('saldos iniciales', () => {
  test.beforeAll(async ({ browser, request }) => {
    shared = await browser.newPage({ baseURL: 'http://127.0.0.1:4100', locale: 'es-CO', viewport: { width: 1366, height: 820 } });
    await bootstrap(shared, request);
  });
  test.afterAll(async () => {
    await shared?.close();
  });

  test('se revisa antes de guardar: reporta las líneas malas y lo que no cuadra, y no deja registrar', async ({ page }) => {
    await page.goto('/app/primeros-pasos');
    await nav(page, 'Saldos iniciales').click();
    await expect(heading(page, 'Saldos iniciales')).toBeVisible();
    await checkDesign(page, 'saldos iniciales');
    await shot(page, 'saldos-iniciales');

    await paste(page, 'cuenta,debito,credito\n999999,10,\n110505,abc,');
    await expect(page.getByText('El archivo tiene 2 problemas.')).toBeVisible();
    await expect(page.getByRole('row', { name: /^2 .*no existe/ })).toBeVisible();
    await expect(page.getByRole('row', { name: /^3 .*Importe no válido/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Registrar saldos iniciales' })).toHaveCount(0);

    await paste(page, 'cuenta,debito,credito\n110505,100.000,\n310505,,60.000');
    await expect(page.getByText(/El asiento no cuadra/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Registrar saldos iniciales' })).toHaveCount(0);

    await paste(page, 'cuenta,tercero,debito,credito\n130505,111,10,\n310505,,,10');
    await expect(page.getByRole('row', { name: /^2 .*tercero/ })).toBeVisible();
  });

  test('un archivo que cuadra se registra como un asiento, con el tercero en su línea', async ({ page }) => {
    await paste(page, 'cuenta;nit;debe;haber;detalle\n110505;;1.000.000,00;;Caja\n130505;800.197.268-4;500.000,00;;Saldo de Droguería\n310505;;;1.500.000,00;Capital');
    await expect(page.getByText('Total débitos')).toBeVisible();
    await shot(page, 'saldos-iniciales-revision');
    await page.getByRole('button', { name: 'Registrar saldos iniciales' }).click();
    await expect(page.getByText('Saldos iniciales registrados')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Registrar saldos iniciales' })).toHaveCount(0);

    const journals = await (await page.request.get(`/v1/tenants/${tenantId}/journals`)).json();
    expect(journals.items).toHaveLength(1);
    expect(journals.items[0]).toMatchObject({ docType: 'CC', description: 'Saldos iniciales' });
    const withParty = journals.items[0].lines.filter((l) => l.partyId);
    expect(withParty).toHaveLength(1);
    expect(withParty[0]).toMatchObject({ accountId: '130505', debit: 50_000_000 });
  });
});
