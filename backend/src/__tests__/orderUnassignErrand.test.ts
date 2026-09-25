import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Types } from 'mongoose';
import { Order, Driver, Payout } from '../models';
import { OrderStatus, PaymentStatus, UserRole, PaymentMethod, PayoutBeneficiary } from '../types';
import { errandService } from '../services/errand.service';
import { orderService } from '../services/order.service';
import { pricingConfigService } from '../services/pricingConfig.service';
import { reassignStalledPickups, setDispatchEnabled, dispatchService } from '../services/dispatch.service';
import { makeUser, makeBusiness, makeProduct, makeDriver, makePricingConfig, makeReceipt, GARZON, offsetKm } from './factories';

const declareWithReceipt = async (orderId: string, driverUserId: string, cost: number) => {
  await makeReceipt(orderId, driverUserId);
  return errandService.declareCost(orderId, driverUserId, cost);
};

/** H1: un mandado no se suelta por reloj ni con gasto declarado, y soltar devuelve lo que se descontó. */
describe('unassignDriver: mandados, fondo y payout', () => {
  let client: any;
  let driverUser: any;
  let driver: any;
  const pickup = offsetKm(GARZON, 1);

  const createErrand = () =>
    errandService.create({
      clientId: client._id.toString(),
      description: 'Recoger el mercado de la lista y llevarlo a mi casa',
      pickupAddress: 'Supermercado La Esquina',
      pickupLatitude: pickup.lat,
      pickupLongitude: pickup.lng,
      deliveryAddress: 'Cra 1 #2-3',
      deliveryLatitude: GARZON.lat,
      deliveryLongitude: GARZON.lng,
      estimatedCost: 40000,
      maxCost: 50000,
    } as never);

  const paidReadyErrandAssigned = async () => {
    const order = await createErrand();
    await Order.updateOne({ _id: order._id }, { status: OrderStatus.READY, paymentStatus: PaymentStatus.PAID });
    await orderService.assignDriver(order._id.toString(), driver._id.toString());
    return order;
  };

  beforeEach(async () => {
    await makePricingConfig({ maxDriverCashDebt: 200000 });
    pricingConfigService.invalidate();
    client = await makeUser({ role: UserRole.CLIENT });
    driverUser = await makeUser({ role: UserRole.DRIVER });
    driver = await makeDriver(driverUser._id, { isApproved: true, isActive: true });
    await Driver.updateOne({ _id: driver._id }, { baseFund: 150000, currentFund: 150000 });
  });

  afterEach(() => setDispatchEnabled(false));

  it('el barrido no le quita un mandado envejecido al domiciliario que está comprando', async () => {
    setDispatchEnabled(true);
    const order = await paidReadyErrandAssigned();
    await Order.collection.updateOne(
      { _id: order._id },
      { $set: { assignedAt: new Date(Date.now() - dispatchService.PICKUP_GRACE_MS - 60_000) } }
    );

    expect(await reassignStalledPickups()).toBe(0);

    const saved = await Order.findById(order._id);
    expect(saved!.driverId!.toString()).toBe(driver._id.toString());
    expect((await Driver.findById(driver._id))!.currentFund).toBe(100000);
  });

  it('soltar un mandado sin gasto declarado devuelve el fondo exacto', async () => {
    const order = await paidReadyErrandAssigned();
    expect((await Driver.findById(driver._id))!.currentFund).toBe(100000);

    const released = await orderService.unassignDriver(order._id.toString(), 'prueba', {
      userId: driverUser._id.toString(),
      role: UserRole.ADMIN,
    });

    expect(released).not.toBeNull();
    expect((await Driver.findById(driver._id))!.currentFund).toBe(150000);
    expect((await Order.findById(order._id))!.driverId).toBeNull();
  });

  it('un mandado con gasto declarado no se suelta', async () => {
    const order = await paidReadyErrandAssigned();
    await declareWithReceipt(order._id.toString(), driverUser._id.toString(), 38500);
    const fundBefore = (await Driver.findById(driver._id))!.currentFund;

    await expect(orderService.unassignDriver(order._id.toString(), 'prueba')).rejects.toMatchObject({ statusCode: 409 });

    expect((await Order.findById(order._id))!.driverId!.toString()).toBe(driver._id.toString());
    expect((await Driver.findById(driver._id))!.currentFund).toBe(fundBefore);
  });

  it('dos desasignaciones simultáneas: una gana y el fondo se devuelve una sola vez', async () => {
    const order = await paidReadyErrandAssigned();

    const results = await Promise.all([
      orderService.unassignDriver(order._id.toString(), 'a'),
      orderService.unassignDriver(order._id.toString(), 'b'),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await Driver.findById(driver._id))!.currentFund).toBe(150000);
  });

  it('pedido normal reasignado de A a B: el payout del domiciliario queda a nombre de B', async () => {
    const owner = await makeUser({ role: UserRole.BUSINESS });
    const business = await makeBusiness(owner._id, { lat: GARZON.lat, lng: GARZON.lng });
    const product = await makeProduct(business._id, { price: 20000 });
    const order = await orderService.create({
      clientId: client._id.toString(),
      businessId: business._id.toString(),
      items: [{ productId: product._id.toString(), quantity: 1 }],
      paymentMethod: PaymentMethod.ONLINE,
      deliveryAddress: 'Cra 1 #2-3',
      deliveryLongitude: GARZON.lng,
      deliveryLatitude: GARZON.lat,
    });
    await Order.updateOne({ _id: order._id }, { status: OrderStatus.PREPARING, paymentStatus: PaymentStatus.PAID });

    const userB = await makeUser({ role: UserRole.DRIVER });
    const driverB = await makeDriver(userB._id, { isApproved: true, isActive: true });

    await orderService.assignDriver(order._id.toString(), driver._id.toString());
    expect((await Payout.findOne({ orderId: order._id, beneficiary: PayoutBeneficiary.DRIVER }))!.driverId!.toString()).toBe(
      driver._id.toString()
    );

    expect(await orderService.unassignDriver(order._id.toString(), 'reasignar')).not.toBeNull();
    await orderService.assignDriver(order._id.toString(), driverB._id.toString(), { userId: 'x', role: UserRole.ADMIN });

    const payouts = await Payout.find({ orderId: order._id, beneficiary: PayoutBeneficiary.DRIVER });
    expect(payouts).toHaveLength(1);
    expect(payouts[0].driverId!.toString()).toBe(driverB._id.toString());
  });

  it('un payout ya liquidado o con reversiones bloquea la desasignacion sin tocar nada (409)', async () => {
    const owner = await makeUser({ role: UserRole.BUSINESS });
    const business = await makeBusiness(owner._id, { lat: GARZON.lat, lng: GARZON.lng });
    const product = await makeProduct(business._id, { price: 20000 });
    const mk = async () => {
      const o = await orderService.create({
        clientId: client._id.toString(),
        businessId: business._id.toString(),
        items: [{ productId: product._id.toString(), quantity: 1 }],
        paymentMethod: PaymentMethod.ONLINE,
        deliveryAddress: 'Cra 1 #2-3',
        deliveryLongitude: GARZON.lng,
        deliveryLatitude: GARZON.lat,
      });
      await Order.updateOne({ _id: o._id }, { status: OrderStatus.PREPARING, paymentStatus: PaymentStatus.PAID });
      await orderService.assignDriver(o._id.toString(), driver._id.toString());
      return o;
    };

    for (const lock of [{ settlementId: new Types.ObjectId() }, { reversedAmount: 1 }]) {
      const order = await mk();
      await Payout.updateOne({ orderId: order._id, beneficiary: PayoutBeneficiary.DRIVER }, { $set: lock });
      const fundBefore = (await Driver.findById(driver._id))!.currentFund;

      await expect(orderService.unassignDriver(order._id.toString(), 'reasignar')).rejects.toMatchObject({ statusCode: 409 });

      expect((await Order.findById(order._id))!.driverId!.toString()).toBe(driver._id.toString());
      expect((await Driver.findById(driver._id))!.currentFund).toBe(fundBefore);
      expect(await Payout.countDocuments({ orderId: order._id, beneficiary: PayoutBeneficiary.DRIVER })).toBe(1);
    }
  });

  it('si el proceso cae entre el reclamo y el $inc, el barrido devuelve el fondo una sola vez', async () => {
    const order = await paidReadyErrandAssigned();
    const original = Driver.updateOne.bind(Driver);
    let failed = false;
    const spy = vi.spyOn(Driver, 'updateOne').mockImplementation(((...args: any[]) => {
      if (!failed && args[1]?.$inc) {
        failed = true;
        throw new Error('caida simulada');
      }
      return (original as any)(...args);
    }) as never);

    await expect(orderService.unassignDriver(order._id.toString(), 'prueba')).rejects.toThrow('caida simulada');
    spy.mockRestore();

    const mid = await Order.findById(order._id).select('+fundHoldReleasePending');
    expect(mid!.driverId).toBeNull();
    expect(mid!.fundHoldReleasePending!.amount).toBe(50000);
    expect((await Driver.findById(driver._id))!.currentFund).toBe(100000);

    expect(await orderService.retryPendingFundReleases()).toBe(1);
    expect((await Driver.findById(driver._id))!.currentFund).toBe(150000);
    expect((await Order.findById(order._id).select('+fundHoldReleasePending'))!.fundHoldReleasePending).toBeNull();

    // Cierre entre el $inc y la limpieza de la marca: reponer la marca no acredita de nuevo.
    const token = (await Driver.findById(driver._id).select('+fundReleaseTokens'))!.fundReleaseTokens![0];
    await Order.updateOne(
      { _id: order._id },
      { $set: { fundHoldReleasePending: { driverId: driver._id, amount: 50000, token } } }
    );
    await orderService.retryPendingFundReleases();
    expect((await Driver.findById(driver._id))!.currentFund).toBe(150000);
    expect((await Order.findById(order._id).select('+fundHoldReleasePending'))!.fundHoldReleasePending).toBeNull();
  });

  it('desasignar y cancelar a la vez dejan el fondo exacto', async () => {
    for (let i = 0; i < 5; i++) {
      await Driver.updateOne({ _id: driver._id }, { currentFund: 150000 });
      const order = await paidReadyErrandAssigned();

      await Promise.allSettled([
        orderService.unassignDriver(order._id.toString(), 'carrera'),
        orderService.updateStatus(
          order._id.toString(),
          OrderStatus.CANCELLED,
          driverUser._id.toString(),
          UserRole.ADMIN,
          'x',
          {},
          undefined,
          { canRefund: true }
        ),
      ]);
      await orderService.retryPendingFundReleases();

      expect((await Driver.findById(driver._id))!.currentFund, `iteracion ${i}`).toBe(150000);
      await Order.updateOne({ _id: order._id }, { status: OrderStatus.DELIVERED });
    }
  });
});
