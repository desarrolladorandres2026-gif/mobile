import { describe, it, expect, beforeEach } from 'vitest';
import { Favorite, Business } from '../models';
import { UserRole } from '../types';
import { favoriteService } from '../services/favorite.service';
import { makeUser, makeBusiness, makeProduct, GARZON } from './factories';

/**
 * Favoritos.
 *
 * Vivían solo en el teléfono. Cambiar de móvil, reinstalar o limpiar los
 * datos borraba la lista entera sin aviso, y es de las pocas cosas que un
 * cliente construye a mano a lo largo de meses.
 */
describe('Favoritos', () => {
  let user: any;
  let business: any;
  let product: any;

  beforeEach(async () => {
    user = await makeUser({ role: UserRole.CLIENT });
    const owner = await makeUser({ role: UserRole.BUSINESS });
    business = await makeBusiness(owner._id, { lat: GARZON.lat, lng: GARZON.lng });
    product = await makeProduct(business._id);
  });

  it('marca un negocio', async () => {
    await favoriteService.add(user._id.toString(), 'business', business._id.toString());

    const ids = await favoriteService.ids(user._id.toString());
    expect(ids.businesses).toContain(business._id.toString());
  });

  it('marca un producto, que antes ni siquiera se podía', async () => {
    await favoriteService.add(user._id.toString(), 'product', product._id.toString());

    const ids = await favoriteService.ids(user._id.toString());
    expect(ids.products).toContain(product._id.toString());
  });

  it('marcar dos veces no crea dos favoritos', async () => {
    // La app puede reintentar tras quedarse sin conexión sin averiguar
    // antes si ya lo mandó.
    await favoriteService.add(user._id.toString(), 'business', business._id.toString());
    await favoriteService.add(user._id.toString(), 'business', business._id.toString());

    expect(await Favorite.countDocuments({ userId: user._id })).toBe(1);
  });

  it('no deja marcar algo que no existe', async () => {
    await expect(
      favoriteService.add(user._id.toString(), 'business', '507f1f77bcf86cd799439011')
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('quitar funciona, y quitar lo que no estaba no revienta', async () => {
    await favoriteService.add(user._id.toString(), 'business', business._id.toString());
    await favoriteService.remove(user._id.toString(), 'business', business._id.toString());

    const ids = await favoriteService.ids(user._id.toString());
    expect(ids.businesses).toHaveLength(0);

    await expect(
      favoriteService.remove(user._id.toString(), 'business', business._id.toString())
    ).resolves.toBeUndefined();
  });

  it('la lista trae el contenido, no solo los ids', async () => {
    await favoriteService.add(user._id.toString(), 'business', business._id.toString());
    await favoriteService.add(user._id.toString(), 'product', product._id.toString());

    const list = await favoriteService.list(user._id.toString());
    expect(list.businesses).toHaveLength(1);
    expect(list.products).toHaveLength(1);
    expect((list.businesses[0] as any).name).toBe(business.name);
  });

  it('un negocio dado de baja desaparece de la lista', async () => {
    await favoriteService.add(user._id.toString(), 'business', business._id.toString());
    await Business.updateOne({ _id: business._id }, { isActive: false });

    // Mostrarlo llevaría a una carta que no se puede pedir.
    const list = await favoriteService.list(user._id.toString());
    expect(list.businesses).toHaveLength(0);
  });

  it('los favoritos de uno no son los de otro', async () => {
    const otro = await makeUser({ role: UserRole.CLIENT });
    await favoriteService.add(user._id.toString(), 'business', business._id.toString());

    const ids = await favoriteService.ids(otro._id.toString());
    expect(ids.businesses).toHaveLength(0);
  });

  it('importa de una vez lo que la app tenía en el teléfono', async () => {
    const imported = await favoriteService.importLocal(user._id.toString(), [
      { kind: 'business', targetId: business._id.toString() },
      { kind: 'product', targetId: product._id.toString() },
    ]);

    expect(imported).toBe(2);
    const ids = await favoriteService.ids(user._id.toString());
    expect(ids.businesses).toHaveLength(1);
    expect(ids.products).toHaveLength(1);
  });

  it('importar dos veces no duplica: la migración es repetible', async () => {
    const items = [{ kind: 'business' as const, targetId: business._id.toString() }];

    await favoriteService.importLocal(user._id.toString(), items);
    const second = await favoriteService.importLocal(user._id.toString(), items);

    expect(second).toBe(0);
    expect(await Favorite.countDocuments({ userId: user._id })).toBe(1);
  });

  it('un id inválido en la importación no tumba el resto', async () => {
    const imported = await favoriteService.importLocal(user._id.toString(), [
      { kind: 'business', targetId: 'esto-no-es-un-id' },
      { kind: 'business', targetId: business._id.toString() },
    ]);

    expect(imported).toBe(1);
  });

  it('importar una lista vacía no hace nada y no falla', async () => {
    expect(await favoriteService.importLocal(user._id.toString(), [])).toBe(0);
  });
});
