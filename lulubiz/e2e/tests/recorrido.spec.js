import { expect, test } from '@playwright/test';
import { totpAt } from '../../backend/src/auth/totp.js';
import { PASSWORD, checkDesign, login, shot, tokenFromMail, nav, sectionListed } from './helpers.js';

const OWNER = 'marta@andina.co';
const READER = 'lector@andina.co';
const NEW_PASSWORD = 'clave-nueva-muy-larga-77';
const month = new Date().toISOString().slice(0, 7);

const heading = (page, name) => page.getByRole('heading', { name, level: 1 });

let recoveryCodes = [];

test.describe.serial('recorrido completo de Lulubiz', () => {
  test.beforeAll(async ({ request }) => {
    await request.post('/__reset');
  });

  test('la raíz lleva a iniciar sesión, y la pantalla cumple el reglamento de diseño', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/iniciar-sesion$/);
    await expect(heading(page, 'Iniciar sesión')).toBeVisible();
    await checkDesign(page, 'iniciar sesión');
    await shot(page, 'iniciar-sesion');
  });

  test('crear la empresa, confirmar el correo e iniciar sesión', async ({ page, request }) => {
    await page.goto('/iniciar-sesion');
    await page.getByRole('link', { name: 'Crear una empresa' }).click();
    await expect(heading(page, 'Crear una empresa')).toBeVisible();
    await page.getByLabel('Nombre de la empresa').fill('Comercial Andina SAS');
    await page.getByLabel('Tu nombre').fill('Marta Ruiz');
    await page.getByLabel('Correo electrónico').fill(OWNER);
    await page.getByLabel('Contraseña').fill('corta');
    await checkDesign(page, 'registro');
    await shot(page, 'registro');
    await page.getByRole('button', { name: 'Crear empresa' }).click();
    await expect(page.getByRole('alert')).toContainText(/12 caracteres/);

    await page.getByLabel('Contraseña').fill(PASSWORD);
    await page.getByRole('button', { name: 'Crear empresa' }).click();
    await expect(heading(page, 'Revisa tu correo')).toBeVisible();

    const token = await tokenFromMail(request, OWNER);
    await page.goto(`/verificar-correo#token=${encodeURIComponent(token)}`);
    await expect(page.getByText('Tu correo quedó confirmado.')).toBeVisible();
    expect(page.url()).not.toContain('token='); // el token no se queda en la barra de direcciones

    await login(page, OWNER);
    await expect(page).toHaveURL(/\/app\/asientos$/);
    await expect(heading(page, 'Asientos')).toBeVisible();
    await expect(page.getByText('Comercial Andina SAS')).toBeVisible();
    await expect(page.getByText('No hay asientos con estos filtros.')).toBeVisible();
    for (const name of ['Asientos', 'Plan de cuentas', 'Terceros', 'Saldos', 'Períodos', 'Miembros', 'Auditoría', 'Mi cuenta']) {
      await expect(await sectionListed(page, name)).toBeVisible();
    }
    await checkDesign(page, 'asientos vacío');
    await shot(page, 'asientos-vacio');
  });

  test('la sesión es una cookie HttpOnly SameSite=Strict que el código de la página no ve', async ({ page, context }) => {
    await login(page, OWNER);
    await expect(page).toHaveURL(/\/app\//);
    const cookies = await context.cookies();
    const session = cookies.find((c) => c.name === 'lulubiz_session');
    expect(session).toMatchObject({ httpOnly: true, sameSite: 'Strict', path: '/' });
    expect(await page.evaluate(() => document.cookie)).toBe('');
    expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain(session.value);
  });

  test('plan de cuentas: cargar el plan de Colombia y crear cuentas', async ({ page }) => {
    await login(page, OWNER);
    await nav(page, 'Plan de cuentas').click();
    await expect(heading(page, 'Plan de cuentas')).toBeVisible();

    await page.getByRole('button', { name: 'Cargar el plan de Colombia' }).click();
    await expect(page.getByText('Es un borrador', { exact: false }).first()).toBeVisible();
    await page.getByRole('button', { name: 'Sí, cargar el plan' }).click();
    await expect(page.getByText(/Se crearon \d+ cuentas/)).toBeVisible();
    await expect(page.getByRole('cell', { name: 'Disponible' })).toBeVisible();
    await shot(page, 'plan-de-cuentas');

    await page.getByRole('button', { name: 'Nueva cuenta' }).click();
    await page.getByLabel('Código', { exact: true }).fill('110505');
    await page.getByLabel('Nombre', { exact: true }).fill('Caja general');
    await page.getByLabel('Cuenta superior').selectOption('11');
    await checkDesign(page, 'nueva cuenta');
    await page.getByRole('button', { name: 'Crear cuenta' }).click();
    await expect(page.getByText('Se creó la cuenta 110505 · Caja general.')).toBeVisible();

    await page.getByRole('button', { name: 'Nueva cuenta' }).click();
    await page.getByLabel('Código', { exact: true }).fill('413505');
    await page.getByLabel('Nombre', { exact: true }).fill('Ventas de mercancía');
    await page.getByLabel('Tipo').selectOption('income');
    await page.getByLabel('Cuenta superior').selectOption('41');
    await page.getByRole('button', { name: 'Crear cuenta' }).click();
    await expect(page.getByText('Se creó la cuenta 413505 · Ventas de mercancía.')).toBeVisible();

    // Un código repetido se rechaza con un mensaje claro.
    await page.getByRole('button', { name: 'Nueva cuenta' }).click();
    await page.getByLabel('Código', { exact: true }).fill('110505');
    await page.getByLabel('Nombre', { exact: true }).fill('Otra caja');
    await page.getByLabel('Cuenta superior').selectOption('11');
    await page.getByRole('button', { name: 'Crear cuenta' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'ya existe la cuenta 110505' })).toBeVisible();
    // Desactivar pide confirmación y se puede revertir.
    const row = page.getByRole('row', { name: /110505/ });
    await row.getByRole('button', { name: 'Desactivar' }).click();
    await row.getByRole('button', { name: 'Cancelar' }).click();
    await expect(row).toContainText('Activa');
    await row.getByRole('button', { name: 'Desactivar' }).click();
    await row.getByRole('button', { name: 'Sí, desactivar' }).click();
    await expect(row).toContainText('Inactiva');
    await row.getByRole('button', { name: 'Reactivar' }).click();
    await expect(row.getByRole('cell', { name: 'Activa', exact: true })).toBeVisible();
    await checkDesign(page, 'plan de cuentas');
  });

  test('terceros: el dígito del NIT se calcula solo y el documento se muestra formateado', async ({ page }) => {
    await login(page, OWNER);
    await nav(page, 'Terceros').click();
    await page.getByRole('button', { name: 'Nuevo tercero' }).click();
    await page.getByLabel('Nombre o razón social').fill('Droguería Los Andes');
    await page.getByLabel('Número de documento').fill('890903938');
    await expect(page.getByLabel('Dígito')).toHaveValue('8');
    await page.getByLabel('Correo electrónico').fill('compras@andes.co');
    await checkDesign(page, 'nuevo tercero');
    await shot(page, 'nuevo-tercero');
    await page.getByRole('button', { name: 'Crear tercero' }).click();
    await expect(page.getByText('Tercero creado: Droguería Los Andes.')).toBeVisible();
    await expect(page.getByRole('cell', { name: 'NIT 890.903.938-8' })).toBeVisible();

    // El mismo documento dos veces se rechaza.
    await page.getByRole('button', { name: 'Nuevo tercero' }).click();
    await page.getByLabel('Nombre o razón social').fill('Otra droguería');
    await page.getByLabel('Número de documento').fill('890903938');
    await page.getByRole('button', { name: 'Crear tercero' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'ya existe un tercero' })).toBeVisible();
    await page.getByRole('button', { name: 'Cancelar' }).click();

    await page.getByLabel('Buscar').fill('droguer');
    await expect(page.getByRole('cell', { name: 'Droguería Los Andes' })).toBeVisible();
    await page.getByLabel('Buscar').fill('zzz');
    await expect(page.getByText('No hay terceros con estos filtros.')).toBeVisible();
    await page.getByLabel('Buscar').fill('');

    await page.getByRole('button', { name: 'Desactivar' }).click();
    await expect(page.getByRole('cell', { name: 'Inactivo' })).toBeVisible();
    await page.getByRole('button', { name: 'Activar' }).click();
    await expect(page.getByRole('cell', { name: 'Activo' })).toBeVisible();
    await checkDesign(page, 'terceros');
  });

  test('asientos: valida antes de enviar, registra, muestra las líneas y revierte', async ({ page }) => {
    await login(page, OWNER);
    await page.getByRole('button', { name: 'Nuevo asiento' }).click();

    await page.getByLabel('Cuenta de la línea 1').fill('110505');
    await page.getByLabel('Débito de la línea 1').fill('1.190.000,50');
    await page.getByLabel('Cuenta de la línea 2').fill('413505');
    await page.getByLabel('Crédito de la línea 2').fill('1.190.000');
    await expect(page.getByText('No cuadra: diferencia de 0,50 a favor de los débitos.')).toBeVisible();
    await expect(page.getByRole('paragraph').filter({ hasText: 'Caja general' })).toBeVisible(); // el nombre de la cuenta aparece al elegirla

    await page.getByRole('button', { name: 'Registrar asiento' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'no cuadra' })).toBeVisible();
    await checkDesign(page, 'nuevo asiento con error');
    await shot(page, 'asiento-con-error');

    await page.getByLabel('Crédito de la línea 2').fill('1.190.000,50');
    await expect(page.getByText('El asiento cuadra.')).toBeVisible();
    await page.getByRole('button', { name: 'Registrar asiento' }).click();
    await expect(page.getByText('Se registró el asiento CC-1.')).toBeVisible();
    const row = page.getByRole('row', { name: /CC-1/ });
    await expect(row).toContainText('1.190.000,50');
    await expect(row).toContainText('Vigente');

    await row.getByRole('button', { name: 'Ver líneas' }).click();
    await expect(page.getByRole('cell', { name: 'Ventas de mercancía', exact: true })).toBeVisible();
    await shot(page, 'asientos-con-datos');
    await checkDesign(page, 'asientos con datos');

    await row.getByRole('button', { name: 'Revertir' }).click();
    await row.getByRole('button', { name: 'Sí, revertir' }).click();
    await expect(page.getByText(/CC-1 quedó revertido/)).toBeVisible();
    await expect(page.getByRole('row', { name: /CC-1/ }).first()).toContainText('Revertido');
    await expect(page.getByRole('row', { name: /CC-2/ })).toContainText('Es una reversión');
  });

  test('saldos: débitos y créditos del período', async ({ page }) => {
    await login(page, OWNER);
    await nav(page, 'Saldos').click();
    await page.getByLabel('Cuenta').fill('110505');
    await page.getByRole('button', { name: 'Consultar saldo' }).click();
    const row = page.getByRole('row', { name: /110505/ });
    await expect(row).toContainText('1.190.000,50');
    await expect(row).toContainText('0,00'); // la reversión deja el saldo en cero
    await checkDesign(page, 'saldos');
    await shot(page, 'saldos');
  });

  test('períodos: un período cerrado rechaza asientos, y reabrirlo los permite', async ({ page }) => {
    await login(page, OWNER);
    await nav(page, 'Períodos').click();
    const row = page.getByRole('row', { name: new RegExp(month) });
    await expect(row).toContainText('Abierto');
    await row.getByRole('button', { name: 'Cerrar' }).click();
    await row.getByRole('button', { name: 'Sí, cerrar' }).click();
    await expect(page.getByText(`El período ${month} quedó cerrado`)).toBeVisible();
    await expect(row).toContainText('Cerrado');
    await shot(page, 'periodos');

    await nav(page, 'Asientos').click();
    await page.getByRole('button', { name: 'Nuevo asiento' }).click();
    await page.getByLabel('Cuenta de la línea 1').fill('110505');
    await page.getByLabel('Débito de la línea 1').fill('1000');
    await page.getByLabel('Cuenta de la línea 2').fill('413505');
    await page.getByLabel('Crédito de la línea 2').fill('1000');
    await page.getByRole('button', { name: 'Registrar asiento' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'cerrado' })).toBeVisible();

    await nav(page, 'Períodos').click();
    await row.getByRole('button', { name: 'Reabrir' }).click();
    await row.getByRole('button', { name: 'Sí, reabrir' }).click();
    await expect(row).toContainText('Abierto');
    await checkDesign(page, 'períodos');
  });

  test('invitar a un lector: acepta con su cuenta nueva y solo ve lo que su rol permite', async ({ page, browser, request }) => {
    await login(page, OWNER);
    await nav(page, 'Miembros').click();
    await page.getByLabel('Correo electrónico').fill(READER);
    await expect(page.getByRole('row', { name: new RegExp(OWNER) })).toContainText('Único propietario');
    await page.getByLabel('Rol', { exact: true }).selectOption('viewer');
    await page.getByRole('button', { name: 'Enviar invitación' }).click();
    await expect(page.getByText(`Enviamos la invitación a ${READER}.`)).toBeVisible();
    await checkDesign(page, 'miembros');
    await shot(page, 'miembros');

    const token = await tokenFromMail(request, READER);
    const guest = await (await browser.newContext({ baseURL: 'http://127.0.0.1:4100', locale: 'es-CO' })).newPage();
    await guest.goto(`/invitacion#token=${encodeURIComponent(token)}`);
    await expect(heading(guest, 'Te invitaron a Comercial Andina SAS')).toBeVisible();
    await expect(guest.getByText(/Entrarás como|Crea tu cuenta con lector@andina.co/)).toBeVisible();
    await guest.getByLabel('Tu nombre').fill('Luis Lector');
    await guest.getByLabel('Contraseña').fill(PASSWORD);
    await guest.getByRole('button', { name: 'Crear cuenta y aceptar' }).click();
    await expect(guest.getByText('Tu cuenta quedó creada.')).toBeVisible();

    await guest.getByLabel('Correo electrónico').fill(READER);
    await guest.getByLabel('Contraseña').fill(PASSWORD);
    await guest.getByRole('button', { name: 'Iniciar sesión' }).click();
    await expect(guest).toHaveURL(/\/app\/asientos$/);
    await expect(guest.getByRole('button', { name: 'Nuevo asiento' })).toHaveCount(0);
    for (const hidden of ['Miembros', 'Auditoría']) await expect(await sectionListed(guest, hidden)).toHaveCount(0);
    await expect(await sectionListed(guest, 'Plan de cuentas')).toBeVisible();
    await expect(guest.getByRole('row', { name: /CC-1/ }).getByRole('button', { name: 'Revertir' })).toHaveCount(0);
    await checkDesign(guest, 'vista de lector');
    await shot(guest, 'vista-lector');

    // Lo que la interfaz oculta, el servidor también lo niega.
    const tenantId = await guest.evaluate(async () => (await (await fetch('/v1/me')).json()).memberships[0].tenantId);
    const denied = await guest.evaluate(async (id) => (await fetch(`/v1/tenants/${id}/audit`)).status, tenantId);
    expect(denied).toBe(403);
    await guest.context().close();

    await page.reload();
    await expect(page.getByRole('cell', { name: READER })).toBeVisible();
  });

  test('auditoría: queda registro de lo que se hizo, con nombres legibles', async ({ page }) => {
    await login(page, OWNER);
    await nav(page, 'Auditoría').click();
    for (const text of ['Registró un asiento', 'Revirtió un asiento', 'Cerró un período', 'Reabrió un período', 'Invitó a una persona', 'Aceptó una invitación', 'Cargó el plan de cuentas inicial']) {
      await expect(page.getByRole('cell', { name: text }).first()).toBeVisible();
    }
    await expect(page.getByRole('cell', { name: OWNER }).first()).toBeVisible();
    await checkDesign(page, 'auditoría');
    await shot(page, 'auditoria');
  });

  test('verificación en dos pasos: activar, iniciar sesión con ella y con un código de recuperación', async ({ page }) => {
    await login(page, OWNER);
    await nav(page, 'Mi cuenta').click();
    await page.getByRole('button', { name: 'Activar verificación en dos pasos' }).click();
    await expect(page.getByRole('img', { name: /Código QR/ })).toBeVisible();
    await checkDesign(page, 'activar dos pasos (con QR)');
    await shot(page, 'dos-pasos-qr');

    const secret = (await page.getByText('Clave:').textContent()).replace('Clave:', '').trim();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    await page.getByLabel('Código de 6 dígitos').fill('000000');
    await page.getByRole('button', { name: 'Activar', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText(/inválido/);

    await page.getByLabel('Código de 6 dígitos').fill(totpAt(secret, Date.now()));
    await page.getByRole('button', { name: 'Activar', exact: true }).click();
    await expect(page.getByText('Guarda estos códigos de recuperación')).toBeVisible();
    recoveryCodes = await page.getByRole('main').getByRole('listitem').allTextContents();
    expect(recoveryCodes).toHaveLength(10);
    await shot(page, 'codigos-de-recuperacion');
    await page.getByLabel('Ya guardé los códigos en un lugar seguro').check();
    await page.getByRole('button', { name: 'Listo' }).click();
    await expect(page.getByText(/Activada\. Te quedan 10 códigos/)).toBeVisible();

    await page.getByRole('button', { name: 'Cerrar sesión' }).click();
    await login(page, OWNER);
    await expect(heading(page, 'Verificación en dos pasos')).toBeVisible();
    await checkDesign(page, 'segundo paso');
    await shot(page, 'segundo-paso');
    await page.getByLabel('Código').fill('123456');
    await page.getByRole('button', { name: 'Verificar' }).click();
    await expect(page.getByRole('alert')).toContainText(/inválido/);
    await page.getByLabel('Código').fill(recoveryCodes[0]);
    await page.getByRole('button', { name: 'Verificar' }).click();
    await expect(page).toHaveURL(/\/app\//);
    await nav(page, 'Mi cuenta').click();
    await expect(page.getByText(/Te quedan 9 códigos/)).toBeVisible();
  });

  test('recuperar la contraseña con el enlace del correo, que sirve una sola vez', async ({ page, request }) => {
    await page.goto('/iniciar-sesion');
    await page.getByRole('link', { name: 'Olvidé mi contraseña' }).click();
    await page.getByLabel('Correo electrónico').fill(OWNER);
    await page.getByRole('button', { name: 'Enviar enlace' }).click();
    await expect(page.getByText(/Si ese correo tiene una cuenta/)).toBeVisible();

    const token = await tokenFromMail(request, OWNER);
    await page.goto(`/restablecer-contrasena#token=${encodeURIComponent(token)}`);
    await page.getByLabel('Contraseña nueva').fill(NEW_PASSWORD);
    await page.getByLabel('Repite la contraseña').fill('otra-distinta-1234');
    await page.getByRole('button', { name: 'Cambiar contraseña' }).click();
    await expect(page.getByText('Las contraseñas no coinciden.')).toBeVisible();
    await page.getByLabel('Repite la contraseña').fill(NEW_PASSWORD);
    await page.getByRole('button', { name: 'Cambiar contraseña' }).click();
    await expect(page.getByText('Tu contraseña cambió y se cerraron tus sesiones.')).toBeVisible();

    await page.getByLabel('Correo electrónico').fill(OWNER);
    await page.getByLabel('Contraseña').fill(PASSWORD);
    await page.getByRole('button', { name: 'Iniciar sesión' }).click();
    await expect(page.getByRole('alert')).toContainText('credenciales inválidas');
    await page.getByLabel('Contraseña').fill(NEW_PASSWORD);
    await page.getByRole('button', { name: 'Iniciar sesión' }).click();
    await page.getByLabel('Código').fill(recoveryCodes[1]);
    await page.getByRole('button', { name: 'Verificar' }).click();
    await expect(page).toHaveURL(/\/app\//);

    // El mismo enlace ya no sirve.
    await page.goto(`/restablecer-contrasena#token=${encodeURIComponent(token)}`);
    await page.getByRole('button', { name: 'Cerrar sesión' }).click().catch(() => {});
  });

  test('una ruta de la aplicación sin sesión lleva a iniciar sesión, y una desconocida no rompe nada', async ({ page }) => {
    await page.goto('/app/asientos');
    await expect(page).toHaveURL(/\/iniciar-sesion$/);
    await page.goto('/ruta-que-no-existe');
    await expect(page).toHaveURL(/\/iniciar-sesion$/);
  });

  test('en el teléfono nada se sale de la pantalla', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto('/iniciar-sesion');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await shot(page, 'telefono-login');
    await page.getByLabel('Correo electrónico').fill(OWNER);
    await page.getByLabel('Contraseña').fill(NEW_PASSWORD);
    await page.getByRole('button', { name: 'Iniciar sesión' }).click();
    await page.getByLabel('Código').fill(recoveryCodes[2]);
    await page.getByRole('button', { name: 'Verificar' }).click();
    await expect(page).toHaveURL(/\/app\/asientos$/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect(page.getByRole('table')).toBeVisible();
    await shot(page, 'telefono-asientos');
  });
});
