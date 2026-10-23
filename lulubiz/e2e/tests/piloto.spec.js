import { expect, test as base } from '@playwright/test';
import { PASSWORD, checkDesign, shot, tokenFromMail, nav } from './helpers.js';

const OWNER = 'paula@papeleria.co';

let shared;
let tenantId;
const test = base.extend({ page: async ({}, use) => use(shared) });
const heading = (page, name) => page.getByRole('heading', { name, level: 1 });

async function bootstrap(page, request) {
  await request.post('/__reset');
  const registered = await page.request.post('/v1/auth/register', {
    data: { companyName: 'Papelería El Estudiante SAS', country: 'CO', currency: 'COP', ownerName: 'Paula Gil', email: OWNER, password: PASSWORD },
  });
  expect(registered.status()).toBe(201);
  tenantId = (await registered.json()).tenantId;
  expect((await page.request.post('/v1/auth/verify-email', { data: { token: await tokenFromMail(request, OWNER) } })).status()).toBe(204);
  expect((await page.request.post('/v1/auth/login', { data: { email: OWNER, password: PASSWORD } })).status()).toBe(200);
}

const accountsViaApi = async (page) => {
  const base = `/v1/tenants/${tenantId}`;
  for (const body of [
    { code: '1', name: 'Activo', type: 'asset', postable: false },
    { code: '143505', name: 'Mercancías no fabricadas', type: 'asset', parentCode: '1' },
    { code: '4', name: 'Ingresos', type: 'income', postable: false },
    { code: '413505', name: 'Venta de mercancía', type: 'income', parentCode: '4' },
    { code: '6', name: 'Costos de ventas', type: 'cost', postable: false },
    { code: '613505', name: 'Costo de mercancía vendida', type: 'cost', parentCode: '6' },
  ]) expect((await page.request.post(`${base}/accounts`, { data: body })).status()).toBe(201);
};

const pick = (page, label) => page.getByLabel('Qué vas a importar').selectOption({ label });
const paste = async (page, csv) => {
  await page.getByLabel('O pega el contenido').fill(csv);
  await page.getByRole('button', { name: 'Revisar archivo' }).click();
};

test.describe.serial('preparación del piloto: primeros pasos e importación', () => {
  test.beforeAll(async ({ browser, request }) => {
    shared = await browser.newPage({ baseURL: 'http://127.0.0.1:4100', locale: 'es-CO', viewport: { width: 1366, height: 820 } });
    await bootstrap(shared, request);
  });
  test.afterAll(async () => {
    await shared?.close();
  });

  test('una empresa nueva ve qué le falta, con a dónde ir en cada paso', async ({ page }) => {
    await page.goto('/app/primeros-pasos');
    await expect(heading(page, 'Primeros pasos')).toBeVisible();
    await expect(page.getByText('Faltan 5 pasos obligatorios')).toBeVisible();
    await expect(page.getByText('Modo de pruebas: los documentos no tienen validez ante la DIAN', { exact: true })).toBeVisible();
    const chart = page.getByRole('row', { name: /^Plan de cuentas / });
    await expect(chart).toContainText('Pendiente · obligatorio');
    await expect(chart).toContainText('borrador');
    await expect(page.getByRole('row', { name: /^Clientes y proveedores / })).toContainText('Pendiente · recomendado');
    await checkDesign(page, 'primeros pasos');
    await shot(page, 'piloto-primeros-pasos');
    await chart.getByRole('link', { name: 'Hacerlo ahora' }).click();
    await expect(heading(page, 'Plan de cuentas')).toBeVisible();
  });

  test('al configurar, el paso pasa a hecho', async ({ page }) => {
    await accountsViaApi(page);
    await nav(page, 'Primeros pasos').click();
    await expect(page.getByRole('row', { name: /^Plan de cuentas / })).toContainText('Hecho');
    await expect(page.getByRole('row', { name: /^Plan de cuentas / })).toContainText('6 cuentas cargadas.');
  });

  test('importar clientes y proveedores: se revisa antes, se omiten las filas malas y se crean las buenas', async ({ page }) => {
    await nav(page, 'Importar').click();
    await expect(heading(page, 'Importar')).toBeVisible();
    await expect(page.getByRole('row', { name: /^documento / })).toContainText('Sí');
    await checkDesign(page, 'importar');
    await shot(page, 'piloto-importar');

    await paste(page, '');
    await expect(page.getByText('El archivo está vacío.')).toBeVisible();
    await paste(page, 'nombre,telefono\nSolo nombre,300');
    await expect(page.getByText('Faltan columnas obligatorias')).toBeVisible();
    await expect(page.getByText(/El archivo no trae: documento/)).toBeVisible();

    const csv = [
      'Nombre;Tipo de documento;Documento;Rol;Correo',
      'Droguería Los Andes;NIT;800.197.268-4;cliente;compras@losandes.co',
      'Aseo Total SAS;NIT;900123456;proveedor;',
      'Ana Pérez;CC;1.075.123.456;ambos;ana@correo.co',
      ';CC;111;cliente;',
      'Repetida;NIT;800197268;cliente;',
      'Jefe;CC;222;jefe;',
    ].join('\n');
    await paste(page, csv);
    await expect(page.getByText('3 filas listas para importar y 3 con problemas, que se omiten.')).toBeVisible();
    await expect(page.getByRole('row', { name: /^5 / })).toContainText('Falta el nombre');
    await expect(page.getByRole('row', { name: /^6 / })).toContainText('Documento repetido: ya está en la línea 2');
    await expect(page.getByRole('row', { name: /^7 / })).toContainText('rol «jefe»');
    await checkDesign(page, 'revisión de importación');
    await shot(page, 'piloto-revision');

    await page.getByRole('button', { name: 'Importar 3 filas' }).click();
    await expect(page.getByText('Importación terminada')).toBeVisible();
    await expect(page.getByText(/Se crearon 3 terceros/)).toBeVisible();

    await nav(page, 'Terceros').click();
    await expect(page.getByRole('row', { name: /Droguería Los Andes/ })).toContainText('NIT 800.197.268-4');
    await expect(page.getByRole('row', { name: /Aseo Total SAS/ })).toContainText('NIT 900.123.456-8');
    await expect(page.getByRole('row', { name: /Ana Pérez/ })).toContainText('Cliente');
  });

  test('repetir la importación no duplica nada', async ({ page }) => {
    await nav(page, 'Importar').click();
    await paste(page, 'nombre,documento,tipo_documento\nDroguería Los Andes,800197268,NIT\nNueva Papelería,800.250.119-1,NIT');
    await page.getByRole('button', { name: 'Importar 2 filas' }).click();
    await expect(page.getByText(/Se crearon 1 terceros, 1 ya existían/)).toBeVisible();
    await expect(page.getByRole('row', { name: /^2 / })).toContainText('800197268');
  });

  test('importar artículos desde un archivo: el servidor rechaza lo que no cuadra con el plan de cuentas', async ({ page }) => {
    await nav(page, 'Importar').click();
    await pick(page, 'Artículos');
    await expect(page.getByRole('row', { name: /^cuenta_inventario, cuenta_costo / })).toContainText('Para bienes');
    const csv = [
      'codigo,nombre,tipo,unidad,cuenta_inventario,cuenta_costo,cuenta_ingreso,precio,iva,minimo',
      'CUAD-100,Cuaderno 100 hojas,bien,und,143505,613505,413505,"4.500,00",19,10',
      'LAPIZ-2,Lápiz HB,bien,und,143505,613505,,"800",19,',
      'ENT-1,Entrega a domicilio,servicio,,,,413505,"3.000",0,',
      'MALO-1,Cuenta inexistente,bien,und,143505,999999,,,,',
    ].join('\n');
    await page.getByLabel('Archivo CSV').setInputFiles({ name: 'articulos.csv', mimeType: 'text/csv', buffer: Buffer.from(csv, 'utf8') });
    await expect(page.getByLabel('O pega el contenido')).toHaveValue(/CUAD-100/);
    await page.getByRole('button', { name: 'Revisar archivo' }).click();
    await expect(page.getByText('4 filas listas para importar.')).toBeVisible();
    await page.getByRole('button', { name: 'Importar 4 filas' }).click();
    await expect(page.getByText(/Se crearon 3 artículos y 1 fallaron/)).toBeVisible();
    await expect(page.getByRole('row', { name: /^5 / })).toContainText('999999');
    await shot(page, 'piloto-articulos');

    await nav(page, 'Artículos').click();
    await expect(page.getByRole('row', { name: /^CUAD-100 / })).toContainText('4.500,00');
    await expect(page.getByRole('row', { name: /^ENT-1 / })).toContainText('Servicio');
    await expect(page.getByRole('row', { name: /^MALO-1 / })).toHaveCount(0);
  });

  test('los primeros pasos reflejan lo importado', async ({ page }) => {
    await nav(page, 'Primeros pasos').click();
    await expect(page.getByRole('row', { name: /^Clientes y proveedores / })).toContainText('Hecho');
    await expect(page.getByRole('row', { name: /^Clientes y proveedores / })).toContainText('4 terceros registrados.');
    await expect(page.getByRole('row', { name: /^Artículos / })).toContainText('3 artículos registrados.');
  });
});
