import { describe, it, expect, afterEach } from 'vitest';
import { Types } from 'mongoose';
import { payoutService } from '../services/payout.service';
import { refundService } from '../services/refund.service';
import { orderService } from '../services/order.service';
import { ledgerService } from '../services/ledger.service';
import { cashReconciliationService } from '../services/cashReconciliation.service';
import { incidentCenterService } from '../services/incidentCenter.service';
import { paymentService, setPaymentProvider, SandboxPaymentProvider } from '../services/payments';
import { migratePayoutClawbackIndex } from '../migrations/016-payout-clawback-index';
import {
  Payout,
  Settlement,
  AdInvoice,
  LedgerEntry,
  Order,
  Payment,
  CashReconciliation,
  Driver,
} from '../models';
import {
  PayoutBeneficiary,
  PayoutStatus,
  PaymentMethod,
  PaymentStatus,
  OrderStatus,
  UserRole,
  RefundKind,
  SettlementPaymentMethod,
  LedgerAccount,
  LedgerDirection,
  LedgerEventType,
  CashReconciliationStatus,
} from '../types';
import {
  makeUser,
  makeBusiness,
  makeProduct,
  makeDriver,
  makeSettleableBusinessId,
  makePricingConfig,
  offsetKm,
  GARZON,
  runDelivery,
} from './factories';

/**
 * Revisión de finanzas de la Fase 0 (2026-09-23): un test por hallazgo.
 * Los números de los escenarios A/B/C/E son los de las pruebas del revisor.
 */

const RECEIPT = 'https://example.com/comprobante.jpg';
const DESTINATION = offsetKm(GARZON, 1);

async function mkPayout(
  businessId: Types.ObjectId,
  amount: number,
  status: PayoutStatus = PayoutStatus.PAYABLE
) {
  return Payout.create({
    orderId: new Types.ObjectId(),
    beneficiary: PayoutBeneficiary.BUSINESS,
    businessId,
    amount,
    status,
    currency: 'COP',
    pricingConfigVersion: 1,
    becamePayableAt: new Date(),
  });
}

async function mkAdInvoice(businessId: Types.ObjectId, amount: number) {
  return AdInvoice.create({
    businessId,
    campaignId: new Types.ObjectId(),
    campaignName: 'campaña',
    advertiserName: 'x',
    pricingModel: 'cpm',
    amount,
    periodStart: new Date(),
    periodEnd: new Date(),
    settledAgainstPayout: true,
  } as any);
}

const S: any = Settlement;
const originalCreate = S.create.bind(S);
afterEach(() => {
  S.create = originalCreate;
});

async function bal(account: LedgerAccount, orderId?: Types.ObjectId) {
  return (await ledgerService.accountBalance(account, orderId ? { orderId } : {})).balance;
}

async function seed(
  orderId: Types.ObjectId,
  lines: Array<[LedgerAccount, LedgerDirection, number]>,
  event: LedgerEventType,
  reference = ''
) {
  await ledgerService.post(
    { orderId, event, pricingConfigVersion: 1, reference },
    lines.map(([account, direction, amount]) => ({ account, direction, amount }))
  );
}

const D = LedgerDirection.DEBIT;
const C = LedgerDirection.CREDIT;

const ALLOW_ALL = () => true;

describe('1 · migración 016: índice único viejo de Payout', () => {
  it('con el índice viejo el arrastre revienta con E11000; tras la migración se crea', async () => {
    await Payout.collection.dropIndexes();
    await Payout.collection.createIndex({ orderId: 1, beneficiary: 1 }, { unique: true });
    // Documento anterior al campo `isClawback`, insertado por el driver.
    const legacyOrderId = new Types.ObjectId();
    const businessId = await makeSettleableBusinessId();
    await Payout.collection.insertOne({
      orderId: legacyOrderId,
      beneficiary: PayoutBeneficiary.BUSINESS,
      businessId,
      driverId: null,
      amount: 10_000,
      reversedAmount: 0,
      status: PayoutStatus.SETTLED,
      currency: 'COP',
      pricingConfigVersion: 1,
    });

    await expect(
      payoutService.reverse(legacyOrderId, { business: 4_000 })
    ).rejects.toMatchObject({ code: 11000 });

    // Ejecución en seco: informa y no escribe.
    const dry = await migratePayoutClawbackIndex({ dryRun: true });
    expect(dry.backfilledIsClawback).toBe(1);
    expect(dry.droppedOldIndex).toBeNull();
    expect(await Payout.collection.countDocuments({ isClawback: { $exists: false } })).toBe(1);

    const real = await migratePayoutClawbackIndex();
    expect(real.droppedOldIndex).toBe('orderId_1_beneficiary_1');
    expect(real.indexesAfter).toContain('one_payout_per_order_beneficiary (parcial)');
    expect(await Payout.collection.countDocuments({ isClawback: { $exists: false } })).toBe(0);

    // Idempotente: una segunda corrida no encuentra nada que hacer.
    const again = await migratePayoutClawbackIndex();
    expect(again.backfilledIsClawback).toBe(0);
    expect(again.droppedOldIndex).toBeNull();

    // Ahora el arrastre sí se crea (el 1.º reverse ya dejó reversedAmount en 4.000).
    await payoutService.reverse(legacyOrderId, { business: 4_000 });
    const claws = await Payout.find({ isClawback: true, businessId });
    expect(claws).toHaveLength(1);
    expect(claws[0].amount).toBe(4_000);
  });
});

describe('2 · carrera settle/reverse (escenario A)', () => {
  it('una reversión a mitad de settle no se pierde: abre 1 arrastre que la siguiente liquidación descuenta', async () => {
    const businessId = await makeSettleableBusinessId();
    const admin = await makeUser({ role: UserRole.ADMIN, isFinanceAdmin: true });
    const p = await mkPayout(businessId, 100_000);

    S.create = async (doc: any) => {
      await payoutService.reverse(p.orderId, { business: 30_000 });
      return originalCreate(doc);
    };
    const first = await payoutService.settle({
      beneficiary: PayoutBeneficiary.BUSINESS,
      businessId: businessId.toString(),
      createdBy: admin._id.toString(),
    });
    S.create = originalCreate;

    // La liquidación usa la foto del reclamo (reversedAtClaim = 0)…
    expect(first.netAmount).toBe(100_000);
    const after = await Payout.findById(p._id);
    expect(after!.reversedAmount).toBe(30_000);
    expect(after!.reversedAtClaim).toBe(0);
    // …y la reversión tardía queda como arrastre, no se pierde.
    const claws = await Payout.find({ isClawback: true, businessId });
    expect(claws).toHaveLength(1);
    expect(claws[0].amount).toBe(30_000);
    expect(claws[0].status).toBe(PayoutStatus.PAYABLE);

    // La siguiente liquidación lo descuenta: en total el comercio recibe 70.000 por ese pedido.
    await mkPayout(businessId, 50_000);
    const second = await payoutService.settle({
      beneficiary: PayoutBeneficiary.BUSINESS,
      businessId: businessId.toString(),
      createdBy: admin._id.toString(),
    });
    expect(second.settlement!.clawbackAmount).toBe(30_000);
    expect(second.netAmount).toBe(20_000);
    expect(first.netAmount + second.netAmount).toBe(150_000 - 30_000);
    expect(second.settlement!.clawbacks).toHaveLength(1);
    expect(String(second.settlement!.clawbacks[0].orderId)).toBe(String(p.orderId));
  });

  it('reverse sobre un payout ya reclamado (settlementId) lo trata como liquidado', async () => {
    const businessId = await makeSettleableBusinessId();
    const p = await mkPayout(businessId, 20_000);
    await Payout.updateOne({ _id: p._id }, { $set: { settlementId: new Types.ObjectId() } });
    await payoutService.reverse(p.orderId, { business: 5_000 });
    const claws = await Payout.find({ isClawback: true, businessId });
    expect(claws).toHaveLength(1);
    expect(claws[0].amount).toBe(5_000);
    // Y su estado no pasa a REVERSED aunque la reversión fuera total.
    await payoutService.reverse(p.orderId, { business: 15_000 });
    expect((await Payout.findById(p._id))!.status).not.toBe(PayoutStatus.REVERSED);
  });
});

describe('3 · reclamos huérfanos (escenario B)', () => {
  it('si falla antes de crear el Settlement se suelta el reclamo y el reintento liquida', async () => {
    const businessId = await makeSettleableBusinessId();
    const admin = await makeUser({ role: UserRole.ADMIN, isFinanceAdmin: true });
    await mkPayout(businessId, 50_000);
    const inv = await mkAdInvoice(businessId, 10_000);

    S.create = async () => {
      throw new Error('boom');
    };
    await expect(
      payoutService.settle({
        beneficiary: PayoutBeneficiary.BUSINESS,
        businessId: businessId.toString(),
        createdBy: admin._id.toString(),
      })
    ).rejects.toThrow('boom');
    S.create = originalCreate;

    const stuck = await Payout.findOne({ businessId });
    expect(stuck!.settlementId).toBeNull();
    expect(stuck!.status).toBe(PayoutStatus.PAYABLE);
    expect((await AdInvoice.findById(inv._id))!.settledAt).toBeNull();

    const retry = await payoutService.settle({
      beneficiary: PayoutBeneficiary.BUSINESS,
      businessId: businessId.toString(),
      createdBy: admin._id.toString(),
    });
    expect(retry.settlement).not.toBeNull();
    expect(retry.netAmount).toBe(40_000);
    expect(String(retry.settlement!.adInvoiceIds[0])).toBe(String(inv._id));
    expect((await AdInvoice.findById(inv._id))!.settledAt).not.toBeNull();
  });
});

describe('4 · asiento de la compensación (escenario C)', () => {
  it('MERCHANT_PAYABLE queda en 0 por pedido, PAYOUT_OFFSET_CLEARING en 0 y AD_SPEND_OFFSET = publicidad liquidada', async () => {
    const businessId = await makeSettleableBusinessId();
    const admin = await makeUser({ role: UserRole.ADMIN, isFinanceAdmin: true });

    // Pedido viejo: 40.000 colocado, pagado en una liquidación anterior y luego reembolsado 10.000.
    const old = await mkPayout(businessId, 40_000, PayoutStatus.SETTLED);
    await seed(old.orderId, [[LedgerAccount.RECEIVABLE, D, 40_000], [LedgerAccount.MERCHANT_PAYABLE, C, 40_000]], LedgerEventType.ORDER_PLACED);
    await seed(old.orderId, [[LedgerAccount.MERCHANT_PAYABLE, D, 40_000], [LedgerAccount.PAYOUT_DISBURSEMENT, C, 40_000]], LedgerEventType.SETTLEMENT_PAID, 'old-settlement');
    await seed(old.orderId, [[LedgerAccount.MERCHANT_PAYABLE, D, 10_000], [LedgerAccount.REFUND, C, 10_000]], LedgerEventType.REFUND_ISSUED, 'old-refund');
    await payoutService.reverse(old.orderId, { business: 10_000 });
    expect(await bal(LedgerAccount.MERCHANT_PAYABLE, old.orderId)).toBe(10_000); // negativo: nos debe

    // Pedido nuevo de 100.000 + publicidad de 20.000.
    const fresh = await mkPayout(businessId, 100_000);
    await seed(fresh.orderId, [[LedgerAccount.RECEIVABLE, D, 100_000], [LedgerAccount.MERCHANT_PAYABLE, C, 100_000]], LedgerEventType.ORDER_PLACED);
    await mkAdInvoice(businessId, 20_000);

    const { settlement } = await payoutService.settle({
      beneficiary: PayoutBeneficiary.BUSINESS,
      businessId: businessId.toString(),
      createdBy: admin._id.toString(),
    });
    expect(settlement!.netAmount).toBe(70_000);
    expect(settlement!.adSpendAmount).toBe(20_000);
    expect(settlement!.clawbackAmount).toBe(10_000);

    await payoutService.registerPayment({
      settlementId: String(settlement!._id),
      method: SettlementPaymentMethod.BANK_TRANSFER,
      reference: 'T-1',
      receiptUrl: RECEIPT,
      paidBy: admin._id.toString(),
    });

    expect(await bal(LedgerAccount.MERCHANT_PAYABLE, fresh.orderId)).toBe(0);
    expect(await bal(LedgerAccount.MERCHANT_PAYABLE, old.orderId)).toBe(0);
    expect(await bal(LedgerAccount.PAYOUT_OFFSET_CLEARING)).toBe(0);
    expect(-(await bal(LedgerAccount.AD_SPEND_OFFSET))).toBe(20_000);
    // Efectivo que salió por esta liquidación: 70.000.
    const disb = await LedgerEntry.find({
      reference: String(settlement!._id),
      account: LedgerAccount.PAYOUT_DISBURSEMENT,
    });
    expect(disb.reduce((s, e) => s + e.amount, 0)).toBe(70_000);
    expect(await ledgerService.isBalanced({ orderId: fresh.orderId })).toBe(true);
    expect(await ledgerService.isBalanced({ orderId: old.orderId })).toBe(true);
  });
});

describe('10 · registerPayment', () => {
  it('exige comprobante (decisión 7)', async () => {
    const businessId = await makeSettleableBusinessId();
    const admin = await makeUser({ role: UserRole.ADMIN, isFinanceAdmin: true });
    await mkPayout(businessId, 5_000);
    const { settlement } = await payoutService.settle({
      beneficiary: PayoutBeneficiary.BUSINESS,
      businessId: businessId.toString(),
      createdBy: admin._id.toString(),
    });
    await expect(
      payoutService.registerPayment({
        settlementId: String(settlement!._id),
        method: SettlementPaymentMethod.NEQUI,
        reference: 'R-1',
        receiptUrl: '',
        paidBy: admin._id.toString(),
      })
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it('si el pago quedó PAID pero el asiento no, el reintento lo relanza; un doble pago genuino sigue siendo 409', async () => {
    const businessId = await makeSettleableBusinessId();
    const admin = await makeUser({ role: UserRole.ADMIN, isFinanceAdmin: true });
    await mkPayout(businessId, 20_000);
    const { settlement } = await payoutService.settle({
      beneficiary: PayoutBeneficiary.BUSINESS,
      businessId: businessId.toString(),
      createdBy: admin._id.toString(),
    });
    const args = {
      settlementId: String(settlement!._id),
      method: SettlementPaymentMethod.NEQUI,
      reference: 'R-2',
      receiptUrl: RECEIPT,
      paidBy: admin._id.toString(),
    };
    await payoutService.registerPayment(args);
    await expect(payoutService.registerPayment(args)).rejects.toMatchObject({ statusCode: 409 });

    // Simula la caída entre marcar PAID y postear el asiento.
    await LedgerEntry.collection.deleteMany({ reference: String(settlement!._id) });
    const healed = await payoutService.registerPayment(args);
    expect(healed.paymentStatus).toBe('paid');
    const entries = await LedgerEntry.find({ reference: String(settlement!._id) });
    expect(entries.length).toBeGreaterThan(0);
    // Y sigue siendo idempotente.
    await expect(payoutService.registerPayment(args)).rejects.toMatchObject({ statusCode: 409 });
    expect(await LedgerEntry.countDocuments({ reference: String(settlement!._id) })).toBe(entries.length);
  });
});

describe('11 · publicidad no se descuenta dos veces', () => {
  it('dos liquidaciones concurrentes del mismo comercio reclaman cada factura una sola vez', async () => {
    const businessId = await makeSettleableBusinessId();
    const admin = await makeUser({ role: UserRole.ADMIN, isFinanceAdmin: true });
    await mkPayout(businessId, 100_000);
    await mkAdInvoice(businessId, 10_000);
    await mkPayout(businessId, 100_000);

    const run = () =>
      payoutService.settle({
        beneficiary: PayoutBeneficiary.BUSINESS,
        businessId: businessId.toString(),
        createdBy: admin._id.toString(),
      });
    const results = await Promise.all([run(), run()]);
    const ads = results
      .filter((r) => r.settlement)
      .reduce((s, r) => s + r.settlement!.adSpendAmount, 0);
    expect(ads).toBe(10_000);
  });
});

describe('9 · verifyByAdmin', () => {
  async function mkRecord(amount: number) {
    return CashReconciliation.create({
      driverId: new Types.ObjectId(),
      orderId: new Types.ObjectId(),
      amount,
      dueAt: new Date(Date.now() + 3_600_000),
      status: CashReconciliationStatus.PENDING,
    });
  }

  it('exige que el monto coincida con la suma de los registros', async () => {
    const admin = await makeUser({ role: UserRole.ADMIN, isFinanceAdmin: true });
    const a = await mkRecord(3_000);
    const b = await mkRecord(2_000);
    await expect(
      cashReconciliationService.verifyByAdmin([String(a._id), String(b._id)], String(admin._id), 'REF-9001', RECEIPT, 4_000)
    ).rejects.toMatchObject({ statusCode: 422 });
    const ok = await cashReconciliationService.verifyByAdmin(
      [String(a._id), String(b._id)], String(admin._id), 'REF-9001', RECEIPT, 5_000
    );
    expect(ok).toEqual({ verifiedCount: 2, totalVerified: 5_000 });
  });

  it('no verifica dos veces (no revierte SETTLED a VERIFIED) y no reutiliza la referencia', async () => {
    const admin = await makeUser({ role: UserRole.ADMIN, isFinanceAdmin: true });
    const a = await mkRecord(3_000);
    await cashReconciliationService.verifyByAdmin([String(a._id)], String(admin._id), 'REF-9002', RECEIPT, 3_000);
    await cashReconciliationService.settle([String(a._id)], String(admin._id)).catch(() => undefined);

    await expect(
      cashReconciliationService.verifyByAdmin([String(a._id)], String(admin._id), 'REF-9002', RECEIPT, 3_000)
    ).rejects.toMatchObject({ statusCode: 409 });
    expect((await CashReconciliation.findById(a._id))!.status).not.toBe(CashReconciliationStatus.PENDING);

    const b = await mkRecord(1_000);
    await expect(
      cashReconciliationService.verifyByAdmin([String(b._id)], String(admin._id), 'REF-9002', RECEIPT, 1_000)
    ).rejects.toMatchObject({ statusCode: 409 });
    expect((await CashReconciliation.findById(b._id))!.status).toBe(CashReconciliationStatus.PENDING);
  });

  it('dos verificaciones simultáneas: solo una gana', async () => {
    const admin = await makeUser({ role: UserRole.ADMIN, isFinanceAdmin: true });
    const a = await mkRecord(3_000);
    const res = await Promise.allSettled([
      cashReconciliationService.verifyByAdmin([String(a._id)], String(admin._id), 'REF-9003', RECEIPT, 3_000),
      cashReconciliationService.verifyByAdmin([String(a._id)], String(admin._id), 'REF-9004', RECEIPT, 3_000),
    ]);
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });
});

describe('arrastre perpetuo: listar, cobrar, castigar y alertar', () => {
  async function openClawback(businessId: Types.ObjectId, amount = 10_000, daysAgo = 0) {
    const old = await mkPayout(businessId, amount, PayoutStatus.SETTLED);
    await seed(old.orderId, [[LedgerAccount.RECEIVABLE, D, amount], [LedgerAccount.MERCHANT_PAYABLE, C, amount]], LedgerEventType.ORDER_PLACED);
    await seed(old.orderId, [[LedgerAccount.MERCHANT_PAYABLE, D, amount], [LedgerAccount.PAYOUT_DISBURSEMENT, C, amount]], LedgerEventType.SETTLEMENT_PAID, 'prev');
    await seed(old.orderId, [[LedgerAccount.MERCHANT_PAYABLE, D, amount], [LedgerAccount.REFUND, C, amount]], LedgerEventType.REFUND_ISSUED, 'rf');
    await payoutService.reverse(old.orderId, { business: amount });
    const claw = (await Payout.findOne({ orderId: old.orderId, isClawback: true }))!;
    if (daysAgo) {
      await Payout.updateOne({ _id: claw._id }, { $set: { becamePayableAt: new Date(Date.now() - daysAgo * 86_400_000) } });
    }
    return { old, claw };
  }

  it('lista abiertos con días abiertos; cobrar cierra el pasivo, es atómico y no se repite', async () => {
    const businessId = await makeSettleableBusinessId();
    const { old, claw } = await openClawback(businessId, 10_000, 3);

    const open = await payoutService.listClawbacks({ status: 'open' });
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ id: String(claw._id), netAmount: 10_000, daysOpen: 3 });

    const collected = await payoutService.collectClawback({ payoutId: String(claw._id), reference: 'CONS-77', receiptUrl: RECEIPT });
    expect(collected.status).toBe(PayoutStatus.SETTLED);
    expect(await bal(LedgerAccount.MERCHANT_PAYABLE, old.orderId)).toBe(0);
    expect(await ledgerService.isBalanced({ orderId: old.orderId })).toBe(true);
    await expect(
      payoutService.collectClawback({ payoutId: String(claw._id), reference: 'CONS-77', receiptUrl: RECEIPT })
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(await payoutService.listClawbacks({ status: 'open' })).toHaveLength(0);
  });

  it('castigar mueve el costo a BAD_DEBT_EXPENSE y cierra el pasivo', async () => {
    const businessId = await makeSettleableBusinessId();
    const { old, claw } = await openClawback(businessId, 8_000);
    await expect(
      payoutService.writeOffClawback({ payoutId: String(claw._id), reason: 'no' })
    ).rejects.toMatchObject({ statusCode: 422 });
    const done = await payoutService.writeOffClawback({ payoutId: String(claw._id), reason: 'Comercio cerrado sin contacto' });
    expect(done.status).toBe(PayoutStatus.WRITTEN_OFF);
    expect(await bal(LedgerAccount.BAD_DEBT_EXPENSE, old.orderId)).toBe(8_000);
    expect(await bal(LedgerAccount.MERCHANT_PAYABLE, old.orderId)).toBe(0);
    await expect(
      payoutService.collectClawback({ payoutId: String(claw._id), reference: 'CONS-78', receiptUrl: RECEIPT })
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('un arrastre de más de 14 días aparece en el centro de incidentes; uno reciente no', async () => {
    const businessId = await makeSettleableBusinessId();
    const { claw: viejo } = await openClawback(businessId, 5_000, 15);
    await openClawback(businessId, 5_000, 2);
    const incidents = await incidentCenterService.open(ALLOW_ALL);
    const overdue = incidents.filter((i) => i.kind === 'clawback_overdue');
    expect(overdue).toHaveLength(1);
    expect(overdue[0].id).toBe(String(viejo._id));
  });
});

describe('5 · 6 · 7 · 8 · pedido real entregado, liquidado y reembolsado', () => {
  async function paidDeliveredOrder() {
    setPaymentProvider(new SandboxPaymentProvider());
    await makePricingConfig({ driverBaseFee: 4300, driverMinFee: 4300, deliveryMarginFixed: 500, serviceFeeFixed: 1000 });
    const client = await makeUser();
    const owner = await makeUser({ role: UserRole.BUSINESS });
    const business = await makeBusiness(owner._id, { commissionRateBps: 1000 });
    const product = await makeProduct(business._id, { price: 30000 });
    const driverUser = await makeUser({ role: UserRole.DRIVER });
    const driver = await makeDriver(driverUser._id, { currentFund: 50000 });
    const admin = await makeUser({ role: UserRole.ADMIN, isFinanceAdmin: true });

    const create = () =>
      orderService.create({
        clientId: client._id.toString(),
        businessId: business._id.toString(),
        items: [{ productId: product._id.toString(), quantity: 1 }],
        paymentMethod: PaymentMethod.ONLINE,
        deliveryAddress: 'Cra 10 #5-23',
        deliveryLatitude: DESTINATION.lat,
        deliveryLongitude: DESTINATION.lng,
      });
    const pay = (order: any) =>
      paymentService.initiate({
        orderId: order._id.toString(),
        userId: client._id.toString(),
        amount: order.finance.customerTotal,
        description: 'Prueba',
        customer: { name: 'Cliente', phone: '3101234567' },
      });
    return { client, owner, business, driver, driverUser, admin, create, pay };
  }

  it('reembolso total tras liquidar: comercio → arrastre; domiciliario conserva su tarifa y ZIPP la absorbe; el libro cuadra', async () => {
    const ctx = await paidDeliveredOrder();
    const order = await ctx.create();
    await ctx.pay(order);
    for (const s of [OrderStatus.ACCEPTED, OrderStatus.PREPARING, OrderStatus.READY]) {
      await orderService.updateStatus(order._id.toString(), s, ctx.owner._id.toString(), UserRole.BUSINESS);
    }
    await orderService.assignDriver(order._id.toString(), ctx.driver._id.toString());
    await runDelivery(order._id.toString(), ctx.driverUser);
    await payoutService.release(order._id);

    const bizId = ctx.business._id.toString();
    const drvId = ctx.driver._id.toString();
    for (const [beneficiary, id] of [
      [PayoutBeneficiary.BUSINESS, bizId],
      [PayoutBeneficiary.DRIVER, drvId],
    ] as const) {
      const r = await payoutService.settle({
        beneficiary,
        businessId: beneficiary === PayoutBeneficiary.BUSINESS ? id : undefined,
        driverId: beneficiary === PayoutBeneficiary.DRIVER ? id : undefined,
        createdBy: ctx.admin._id.toString(),
      });
      await payoutService.registerPayment({
        settlementId: String(r.settlement!._id),
        method: SettlementPaymentMethod.BANK_TRANSFER,
        reference: `T-${beneficiary}`,
        receiptUrl: RECEIPT,
        paidBy: ctx.admin._id.toString(),
      });
    }
    expect(await bal(LedgerAccount.MERCHANT_PAYABLE, order._id)).toBe(0);
    expect(await bal(LedgerAccount.DRIVER_PAYABLE, order._id)).toBe(0);

    await refundService.issue({ orderId: order._id.toString(), reason: 'Producto en mal estado', kind: RefundKind.FULL });

    const finance = (await Order.findById(order._id))!.finance;
    const claws = await Payout.find({ orderId: order._id, isClawback: true });
    expect(claws).toHaveLength(1);
    expect(claws[0].beneficiary).toBe(PayoutBeneficiary.BUSINESS);
    expect(claws[0].amount).toBe(finance.businessPayout);

    // Domiciliario: sin arrastre, su tarifa la absorbe ZIPP y DRIVER_PAYABLE no queda negativo.
    expect(await bal(LedgerAccount.DRIVER_PAYABLE, order._id)).toBe(0);
    expect(await bal(LedgerAccount.DRIVER_FEE_ABSORBED_EXPENSE, order._id)).toBe(finance.driverPayout);
    expect(await ledgerService.isBalanced({ orderId: order._id })).toBe(true);
    // Comercio: el pasivo queda en negativo hasta que se cobre el arrastre.
    expect(await bal(LedgerAccount.MERCHANT_PAYABLE, order._id)).toBe(finance.businessPayout);

    // 5 · el arrastre resta en el resumen y el extracto no duplica la venta.
    const summary = await payoutService.summaryFor({ beneficiary: PayoutBeneficiary.BUSINESS, businessId: bizId });
    expect(summary.outstanding).toBe(-finance.businessPayout);
    const driverSummary = await payoutService.summaryFor({ beneficiary: PayoutBeneficiary.DRIVER, driverId: drvId });
    expect(driverSummary.outstanding).toBe(0);
    const { lines } = await payoutService.merchantStatementLines({ businessId: bizId });
    const clawLine = lines.find((l) => l.isClawback)!;
    expect(clawLine.netAmount).toBe(-finance.businessPayout);
    expect(clawLine.productSubtotal).toBe(0);
    expect(clawLine.merchantCommission).toBe(0);
  });

  it('7 · reembolso externo: referencia normalizada, idempotente por referencia y 409 si respalda otro pedido/monto', async () => {
    const ctx = await paidDeliveredOrder();
    const a = await ctx.create();
    await ctx.pay(a);
    const b = await ctx.create();
    await ctx.pay(b);

    const first = await refundService.issueExternal({
      orderId: a._id.toString(), amount: 10_000, reason: 'Devolución', externalReference: '  wmp-1 ', requestedBy: ctx.admin._id.toString(),
    });
    expect(first.transactionId).toBe('external:WMP-1');
    const retry = await refundService.issueExternal({
      orderId: a._id.toString(), amount: 10_000, reason: 'Devolución', externalReference: 'WMP-1', requestedBy: ctx.admin._id.toString(),
    });
    expect(String(retry._id)).toBe(String(first._id));
    expect(await refundService.refundedTotal(a._id)).toBe(10_000);

    await expect(
      refundService.issueExternal({ orderId: b._id.toString(), amount: 10_000, reason: 'x', externalReference: 'wmp-1', requestedBy: ctx.admin._id.toString() })
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      refundService.issueExternal({ orderId: a._id.toString(), amount: 9_000, reason: 'x', externalReference: 'wmp-1', requestedBy: ctx.admin._id.toString() })
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(await refundService.refundedTotal(b._id)).toBe(0);
  });

  it('7 · reembolso externo exige un pago en línea cobrado', async () => {
    const ctx = await paidDeliveredOrder();
    const unpaid = await ctx.create();
    await expect(
      refundService.issueExternal({ orderId: unpaid._id.toString(), amount: 5_000, reason: 'x', externalReference: 'NOPAY-1', requestedBy: ctx.admin._id.toString() })
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(await Payment.countDocuments({ orderId: unpaid._id, status: PaymentStatus.PAID })).toBe(0);
  });

  it('8 · un parcial y luego "el resto" cierra el pedido como reembolsado', async () => {
    const ctx = await paidDeliveredOrder();
    // El sandbox marca el pago como "refunded" tras el primer reembolso aunque
    // sea parcial; aquí hace falta una pasarela que admita varios.
    class MultiRefundProvider extends SandboxPaymentProvider {
      async refund(paymentId: string) {
        return this.getPayment(paymentId);
      }
    }
    setPaymentProvider(new MultiRefundProvider());
    const order = await ctx.create();
    await ctx.pay(order);

    await refundService.issue({ orderId: order._id.toString(), amount: 10_000, reason: 'Faltó un producto', kind: RefundKind.PARTIAL });
    expect((await Order.findById(order._id))!.paymentStatus).toBe(PaymentStatus.PAID);

    await refundService.issue({ orderId: order._id.toString(), reason: 'Resto', kind: RefundKind.FULL });
    expect((await Order.findById(order._id))!.paymentStatus).toBe(PaymentStatus.REFUNDED);
    expect(await refundService.refundedTotal(order._id)).toBe(order.finance.customerTotal);
    expect(await ledgerService.isBalanced({ orderId: order._id })).toBe(true);
  });
});

// Evita imports sin uso si un caso se ajusta.
void Driver;
