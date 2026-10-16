// SONDA TEMPORAL DE CEREBRO — se borra tras ejecutarla. No forma parte de ZIPP.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { orderService } from '../services/order.service';
import { ledgerService } from '../services/ledger.service';
import { cashReconciliationService } from '../services/cashReconciliation.service';
import { setPaymentProvider, SandboxPaymentProvider } from '../services/payments';
import { Order, Driver, CashReconciliation, Commission } from '../models';
import { PaymentMethod, OrderStatus, UserRole, LedgerAccount } from '../types';
import { GARZON, offsetKm, makeUser, makeBusiness, makeProduct, makeDriver, makePricingConfig, runDelivery } from './factories';

const DEST = offsetKm(GARZON, 1);

describe('SONDA 2', () => {
  beforeEach(() => setPaymentProvider(new SandboxPaymentProvider()));
  afterEach(() => setPaymentProvider(null));

  it('H3: onDelivered falla a mitad (cash) → ¿driver ocupado y fondo sin acreditar? ¿reintento posible?', async () => {
    await makePricingConfig({ cashOnDeliveryEnabled: true, cashOnDeliveryMaxAmount: 1_000_000 });
    const client = await makeUser({ role: UserRole.CLIENT });
    const owner = await makeUser({ role: UserRole.BUSINESS });
    const business = await makeBusiness(owner._id, { commissionRateBps: 1500 });
    const product = await makeProduct(business._id, { price: 20000 });
    const driverUser = await makeUser({ role: UserRole.DRIVER });
    const driver = await makeDriver(driverUser._id, { currentFund: 100000 });
    const order = await orderService.create({
      clientId: client._id.toString(), businessId: business._id.toString(), items: [{ productId: product._id.toString(), quantity: 1 }],
      paymentMethod: PaymentMethod.CASH_ON_DELIVERY, deliveryAddress: 'Cra 10 #5-23', deliveryLatitude: DEST.lat, deliveryLongitude: DEST.lng,
    });
    for (const s of [OrderStatus.ACCEPTED, OrderStatus.PREPARING, OrderStatus.READY]) await orderService.updateStatus(order._id.toString(), s, owner._id.toString(), UserRole.BUSINESS);
    await orderService.assignDriver(order._id.toString(), driver._id.toString());
    const afterAssign = await Driver.findById(driver._id);

    const spy = vi.spyOn(cashReconciliationService, 'open').mockRejectedValueOnce(new Error('caída simulada en open()'));
    let err: string | null = null;
    try { await runDelivery(order._id.toString(), driverUser); } catch (e: any) { err = e.message; }
    spy.mockRestore();

    const o = await Order.findById(order._id);
    const d = await Driver.findById(driver._id);
    const rec = await CashReconciliation.countDocuments({ orderId: order._id });
    const led = await ledgerService.accountBalance(LedgerAccount.CASH_IN_TRANSIT, { orderId: order._id });
    let retry: string | null = null;
    try { await orderService.updateStatus(order._id.toString(), OrderStatus.DELIVERED, driverUser._id.toString(), UserRole.DRIVER); } catch (e: any) { retry = e.message; }
    console.log('H3 JSON', JSON.stringify({
      err, orderStatus: o!.status, driverStatusAfterAssign: afterAssign!.status, driverStatusAfter: d!.status,
      fundAssign: afterAssign!.currentFund, fundAfter: d!.currentFund, totalDeliveries: d!.totalDeliveries, reconciliations: rec, cashInTransit: led, retry,
    }));
    expect(true).toBe(true);
  });
});
