import { expect, test as base } from '@playwright/test';
import { PASSWORD, checkDesign, shot, tokenFromMail, nav, sectionListed } from './helpers.js';

const OWNER = 'ines@tienda.co';

let shared;
let tenantId;
let token;
const test = base.extend({ page: async ({}, use) => use(shared) });
const heading = (page, name) => page.getByRole('heading', { name, level: 1 });
const bearer = () => ({ authorization: `Bearer ${token}` });

test.describe.serial('claves de API de punta a punta', () => {
  test.beforeAll(async ({ browser, request }) => {
    await request.post('/__reset');
    shared = await browser.newPage({ baseURL: 'http://127.0.0.1:4100', locale: 'es-CO', viewport: { width: 1366, height: 820 } });
    const registered = await shared.request.post('/v1/auth/register', {
      data: { companyName: 'Tienda en Línea SAS', country: 'CO', currency: 'COP', ownerName: 'Inés Mora', email: OWNER, password: PASSWORD },
    });
    expect(registered.status()).toBe(201);
    tenantId = (await registered.json()).tenantId;
    expect((await shared.request.post('/v1/auth/verify-email', { data: { token: await tokenFromMail(request, OWNER) } })).status()).toBe(204);
    expect((await shared.request.post('/v1/auth/login', { data: { email: OWNER, password: PASSWORD } })).status()).toBe(200);
  });
  test.afterAll(async () => {
    await shared?.close();
  });

  test('sin claves la pantalla lo dice y ofrece crear una', async ({ page }) => {
    await page.goto('/app/claves-api');
    await expect(heading(page, 'Claves de API')).toBeVisible();
    await expect(page.getByText('Todavía no hay claves.')).toBeVisible();
    await expect(await sectionListed(page, 'Claves de API')).toBeVisible();
    await checkDesign(page, 'claves de API vacío');
    await shot(page, 'claves-vacio');
  });

  test('crear una clave valida el formulario y muestra el token una sola vez', async ({ page }) => {
    await page.getByRole('button', { name: 'Nueva clave' }).click();
    await page.getByRole('button', { name: 'Crear clave' }).click();
    await expect(page.getByText('Escribe un nombre que diga para qué se usa la clave.')).toBeVisible();
    await expect(page.getByText('Elige al menos un permiso.')).toBeVisible();
    // Los permisos de administración no se ofrecen.
    await expect(page.getByText('Administrar', { exact: false })).toHaveCount(0);
    await expect(page.getByLabel('Consultar artículos, existencias y kardex')).toBeVisible();

    await page.getByLabel('Nombre', { exact: true }).fill('Tienda en línea');
    await page.getByLabel('Consultar artículos, existencias y kardex').check();
    await page.getByLabel('Consultar terceros').check();
    await checkDesign(page, 'nueva clave');
    await shot(page, 'claves-nueva');
    await page.getByRole('button', { name: 'Crear clave' }).click();

    await expect(page.getByText('Clave «Tienda en línea» creada')).toBeVisible();
    await expect(page.getByText('No se vuelve a mostrar')).toBeVisible();
    token = await page.getByLabel('Clave de API', { exact: true }).inputValue();
    expect(token).toMatch(/^lbk_[a-f0-9]{8}_[A-Za-z0-9_-]{43}$/);
    await checkDesign(page, 'token nuevo');
    await shot(page, 'claves-token');

    await page.getByRole('button', { name: 'Ya la guardé' }).click();
    await expect(page.getByLabel('Clave de API', { exact: true })).toHaveCount(0);
    const row = page.getByRole('row', { name: /^Tienda en línea / });
    await expect(row).toContainText(`lbk_${token.slice(4, 12)}_…`);
    await expect(row).toContainText('Nunca');
    await expect(row).toContainText('No vence');
    await expect(row).toContainText('Activa');
    await row.getByRole('button', { name: 'Ver permisos' }).click();
    await expect(page.getByText('Consultar artículos, existencias y kardex')).toBeVisible();
    await expect(page.locator('body')).not.toContainText(token.slice(13));
  });

  test('la clave sirve en la API con sus permisos y no más', async ({ request }) => {
    const base = `/v1/tenants/${tenantId}`;
    const items = await request.get(`${base}/items`, { headers: bearer() });
    expect(items.status()).toBe(200);
    expect((await request.get(`${base}/parties`, { headers: bearer() })).status()).toBe(200);
    const write = await request.post(`${base}/items`, { headers: bearer(), data: { sku: 'X', name: 'X', type: 'service' } });
    expect(write.status()).toBe(403);
    expect((await request.get(`${base}/journals`, { headers: bearer() })).status()).toBe(403);
    expect((await request.get(`${base}/members`, { headers: bearer() })).status()).toBe(403);
    const wrong = await request.get(`${base}/items`, { headers: { authorization: `Bearer ${token.slice(0, -2)}xx` } });
    expect(wrong.status()).toBe(401);
  });

  test('el último uso se ve en la lista', async ({ page }) => {
    await page.reload();
    const row = page.getByRole('row', { name: /^Tienda en línea / });
    await expect(row).not.toContainText('Nunca');
  });

  test('revocar pide confirmación y la clave deja de servir de inmediato', async ({ page, request }) => {
    const row = page.getByRole('row', { name: /^Tienda en línea / });
    await row.getByRole('button', { name: 'Revocar' }).click();
    await shot(page, 'claves-revocar');
    await page.getByRole('button', { name: 'Cancelar' }).click();
    await expect(request.get(`/v1/tenants/${tenantId}/items`, { headers: bearer() }).then((r) => r.status())).resolves.toBe(200);

    await row.getByRole('button', { name: 'Revocar' }).click();
    await page.getByRole('button', { name: 'Sí, revocar' }).click();
    await expect(page.getByText('Clave «Tienda en línea» revocada: deja de servir de inmediato.')).toBeVisible();
    await expect(row).toContainText('Revocada');
    await expect(row.getByRole('button', { name: 'Revocar' })).toHaveCount(0);
    expect((await request.get(`/v1/tenants/${tenantId}/items`, { headers: bearer() })).status()).toBe(401);
  });

  test('la auditoría dice qué hizo la clave', async ({ page, request }) => {
    // Una clave nueva con permiso de escritura crea un artículo; la auditoría lo atribuye a la clave.
    const created = await page.request.post(`/v1/tenants/${tenantId}/api-keys`, { data: { name: 'Integración de inventario', scopes: ['inventory:read', 'inventory:manage'] } });
    expect(created.status()).toBe(201);
    const { token: writer } = await created.json();
    const svc = await request.post(`/v1/tenants/${tenantId}/items`, { headers: { authorization: `Bearer ${writer}` }, data: { sku: 'SERV-1', name: 'Instalación', type: 'service' } });
    expect(svc.status(), await svc.text()).toBe(201);

    await nav(page, 'Auditoría').click();
    await expect(heading(page, 'Auditoría')).toBeVisible();
    await expect(page.getByRole('row', { name: /Creó una clave de API/ }).first()).toContainText('ines@tienda.co');
    const byKey = page.getByRole('row', { name: /item\.create/ }).first();
    await expect(byKey).toContainText('Clave de API: Integración de inventario');
    await checkDesign(page, 'auditoría con claves');
    await shot(page, 'claves-auditoria');
  });

  test('quien no administra claves no ve la sección', async ({ browser, request }) => {
    const other = await browser.newPage({ baseURL: 'http://127.0.0.1:4100', locale: 'es-CO', viewport: { width: 1366, height: 820 } });
    try {
      const email = 'conta@tienda.co';
      expect((await other.request.post('/v1/auth/register', { data: { companyName: 'Empresa de Conta', country: 'CO', currency: 'COP', ownerName: 'Conta', email, password: PASSWORD } })).status()).toBe(201);
      expect((await shared.request.post(`/v1/tenants/${tenantId}/members`, { data: { email, role: 'accountant' } })).status()).toBe(202);
      expect((await other.request.post('/v1/auth/login', { data: { email, password: PASSWORD } })).status()).toBe(200);
      expect((await other.request.post('/v1/invitations/accept', { data: { token: await tokenFromMail(request, email) } })).status()).toBe(201);
      await other.goto('/app');
      await other.evaluate((id) => window.localStorage.setItem('lulubiz.tenant', id), tenantId);
      await other.goto('/app/claves-api');
      await other.getByLabel('Ir a una sección').fill('Claves de API');
      await expect(other.getByRole('listbox', { name: 'Resultados de la búsqueda' }).getByRole('option', { name: 'Claves de API', exact: true })).toHaveCount(0);
      await expect(heading(other, 'Claves de API')).toHaveCount(0);
    } finally {
      await other.close();
    }
  });
});
