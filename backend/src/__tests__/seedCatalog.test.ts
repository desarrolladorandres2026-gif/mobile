import { describe, it, expect, beforeEach } from 'vitest';
import { seedCatalog } from '../scripts/seedCatalog';
import { User, Business, Category, Product, Coupon, Address } from '../models';
import { CouponType, CouponFundedBy, CouponScope, UserRole } from '../types';
import { makeUser, makePricingConfig } from './factories';

/**
 * El README es una promesa, y hasta ahora no la cumplía nadie.
 *
 * `seed.ts` creaba ocho usuarios y paraba ahí, pero la guía de arranque
 * describe cinco comercios con nombre, una tabla de cupones y dos
 * direcciones guardadas. Quien seguía los pasos entraba al panel de
 * comercios y lo encontraba vacío, o escribía `BIENVENIDO` en el checkout
 * y recibía "cupón inválido" — sin manera de saber si se había equivocado
 * o si el sistema estaba roto.
 *
 * Estas pruebas son el contrato entre los dos documentos. Si alguien
 * cambia el catálogo sembrado sin tocar el README (o al revés), fallan
 * aquí en vez de fallar en la primera hora de quien intenta arrancar el
 * proyecto.
 *
 * Corren contra la Mongo en memoria de la suite, nunca contra la base de
 * desarrollo: `npm run seed` arranca con un `deleteMany({})` sobre todas
 * las colecciones, y comprobarlo "de verdad" sería borrar datos reales.
 */
describe('seedCatalog — lo que el README promete', () => {
  beforeEach(async () => {
    await makePricingConfig();
    // Los dueños y el cliente que el README nombra por teléfono.
    await makeUser({ name: 'Admin ZIPP', phone: '3001234567', role: UserRole.ADMIN });
    await User.updateOne({ phone: '3001234567' }, { $set: { email: 'admin@zipp.co' } });
    await makeUser({ name: 'Juan Restaurantes', phone: '3151234567', role: UserRole.BUSINESS });
    await makeUser({ name: 'Ana Cafeterías', phone: '3161234567', role: UserRole.BUSINESS });
    await makeUser({ name: 'Carlos Pérez', phone: '3101234567', role: UserRole.CLIENT });
  });

  it('siembra los cinco comercios con el dueño que dice el README', async () => {
    const report = await seedCatalog();
    expect(report.businesses).toBe(5);

    const [juan, ana] = await Promise.all([
      User.findOne({ phone: '3151234567' }),
      User.findOne({ phone: '3161234567' }),
    ]);

    const deJuan = await Business.find({ ownerId: juan!._id }).select('name');
    const deAna = await Business.find({ ownerId: ana!._id }).select('name');

    expect(deJuan.map((b) => b.name).sort()).toEqual(
      ['Burger House', 'Rincón Paisa', 'Super Fresh'].sort()
    );
    expect(deAna.map((b) => b.name).sort()).toEqual(
      ['Café Aroma', 'Droguería Salud+'].sort()
    );
  });

  it('deja los comercios activos, aprobados y con catálogo navegable', async () => {
    await seedCatalog();

    const negocios = await Business.find({});
    for (const negocio of negocios) {
      // Un comercio sin aprobar no sale en el listado de la app: sembrarlo
      // así equivaldría a no sembrarlo.
      expect(negocio.isActive).toBe(true);
      expect(negocio.isApproved).toBe(true);
      expect(negocio.location.coordinates).toHaveLength(2);

      const categorias = await Category.find({ businessId: negocio._id });
      expect(categorias.length).toBeGreaterThan(0);

      for (const categoria of categorias) {
        const productos = await Product.find({ businessId: negocio._id, categoryId: categoria._id });
        expect(productos.length).toBeGreaterThan(0);
        for (const producto of productos) {
          expect(producto.price).toBeGreaterThan(0);
          expect(producto.isAvailable).toBe(true);
        }
      }
    }
  });

  it('siembra los cinco cupones de la tabla, con sus condiciones', async () => {
    await seedCatalog();

    const codigos = (await Coupon.find({}).select('code')).map((c) => c.code).sort();
    expect(codigos).toEqual(['AHORRA5', 'BIENVENIDO', 'BURGER15', 'ENVIOGRATIS', 'EXPIRADO']);

    const bienvenido = await Coupon.findOne({ code: 'BIENVENIDO' });
    expect(bienvenido!.type).toBe(CouponType.PERCENTAGE);
    expect(bienvenido!.value).toBe(20);
    expect(bienvenido!.maxDiscountAmount).toBe(10000);
    expect(bienvenido!.minOrderAmount).toBe(15000);
    expect(bienvenido!.firstOrderOnly).toBe(true);

    const envio = await Coupon.findOne({ code: 'ENVIOGRATIS' });
    expect(envio!.type).toBe(CouponType.FREE_DELIVERY);
    expect(envio!.scope).toBe(CouponScope.DELIVERY);
    expect(envio!.minOrderAmount).toBe(25000);
    expect(envio!.perUserLimit).toBe(3);

    const ahorra = await Coupon.findOne({ code: 'AHORRA5' });
    expect(ahorra!.type).toBe(CouponType.FIXED);
    expect(ahorra!.value).toBe(5000);
    expect(ahorra!.minOrderAmount).toBe(30000);
    expect(ahorra!.usageLimit).toBe(100);

    // Atado a Burger House y pagado por el comercio: es su promoción.
    const burger = await Coupon.findOne({ code: 'BURGER15' });
    const burgerHouse = await Business.findOne({ name: 'Burger House' });
    expect(burger!.businessId!.toString()).toBe(burgerHouse!._id.toString());
    expect(burger!.fundedBy).toBe(CouponFundedBy.BUSINESS);
    expect(burger!.maxDiscountAmount).toBe(8000);
  });

  it('EXPIRADO está vencido de verdad, que es para lo que existe', async () => {
    await seedCatalog();
    const expirado = await Coupon.findOne({ code: 'EXPIRADO' });
    expect(expirado!.validUntil.getTime()).toBeLessThan(Date.now());
    // Y fuera del carrusel de promociones: no se ofrece algo que se va a
    // rechazar.
    expect(expirado!.isPublic).toBe(false);
  });

  it('el primer cliente arranca con sus dos direcciones guardadas', async () => {
    await seedCatalog();

    const carlos = await User.findOne({ phone: '3101234567' });
    const direcciones = await Address.find({ userId: carlos!._id });

    expect(direcciones).toHaveLength(2);
    expect(direcciones.map((d) => d.label).sort()).toEqual(['Casa', 'Trabajo']);
    // Exactamente una por defecto: dos —o ninguna— dejaría al checkout
    // eligiendo al azar.
    expect(direcciones.filter((d) => d.isDefault)).toHaveLength(1);
  });

  it('no siembra comercios huérfanos si falta un dueño', async () => {
    await User.deleteOne({ phone: '3161234567' });
    const report = await seedCatalog();

    // Los tres de Juan siguen; los dos de Ana se omiten con aviso en vez
    // de crearse sin dueño, que dejaría un panel al que nadie puede entrar.
    expect(report.businesses).toBe(3);
    expect(await Business.countDocuments({})).toBe(3);
    // Y el cupón atado a Burger House sobrevive, porque su comercio sí está.
    expect(await Coupon.countDocuments({ code: 'BURGER15' })).toBe(1);
  });
});
