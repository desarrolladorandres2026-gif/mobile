import { expect, test as base } from '@playwright/test';
import { PASSWORD, checkDesign, shot, tokenFromMail, nav } from './helpers.js';

const OWNER = 'gloria@talleres.co';

/** `AAAA-MM` de hace `back` meses. */
const ym = (back = 0) => {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() - back, 1);
  return d.toISOString().slice(0, 7);
};

let shared;
const test = base.extend({ page: async ({}, use) => use(shared) });
const heading = (page, name) => page.getByRole('heading', { name, level: 1 });

const CHART = [
  ['1', 'Activo', 'asset', null],
  ['111005', 'Bancos', 'asset', '1'],
  ['2', 'Pasivo', 'liability', null],
  ['250505', 'Salarios por pagar', 'liability', '2'],
  ['236505', 'Retención en la fuente por salarios', 'liability', '2'],
  ['237005', 'Aportes a EPS', 'liability', '2'],
  ['237006', 'Aportes a ARL', 'liability', '2'],
  ['238030', 'Fondos de pensiones', 'liability', '2'],
  ['237010', 'Aportes a cajas de compensación', 'liability', '2'],
  ['237015', 'Aportes al SENA', 'liability', '2'],
  ['237020', 'Aportes al ICBF', 'liability', '2'],
  ['237095', 'Otras deducciones de nómina', 'liability', '2'],
  ['261005', 'Cesantías consolidadas', 'liability', '2'],
  ['261010', 'Intereses sobre cesantías', 'liability', '2'],
  ['261015', 'Vacaciones consolidadas', 'liability', '2'],
  ['261020', 'Prima de servicios', 'liability', '2'],
  ['5', 'Gastos', 'expense', null],
  ['510506', 'Sueldos', 'expense', '5'],
  ['510527', 'Auxilio de transporte', 'expense', '5'],
  ['510530', 'Cesantías', 'expense', '5'],
  ['510533', 'Intereses sobre cesantías', 'expense', '5'],
  ['510536', 'Prima de servicios', 'expense', '5'],
  ['510539', 'Vacaciones', 'expense', '5'],
  ['510548', 'Bonificaciones', 'expense', '5'],
  ['510568', 'Aportes a ARL', 'expense', '5'],
  ['510569', 'Aportes a EPS', 'expense', '5'],
  ['510570', 'Aportes a fondos de pensiones', 'expense', '5'],
  ['510572', 'Aportes a cajas de compensación', 'expense', '5'],
  ['510575', 'Aportes al ICBF', 'expense', '5'],
  ['510578', 'Aportes al SENA', 'expense', '5'],
];

async function bootstrap(page, request) {
  await request.post('/__reset');
  const registered = await page.request.post('/v1/auth/register', {
    data: { companyName: 'Talleres del Huila SAS', country: 'CO', currency: 'COP', ownerName: 'Gloria Ramos', email: OWNER, password: PASSWORD },
  });
  expect(registered.status()).toBe(201);
  const { tenantId } = await registered.json();
  expect((await page.request.post('/v1/auth/verify-email', { data: { token: await tokenFromMail(request, OWNER) } })).status()).toBe(204);
  expect((await page.request.post('/v1/auth/login', { data: { email: OWNER, password: PASSWORD } })).status()).toBe(200);
  for (const [code, name, type, parentCode] of CHART) {
    const res = await page.request.post(`/v1/tenants/${tenantId}/accounts`, { data: { code, name, type, ...(parentCode ? { parentCode } : { postable: false }) } });
    expect(res.status(), `${code}: ${await res.text()}`).toBe(201);
  }
}

test.describe.serial('nómina', () => {
  test.beforeAll(async ({ browser, request }) => {
    shared = await browser.newPage({ baseURL: 'http://127.0.0.1:4100', locale: 'es-CO', viewport: { width: 1366, height: 820 } });
    await bootstrap(shared, request);
  });
  test.afterAll(async () => {
    await shared?.close();
  });

  test('configura los parámetros del año y las cuentas con las sugeridas', async ({ page }) => {
    await page.goto('/app/parametros-nomina');
    await expect(heading(page, 'Parámetros de nómina')).toBeVisible();
    await page.getByRole('button', { name: 'Guardar parámetros' }).click();
    await expect(page.getByText('Salario mínimo no válido.')).toBeVisible();
    for (const year of new Set([ym(1).slice(0, 4), ym(0).slice(0, 4)])) {
      await page.getByLabel('Año', { exact: true }).fill(year);
      await page.getByLabel('Salario mínimo mensual (COP)').fill('1.423.500,00');
      await page.getByLabel('Auxilio de transporte (COP)').fill('200.000,00');
      await page.getByLabel('Valor de la UVT (COP)').fill('49.799,00');
      await page.getByRole('button', { name: 'Guardar parámetros' }).click();
      await expect(page.getByText(`Parámetros de ${year} guardados.`)).toBeVisible();
    }
    await expect(page.getByText('Faltan por guardar 26.')).toBeVisible();
    await page.getByRole('button', { name: 'Guardar cuentas' }).click();
    await expect(page.getByText('Cuentas de nómina guardadas.')).toBeVisible();
    await expect(page.getByText('Todas están guardadas.')).toBeVisible();
    await checkDesign(page, 'parámetros de nómina');
    await shot(page, 'nomina-parametros');
  });

  test('registra empleados con validaciones y cambia un salario', async ({ page }) => {
    await nav(page, 'Empleados').click();
    await expect(heading(page, 'Empleados')).toBeVisible();
    await expect(page.getByText('Todavía no hay empleados.')).toBeVisible();
    await page.getByRole('button', { name: 'Nuevo empleado' }).click();
    await page.getByRole('button', { name: 'Registrar empleado' }).click();
    await expect(page.getByText('Escribe el número de documento.')).toBeVisible();
    await expect(page.getByText('Salario no válido. Ejemplo: 2.500.000,00')).toBeVisible();
    await page.getByLabel('Número de documento').fill('1075000001');
    await page.getByLabel('Nombre completo').fill('Ana Pérez');
    await page.getByLabel('Fecha de ingreso').fill('2024-01-15');
    await page.getByLabel(/^Salario mensual/).fill('2.000.000,00');
    await checkDesign(page, 'nuevo empleado');
    await page.getByRole('button', { name: 'Registrar empleado' }).click();
    await expect(page.getByText('Empleado Ana Pérez registrado.')).toBeVisible();

    await page.getByRole('button', { name: 'Nuevo empleado' }).click();
    await page.getByLabel('Número de documento').fill('1075000002');
    await page.getByLabel('Nombre completo').fill('Bruno Díaz');
    await page.getByLabel('Fecha de ingreso').fill('2024-03-01');
    await page.getByLabel(/^Salario mensual/).fill('10.000.000,00');
    await page.getByRole('button', { name: 'Registrar empleado' }).click();
    await expect(page.getByText('Empleado Bruno Díaz registrado.')).toBeVisible();

    await page.getByRole('row', { name: /Bruno Díaz/ }).getByRole('button', { name: 'Cambiar salario' }).click();
    await page.getByLabel('Nuevo salario de Bruno Díaz').fill('12.000.000,00');
    await page.getByRole('button', { name: 'Guardar', exact: true }).click();
    await expect(page.getByText(/Salario de Bruno Díaz actualizado/)).toBeVisible();
    await expect(page.getByRole('row', { name: /Bruno Díaz/ })).toContainText('12.000.000,00');
    await shot(page, 'nomina-empleados');
  });

  test('calcula, liquida y contabiliza la nómina del mes anterior', async ({ page }) => {
    await nav(page, 'Nómina').click();
    await expect(heading(page, 'Nómina')).toBeVisible();
    await expect(page.getByLabel('Mes (AAAA-MM)')).toHaveValue(ym(1));
    await page.getByLabel('Días de Ana Pérez').fill('40');
    await page.getByRole('button', { name: 'Calcular' }).click();
    await expect(page.getByText('Ana Pérez: los días trabajados van de 0 a 30.')).toBeVisible();
    await page.getByLabel('Días de Ana Pérez').fill('');
    await page.getByRole('button', { name: 'Calcular' }).click();
    await expect(page.getByRole('row', { name: /Ana Pérez/ }).last()).toContainText('2.040.000,00');
    await expect(page.getByText('Neto a pagar')).toBeVisible();
    await expect(page.getByText('Neto a pagar').locator('..').getByText('12.260.000,00')).toBeVisible();
    await checkDesign(page, 'vista previa de nómina');
    await page.getByRole('button', { name: 'Liquidar y contabilizar' }).click();
    await expect(page.getByText(/Nómina de .* liquidada y contabilizada en NM\d+: 12\.260\.000,00 netos por pagar a 2 empleados\./)).toBeVisible();
    await shot(page, 'nomina-liquidada');
  });

  test('paga la nómina y los aportes desde el detalle de la corrida', async ({ page }) => {
    const row = page.getByRole('row', { name: new RegExp(`${ym(1)} NM`) });
    await expect(row).toContainText('Salarios por pagar');
    await row.getByRole('button', { name: 'Ver detalle' }).click();
    await expect(page.getByText('Obligaciones de esta nómina')).toBeVisible();
    await expect(page.getByText('Retención en la fuente: 700.000,00')).toBeVisible();
    await page.getByRole('button', { name: 'Pagar la nómina' }).click();
    await page.getByRole('button', { name: 'Registrar el pago' }).click();
    await expect(page.getByText('Indica la cuenta de caja o bancos de donde sale el dinero.')).toBeVisible();
    await page.getByLabel('Cuenta de caja o bancos').fill('111005');
    await page.getByRole('button', { name: 'Registrar el pago' }).click();
    await expect(page.getByText(`Nómina de ${ym(1)} pagada.`)).toBeVisible();
    await expect(page.getByRole('row', { name: new RegExp(`${ym(1)} NM`) })).toContainText('Salarios pagados');
    await page.getByRole('button', { name: 'Pagar los aportes' }).click();
    await page.getByLabel('Cuenta de caja o bancos').fill('111005');
    await page.getByRole('button', { name: 'Registrar el pago' }).click();
    await expect(page.getByText(`Aportes de ${ym(1)} pagados.`)).toBeVisible();
    await expect(page.getByRole('row', { name: new RegExp(`${ym(1)} NM`) })).toContainText('aportes pagados');
    await expect(page.getByRole('button', { name: 'Anular' })).toHaveCount(0);
    await checkDesign(page, 'nómina pagada');
  });

  test('muestra el desprendible de un empleado', async ({ page }) => {
    await nav(page, 'Nómina').click();
    // El detalle de la corrida sigue abierto del paso anterior.
    await expect(page.getByRole('row', { name: new RegExp(`${ym(1)} NM`) }).getByRole('button', { name: 'Ocultar detalle' })).toBeVisible();
    await page.getByRole('row', { name: /Ana Pérez/ }).last().getByRole('button', { name: 'Ver' }).click();
    const slip = page.getByRole('region', { name: 'Desprendible de pago de Ana Pérez' });
    await expect(slip).toContainText('Total devengado');
    await expect(slip).toContainText('2.200.000,00');
    await expect(slip).toContainText('Neto a pagar');
    await expect(slip).toContainText('2.040.000,00');
    await expect(slip).toContainText('Pagado el');
    await checkDesign(page, 'desprendible de pago');
    await shot(page, 'nomina-desprendible');
  });

  test('liquida la prima del semestre y la paga', async ({ page }) => {
    const half = Number(ym(1).slice(5)) <= 6 ? 1 : 2;
    await nav(page, 'Prestaciones sociales').click();
    await expect(heading(page, 'Prestaciones sociales')).toBeVisible();
    await page.getByLabel(/^Semestre/).fill('2026-3');
    await page.getByRole('button', { name: 'Calcular' }).click();
    await expect(page.getByText('La prima va por semestre')).toBeVisible();
    await page.getByLabel(/^Semestre/).fill(`${ym(1).slice(0, 4)}-${half}`);
    await page.getByRole('button', { name: 'Calcular' }).click();
    await expect(page.getByText(/Hay nóminas liquidadas de 1 de los 6 meses/)).toBeVisible();
    await expect(page.getByRole('row', { name: /Ana Pérez/ })).toContainText('183.333,33');
    await checkDesign(page, 'prima de servicios');
    await page.getByRole('button', { name: 'Liquidar y contabilizar' }).click();
    await expect(page.getByText(/Liquidación PR\d+ registrada: /)).toBeVisible();
    const row = page.getByRole('row', { name: /Prima de servicios/ });
    await expect(row).toContainText('Pendiente de pago');
    await row.getByRole('button', { name: 'Pagar' }).click();
    await page.getByLabel('Cuenta de caja o bancos').fill('111005');
    await page.getByRole('button', { name: 'Registrar el pago' }).click();
    await expect(page.getByText(/Pago de PR\d+ registrado\./)).toBeVisible();
    await expect(page.getByRole('row', { name: /Prima de servicios/ })).toContainText('Pagada el');
    await shot(page, 'nomina-prestaciones');
  });

  test('los reportes traen los aportes del mes y las provisiones cuadran con el libro', async ({ page }) => {
    await nav(page, 'Reportes de nómina').click();
    await expect(heading(page, 'Reportes de nómina')).toBeVisible();
    await page.getByLabel('Desde (AAAA-MM)').fill(ym(1));
    await page.getByLabel('Hasta (AAAA-MM)').fill(ym(1));
    await page.getByRole('button', { name: 'Ver aportes' }).click();
    await expect(page.getByRole('row', { name: /Bruno Díaz/ })).toContainText('12.000.000,00');
    await expect(page.getByText('Las provisiones cuadran con el libro.')).toBeVisible();
    await checkDesign(page, 'reportes de nómina');
    await shot(page, 'nomina-reportes');
  });

  test('liquida el contrato de un empleado que se retira y paga la liquidación', async ({ page }) => {
    await nav(page, 'Liquidación de contrato').click();
    await expect(heading(page, 'Liquidación de contrato')).toBeVisible();
    await page.getByRole('button', { name: 'Calcular' }).click();
    await expect(page.getByText('Elige el empleado.')).toBeVisible();
    await page.getByLabel('Empleado', { exact: true }).selectOption({ label: 'Bruno Díaz' });
    await page.getByLabel('Fecha de retiro').fill(`${ym(1)}-28`);
    await page.getByLabel('Días de vacaciones pendientes').fill('5');
    await page.getByRole('button', { name: 'Calcular' }).click();
    // La prima de este semestre ya se liquidó en el paso anterior: no se repite.
    await expect(page.getByRole('row', { name: /Prima de servicios del semestre/ })).toContainText('ya liquidada');
    await expect(page.getByRole('row', { name: /Cesantías del año/ })).toContainText('1.000.000,00');
    await expect(page.getByRole('row', { name: /Intereses sobre cesantías/ })).toContainText('10.000,00');
    await expect(page.getByRole('row', { name: /Vacaciones pendientes \(5 días\)/ })).toContainText('2.000.000,00');
    await expect(page.getByText('Neto a pagar').locator('..').getByText('3.010.000,00').last()).toBeVisible();
    await checkDesign(page, 'liquidación de contrato');
    await page.getByRole('button', { name: 'Liquidar y contabilizar' }).click();
    await expect(page.getByText(/Liquidación LC\d+ registrada para Bruno Díaz: 3\.010\.000,00 por pagar\./)).toBeVisible();
    const row = page.getByRole('row', { name: /Bruno Díaz/ }).last();
    await expect(row).toContainText('Pendiente de pago');
    await row.getByRole('button', { name: 'Pagar' }).click();
    await page.getByLabel('Cuenta de caja o bancos').fill('111005');
    await page.getByRole('button', { name: 'Registrar el pago' }).click();
    await expect(page.getByText(/Pago de LC\d+ registrado\./)).toBeVisible();
    await expect(page.getByRole('row', { name: /Bruno Díaz/ }).last()).toContainText('Pagada el');
    await shot(page, 'nomina-liquidacion-contrato');
    await nav(page, 'Empleados').click();
    await expect(page.getByRole('row', { name: /Bruno Díaz/ })).toContainText('Inactivo');
  });
});
