import { describe, it, expect, beforeEach } from 'vitest';
import { BusinessStaff, BusinessRole, BusinessPermission, Business } from '../models';
import { UserRole } from '../types';
import { businessStaffService } from '../services/businessStaff.service';
import { makeUser, makeBusiness, GARZON } from './factories';

/**
 * Empleados de un comercio.
 *
 * Antes un negocio era una sola persona, así que el dueño le pasaba su
 * contraseña al cajero — y con ella iban las liquidaciones, los precios y
 * la cuenta bancaria donde entra el dinero. Estas pruebas fijan justo la
 * frontera: qué ve un encargado y qué sigue siendo solo del dueño.
 */
describe('Empleados del comercio', () => {
  let owner: any;
  let business: any;
  let empleado: any;

  beforeEach(async () => {
    owner = await makeUser({ role: UserRole.BUSINESS });
    business = await makeBusiness(owner._id, { lat: GARZON.lat, lng: GARZON.lng });
    empleado = await makeUser({ role: UserRole.BUSINESS, phone: '3009998877' });
  });

  it('el dueño lo puede todo sin estar en la tabla de empleados', async () => {
    // Guardarlo también aquí crearía dos sitios donde consultar quién manda.
    expect(await BusinessStaff.countDocuments({ businessId: business._id })).toBe(0);

    const permissions = await businessStaffService.permissionsFor(
      owner._id.toString(),
      business._id.toString()
    );

    expect(permissions).toContain(BusinessPermission.SETTLEMENTS_VIEW);
    expect(permissions).toContain(BusinessPermission.STAFF_MANAGE);
  });

  it('un desconocido no puede nada', async () => {
    const extraño = await makeUser({ role: UserRole.CLIENT });

    const permissions = await businessStaffService.permissionsFor(
      extraño._id.toString(),
      business._id.toString()
    );

    expect(permissions).toEqual([]);
  });

  it('el encargado opera y vende, pero no ve el dinero', async () => {
    await businessStaffService.add(
      business._id.toString(),
      empleado.phone,
      BusinessRole.MANAGER,
      owner._id.toString()
    );

    const permissions = await businessStaffService.permissionsFor(
      empleado._id.toString(),
      business._id.toString()
    );

    expect(permissions).toContain(BusinessPermission.ORDERS_MANAGE);
    expect(permissions).toContain(BusinessPermission.MENU_MANAGE);

    // Liquidaciones y ajustes son las dos pantallas donde se ve y se dirige
    // el dinero: delegarlas es una decisión distinta a delegar la operación.
    expect(permissions).not.toContain(BusinessPermission.SETTLEMENTS_VIEW);
    expect(permissions).not.toContain(BusinessPermission.SETTINGS_MANAGE);
    expect(permissions).not.toContain(BusinessPermission.STAFF_MANAGE);
  });

  it('el de mostrador solo ve los pedidos del día', async () => {
    await businessStaffService.add(
      business._id.toString(),
      empleado.phone,
      BusinessRole.STAFF,
      owner._id.toString()
    );

    const permissions = await businessStaffService.permissionsFor(
      empleado._id.toString(),
      business._id.toString()
    );

    expect(permissions).toEqual([
      BusinessPermission.ORDERS_VIEW,
      BusinessPermission.ORDERS_MANAGE,
    ]);
  });

  it('assertCan deja pasar lo permitido y frena lo demás', async () => {
    await businessStaffService.add(
      business._id.toString(),
      empleado.phone,
      BusinessRole.STAFF,
      owner._id.toString()
    );

    await expect(
      businessStaffService.assertCan(
        empleado._id.toString(),
        business._id.toString(),
        BusinessPermission.ORDERS_MANAGE
      )
    ).resolves.toBeUndefined();

    await expect(
      businessStaffService.assertCan(
        empleado._id.toString(),
        business._id.toString(),
        BusinessPermission.MENU_MANAGE
      )
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('no se puede dar de alta a alguien sin cuenta en ZIPP', async () => {
    // El empleado entra con su propia cuenta. Crearla desde el panel del
    // negocio llevaría de vuelta a las credenciales compartidas.
    await expect(
      businessStaffService.add(
        business._id.toString(),
        '3001112233',
        BusinessRole.STAFF,
        owner._id.toString()
      )
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('no se puede dar de alta al propio dueño', async () => {
    await expect(
      businessStaffService.add(
        business._id.toString(),
        owner.phone,
        BusinessRole.MANAGER,
        owner._id.toString()
      )
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('volver a dar de alta a alguien cambia su papel en vez de fallar', async () => {
    await businessStaffService.add(
      business._id.toString(),
      empleado.phone,
      BusinessRole.STAFF,
      owner._id.toString()
    );
    await businessStaffService.add(
      business._id.toString(),
      empleado.phone,
      BusinessRole.MANAGER,
      owner._id.toString()
    );

    expect(await BusinessStaff.countDocuments({ businessId: business._id })).toBe(1);

    const permissions = await businessStaffService.permissionsFor(
      empleado._id.toString(),
      business._id.toString()
    );
    expect(permissions).toContain(BusinessPermission.MENU_MANAGE);
  });

  it('quitar el acceso no borra el registro', async () => {
    const staff = await businessStaffService.add(
      business._id.toString(),
      empleado.phone,
      BusinessRole.STAFF,
      owner._id.toString()
    );

    await businessStaffService.remove(business._id.toString(), staff._id.toString());

    // Los pedidos que aceptó siguen apuntando a esa persona: para
    // investigar una incidencia hace falta poder saber quién era.
    const saved = await BusinessStaff.findById(staff._id);
    expect(saved).not.toBeNull();
    expect(saved!.isActive).toBe(false);

    expect(
      await businessStaffService.permissionsFor(
        empleado._id.toString(),
        business._id.toString()
      )
    ).toEqual([]);
  });

  it('el empleado ve el negocio en su panel', async () => {
    await businessStaffService.add(
      business._id.toString(),
      empleado.phone,
      BusinessRole.MANAGER,
      owner._id.toString()
    );

    const accessible = await businessStaffService.accessibleBusinesses(empleado._id.toString());
    expect(accessible.map((b: any) => b._id.toString())).toContain(business._id.toString());
  });

  it('un empleado de un negocio dado de baja deja de entrar', async () => {
    await businessStaffService.add(
      business._id.toString(),
      empleado.phone,
      BusinessRole.MANAGER,
      owner._id.toString()
    );
    await Business.updateOne({ _id: business._id }, { isActive: false });

    const accessible = await businessStaffService.accessibleBusinesses(empleado._id.toString());
    expect(accessible).toHaveLength(0);
  });

  it('el dueño sigue viendo su negocio aunque esté pausado', async () => {
    await Business.updateOne({ _id: business._id }, { isActive: false });

    // Pausarse es algo que el propio dueño hace; no puede dejarle fuera de
    // su propio panel, que es justo desde donde tiene que reactivarse.
    const accessible = await businessStaffService.accessibleBusinesses(owner._id.toString());
    expect(accessible).toHaveLength(1);
  });
});
