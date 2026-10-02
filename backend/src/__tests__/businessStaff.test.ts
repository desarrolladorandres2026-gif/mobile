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
 * frontera: qué ve cada papel y qué sigue siendo solo del dueño.
 */
describe('Empleados del comercio', () => {
  let owner: any;
  let business: any;
  let empleado: any;
  let ownerId: string;
  let businessId: string;

  /** Invita y acepta: el camino completo hasta tener acceso. */
  async function addActive(user: any, role: any, by = ownerId) {
    const row = await businessStaffService.invite(businessId, { phone: user.phone, role }, by);
    await businessStaffService.respondToInvitation(user._id.toString(), row._id.toString(), true);
    return row;
  }

  const permsOf = (user: any) =>
    businessStaffService.permissionsFor(user._id.toString(), businessId);

  beforeEach(async () => {
    owner = await makeUser({ role: UserRole.BUSINESS });
    business = await makeBusiness(owner._id, { lat: GARZON.lat, lng: GARZON.lng });
    empleado = await makeUser({ role: UserRole.BUSINESS, phone: '3009998877' });
    ownerId = owner._id.toString();
    businessId = business._id.toString();
  });

  it('el dueño lo puede todo sin estar en la tabla de empleados', async () => {
    // Guardarlo también aquí crearía dos sitios donde consultar quién manda.
    expect(await BusinessStaff.countDocuments({ businessId: business._id })).toBe(0);

    const permissions = await permsOf(owner);

    expect(permissions).toEqual(expect.arrayContaining(Object.values(BusinessPermission)));
  });

  it('un desconocido no puede nada', async () => {
    const extraño = await makeUser({ role: UserRole.CLIENT });
    expect(await permsOf(extraño)).toEqual([]);
  });

  it('el administrador opera y vende, pero no ve el dinero ni los ajustes', async () => {
    await addActive(empleado, BusinessRole.MANAGER);
    const permissions = await permsOf(empleado);

    expect(permissions).toContain(BusinessPermission.ORDERS_MANAGE);
    expect(permissions).toContain(BusinessPermission.CATALOG_CHANGE_PRICE);
    expect(permissions).toContain(BusinessPermission.PROMOTIONS_MANAGE);
    expect(permissions).toContain(BusinessPermission.TEAM_INVITE);

    // Liquidaciones, finanzas, documentos, datos del negocio y seguridad son
    // donde se ve y se dirige el dinero: delegarlas es otra decisión.
    for (const denied of [
      BusinessPermission.SETTLEMENTS_VIEW,
      BusinessPermission.SETTLEMENTS_MANAGE,
      BusinessPermission.FINANCIAL_VIEW,
      BusinessPermission.DOCUMENTS_VIEW,
      BusinessPermission.DOCUMENTS_MANAGE,
      BusinessPermission.BUSINESS_EDIT,
      BusinessPermission.SETTINGS_MANAGE,
      BusinessPermission.SECURITY_MANAGE,
    ]) {
      expect(permissions).not.toContain(denied);
    }
  });

  it('el operador trabaja pedidos y solo consulta el catálogo', async () => {
    await addActive(empleado, BusinessRole.OPERATOR);

    expect(await permsOf(empleado)).toEqual([
      BusinessPermission.ORDERS_VIEW,
      BusinessPermission.ORDERS_MANAGE,
      BusinessPermission.CATALOG_VIEW,
      BusinessPermission.STORE_TOGGLE,
    ]);
  });

  it('el cajero ve pedidos y las ventas del turno, nada más', async () => {
    await addActive(empleado, BusinessRole.CASHIER);

    expect(await permsOf(empleado)).toEqual([
      BusinessPermission.ORDERS_VIEW,
      BusinessPermission.ORDERS_MANAGE,
      BusinessPermission.SHIFT_VIEW,
    ]);
  });

  it('assertCan deja pasar lo permitido y frena lo demás con 403', async () => {
    await addActive(empleado, BusinessRole.OPERATOR);
    const id = empleado._id.toString();

    await expect(
      businessStaffService.assertCan(id, businessId, BusinessPermission.ORDERS_MANAGE)
    ).resolves.toBeDefined();

    await expect(
      businessStaffService.assertCan(id, businessId, BusinessPermission.CATALOG_EDIT, 'Sin permisos para modificar productos.')
    ).rejects.toMatchObject({ statusCode: 403, message: 'Sin permisos para modificar productos.' });
  });

  it('una invitación pendiente no da ningún acceso hasta que se acepta', async () => {
    const row = await businessStaffService.invite(businessId, { phone: empleado.phone, role: BusinessRole.MANAGER }, ownerId);
    expect(row.status).toBe('pending');
    expect(await permsOf(empleado)).toEqual([]);
    expect(await businessStaffService.accessibleBusinesses(empleado._id.toString())).toHaveLength(0);

    await businessStaffService.respondToInvitation(empleado._id.toString(), row._id.toString(), true);
    expect(await permsOf(empleado)).toContain(BusinessPermission.ORDERS_MANAGE);
  });

  it('solo el invitado puede responder su invitación', async () => {
    const row = await businessStaffService.invite(businessId, { phone: empleado.phone, role: BusinessRole.CASHIER }, ownerId);
    const otro = await makeUser({ role: UserRole.BUSINESS });

    await expect(
      businessStaffService.respondToInvitation(otro._id.toString(), row._id.toString(), true)
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('rechazar la invitación la elimina', async () => {
    const row = await businessStaffService.invite(businessId, { phone: empleado.phone, role: BusinessRole.CASHIER }, ownerId);
    await businessStaffService.respondToInvitation(empleado._id.toString(), row._id.toString(), false);
    expect(await BusinessStaff.countDocuments({ businessId: business._id })).toBe(0);
  });

  it('no se puede invitar a alguien sin cuenta en ZIPP', async () => {
    // El empleado entra con su propia cuenta. Crearla desde el panel del
    // negocio llevaría de vuelta a las credenciales compartidas.
    await expect(
      businessStaffService.invite(businessId, { phone: '3001112233', role: BusinessRole.OPERATOR }, ownerId)
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('no se puede invitar al propio dueño', async () => {
    await expect(
      businessStaffService.invite(businessId, { phone: owner.phone, role: BusinessRole.MANAGER }, ownerId)
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('reinvitar a alguien cambia su papel y exige aceptar de nuevo', async () => {
    await addActive(empleado, BusinessRole.OPERATOR);
    await businessStaffService.invite(businessId, { phone: empleado.phone, role: BusinessRole.MANAGER }, ownerId);

    expect(await BusinessStaff.countDocuments({ businessId: business._id })).toBe(1);
    expect(await permsOf(empleado)).toEqual([]);
  });

  it('un administrador solo gestiona al personal operativo', async () => {
    const admin = empleado;
    await addActive(admin, BusinessRole.MANAGER);
    const adminId = admin._id.toString();

    const otroAdmin: any = await makeUser({ role: UserRole.BUSINESS, phone: '3001230000' });
    const cajero: any = await makeUser({ role: UserRole.BUSINESS, phone: '3001240000' });

    // No puede crear a otro administrador…
    await expect(
      businessStaffService.invite(businessId, { phone: otroAdmin.phone, role: BusinessRole.MANAGER }, adminId)
    ).rejects.toMatchObject({ statusCode: 403 });

    // …pero sí a un cajero, y puede suspenderlo y cambiarle el papel.
    const row = await addActive(cajero, BusinessRole.CASHIER, adminId);
    await businessStaffService.changeRole(businessId, row._id.toString(), BusinessRole.OPERATOR, adminId);
    expect((await BusinessStaff.findById(row._id))!.role).toBe(BusinessRole.OPERATOR);

    // Ascender a alguien a administrador sigue siendo del propietario.
    await expect(
      businessStaffService.changeRole(businessId, row._id.toString(), BusinessRole.MANAGER, adminId)
    ).rejects.toMatchObject({ statusCode: 403 });

    // Y no puede tocar a otro administrador (ni a sí mismo).
    const adminRow = await BusinessStaff.findOne({ businessId: business._id, userId: admin._id });
    await expect(
      businessStaffService.remove(businessId, adminRow!._id.toString(), adminId)
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('suspender corta el acceso pero conserva el registro; reactivar lo devuelve', async () => {
    const row = await addActive(empleado, BusinessRole.OPERATOR);

    await businessStaffService.setSuspended(businessId, row._id.toString(), true, ownerId);
    const saved = await BusinessStaff.findById(row._id);
    expect(saved!.status).toBe('suspended');
    expect(await permsOf(empleado)).toEqual([]);

    await businessStaffService.setSuspended(businessId, row._id.toString(), false, ownerId);
    expect(await permsOf(empleado)).toContain(BusinessPermission.ORDERS_MANAGE);
  });

  it('eliminar quita el acceso', async () => {
    const row = await addActive(empleado, BusinessRole.OPERATOR);
    await businessStaffService.remove(businessId, row._id.toString(), ownerId);

    expect(await BusinessStaff.findById(row._id)).toBeNull();
    expect(await permsOf(empleado)).toEqual([]);
  });

  it('un papel `staff` guardado antes de la migración se lee como operador', async () => {
    await BusinessStaff.collection.insertOne({
      businessId: business._id,
      userId: empleado._id,
      role: 'staff',
      isActive: true,
    });
    expect(await permsOf(empleado)).toContain(BusinessPermission.CATALOG_VIEW);
    expect(await permsOf(empleado)).not.toContain(BusinessPermission.CATALOG_EDIT);
  });

  it('el empleado ve el negocio en su panel', async () => {
    await addActive(empleado, BusinessRole.MANAGER);

    const accessible = await businessStaffService.accessibleBusinesses(empleado._id.toString());
    expect(accessible.map((b: any) => b._id.toString())).toContain(businessId);
  });

  it('un empleado de un negocio dado de baja deja de entrar', async () => {
    await addActive(empleado, BusinessRole.MANAGER);
    // "Dado de baja" es archivado. `isActive` es el Abierto/Cerrado del día:
    // un negocio cerrado sigue siendo accesible para que el personal lo abra
    // (ver businessStaffOrders.test).
    await Business.updateOne({ _id: business._id }, { isArchived: true });

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
