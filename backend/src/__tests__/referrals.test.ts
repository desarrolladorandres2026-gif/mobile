import { describe, it, expect, beforeEach } from 'vitest';
import { User, Order } from '../models';
import { OrderStatus, UserRole, PaymentMethod } from '../types';
import { referralService } from '../services/referral.service';
import { loyaltyService } from '../services/loyalty.service';
import { antiFraudService, FraudAlert, FraudAlertType } from '../security';
import { orderService } from '../services/order.service';
import { pricingConfigService } from '../services/pricingConfig.service';
import {
  makeUser, makeBusiness, makeProduct, makePricingConfig, GARZON,
} from './factories';

/**
 * Invitaciones.
 *
 * Antes la app compartía el código fijo `BIENVENIDO` para todo el mundo: la
 * función se llamaba "referidos" y no refería a nadie.
 *
 * Un programa de invitaciones sin defensas es dinero regalado —crear cuentas
 * es gratis y la recompensa no—, así que la mitad de estas pruebas cubre lo
 * que NO se paga.
 */
describe('Invitaciones', () => {
  let business: any;
  let product: any;

  const deliveredOrderFor = async (userId: string) => {
    const order = await orderService.create({
      clientId: userId,
      businessId: business._id.toString(),
      items: [{ productId: product._id.toString(), quantity: 1 }],
      paymentMethod: PaymentMethod.ONLINE,
      deliveryAddress: 'Cra 1 #2-3',
      deliveryLongitude: GARZON.lng,
      deliveryLatitude: GARZON.lat,
    });

    await Order.updateOne(
      { _id: order._id },
      { status: OrderStatus.DELIVERED, deliveredAt: new Date() }
    );

    return (await Order.findById(order._id))!;
  };

  /** Da al padrino un pedido entregado: sin eso no puede cobrar nada. */
  const makeVeteran = async () => {
    const user = await makeUser({ role: UserRole.CLIENT });
    await deliveredOrderFor(user._id.toString());
    return user;
  };

  beforeEach(async () => {
    await makePricingConfig({ loyaltyEarnBps: 200, loyaltyMinRedeem: 100 });
    pricingConfigService.invalidate();

    const owner = await makeUser({ role: UserRole.BUSINESS });
    business = await makeBusiness(owner._id, { lat: GARZON.lat, lng: GARZON.lng });
    product = await makeProduct(business._id, { price: 20000 });
  });

  it('genera un código propio, distinto para cada persona', async () => {
    const a = await makeUser({ role: UserRole.CLIENT });
    const b = await makeUser({ role: UserRole.CLIENT });

    const codeA = await referralService.codeFor(a._id.toString());
    const codeB = await referralService.codeFor(b._id.toString());

    expect(codeA).toMatch(/^Z[0-9A-F]{6}$/);
    expect(codeA).not.toBe(codeB);
  });

  it('el mismo usuario recibe siempre su mismo código', async () => {
    const user = await makeUser({ role: UserRole.CLIENT });

    expect(await referralService.codeFor(user._id.toString())).toBe(
      await referralService.codeFor(user._id.toString())
    );
  });

  it('atribuye el registro a quien invitó', async () => {
    const padrino = await makeUser({ role: UserRole.CLIENT });
    const code = await referralService.codeFor(padrino._id.toString());
    const invitado = await makeUser({ role: UserRole.CLIENT });

    await referralService.attribute(invitado._id.toString(), code);

    const saved = await User.findById(invitado._id);
    expect(saved!.referredBy!.toString()).toBe(padrino._id.toString());
  });

  it('nadie puede invitarse a sí mismo', async () => {
    const user = await makeUser({ role: UserRole.CLIENT });
    const code = await referralService.codeFor(user._id.toString());

    await expect(
      referralService.attribute(user._id.toString(), code)
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('el padrino se fija una vez y no cambia', async () => {
    const uno = await makeUser({ role: UserRole.CLIENT });
    const dos = await makeUser({ role: UserRole.CLIENT });
    const invitado = await makeUser({ role: UserRole.CLIENT });

    await referralService.attribute(
      invitado._id.toString(),
      await referralService.codeFor(uno._id.toString())
    );

    // Sin esto, alguien podría ir cambiando de padrino hasta encontrar
    // uno que le convenga.
    await expect(
      referralService.attribute(
        invitado._id.toString(),
        await referralService.codeFor(dos._id.toString())
      )
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('un código que no existe se rechaza', async () => {
    const user = await makeUser({ role: UserRole.CLIENT });
    await expect(
      referralService.attribute(user._id.toString(), 'ZFFFFFF')
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  // ── Cuándo se paga ──

  it('paga a los dos cuando el invitado completa su primera compra', async () => {
    const padrino = await makeVeteran();
    const invitado = await makeUser({ role: UserRole.CLIENT });
    await referralService.attribute(
      invitado._id.toString(),
      await referralService.codeFor(padrino._id.toString())
    );

    const order = await deliveredOrderFor(invitado._id.toString());
    expect(await referralService.rewardIfFirstOrder(order)).toBe(true);

    expect(await loyaltyService.balanceOf(padrino._id.toString())).toBeGreaterThan(0);
    expect(await loyaltyService.balanceOf(invitado._id.toString())).toBeGreaterThan(0);
  });

  it('no paga dos veces aunque llegue el evento repetido', async () => {
    const padrino = await makeVeteran();
    const invitado = await makeUser({ role: UserRole.CLIENT });
    await referralService.attribute(
      invitado._id.toString(),
      await referralService.codeFor(padrino._id.toString())
    );

    const order = await deliveredOrderFor(invitado._id.toString());
    await referralService.rewardIfFirstOrder(order);

    const before = await loyaltyService.balanceOf(padrino._id.toString());
    expect(await referralService.rewardIfFirstOrder(order)).toBe(false);
    expect(await loyaltyService.balanceOf(padrino._id.toString())).toBe(before);
  });

  it('no paga en la segunda compra del invitado', async () => {
    const padrino = await makeVeteran();
    const invitado = await makeUser({ role: UserRole.CLIENT });
    await referralService.attribute(
      invitado._id.toString(),
      await referralService.codeFor(padrino._id.toString())
    );

    await deliveredOrderFor(invitado._id.toString());
    const segunda = await deliveredOrderFor(invitado._id.toString());

    expect(await referralService.rewardIfFirstOrder(segunda)).toBe(false);
  });

  it('un pedido de alguien sin padrino no paga nada', async () => {
    const solo = await makeUser({ role: UserRole.CLIENT });
    const order = await deliveredOrderFor(solo._id.toString());

    expect(await referralService.rewardIfFirstOrder(order)).toBe(false);
  });

  // ── Lo que NO se paga ──

  it('no paga si quien invita nunca ha comprado', async () => {
    // Quien nunca pidió nada no está recomendando ZIPP: está fabricando
    // cuentas.
    const padrino = await makeUser({ role: UserRole.CLIENT });
    const invitado = await makeUser({ role: UserRole.CLIENT });
    await referralService.attribute(
      invitado._id.toString(),
      await referralService.codeFor(padrino._id.toString())
    );

    const order = await deliveredOrderFor(invitado._id.toString());
    expect(await referralService.rewardIfFirstOrder(order)).toBe(false);
    expect(await loyaltyService.balanceOf(padrino._id.toString())).toBe(0);
  });

  it('no paga si los dos usan el mismo dispositivo', async () => {
    const padrino = await makeVeteran();
    const invitado = await makeUser({ role: UserRole.CLIENT });
    await referralService.attribute(
      invitado._id.toString(),
      await referralService.codeFor(padrino._id.toString())
    );

    // El mismo teléfono creando las dos cuentas: el fraude más común y el
    // más barato de detectar.
    await antiFraudService.checkMultipleAccounts(
      padrino._id.toString(),
      'device-compartido',
      '10.0.0.1'
    );
    await antiFraudService.checkMultipleAccounts(
      invitado._id.toString(),
      'device-compartido',
      '10.0.0.1'
    );

    const order = await deliveredOrderFor(invitado._id.toString());
    expect(await referralService.rewardIfFirstOrder(order)).toBe(false);
  });

  it('una invitación bloqueada deja alerta, no silencio', async () => {
    const padrino = await makeUser({ role: UserRole.CLIENT });
    const invitado = await makeUser({ role: UserRole.CLIENT });
    await referralService.attribute(
      invitado._id.toString(),
      await referralService.codeFor(padrino._id.toString())
    );

    const order = await deliveredOrderFor(invitado._id.toString());
    await referralService.rewardIfFirstOrder(order);

    // Bloquear en silencio es indistinguible de que nadie usara el
    // programa: así no se puede saber si lo están atacando.
    const alert = await FraudAlert.findOne({
      userId: padrino._id.toString(),
      type: FraudAlertType.PROMOTION_ABUSE,
    });
    expect(alert).not.toBeNull();
    expect(alert!.description).toContain('nunca ha completado');
  });

  it('una invitación bloqueada no se reintenta en cada pedido', async () => {
    const padrino = await makeUser({ role: UserRole.CLIENT });
    const invitado = await makeUser({ role: UserRole.CLIENT });
    await referralService.attribute(
      invitado._id.toString(),
      await referralService.codeFor(padrino._id.toString())
    );

    const order = await deliveredOrderFor(invitado._id.toString());
    await referralService.rewardIfFirstOrder(order);

    const saved = await User.findById(invitado._id);
    expect(saved!.referralRewardedAt).not.toBeNull();
  });

  it('las estadísticas cuentan invitados y premiados por separado', async () => {
    const padrino = await makeVeteran();
    const code = await referralService.codeFor(padrino._id.toString());

    const uno = await makeUser({ role: UserRole.CLIENT });
    const dos = await makeUser({ role: UserRole.CLIENT });
    await referralService.attribute(uno._id.toString(), code);
    await referralService.attribute(dos._id.toString(), code);

    const order = await deliveredOrderFor(uno._id.toString());
    await referralService.rewardIfFirstOrder(order);

    const stats = await referralService.statsFor(padrino._id.toString());
    expect(stats.invited).toBe(2);
    expect(stats.rewarded).toBe(1);
  });
});
