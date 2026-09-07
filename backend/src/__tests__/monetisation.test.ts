import crypto from 'crypto';
import { describe, it, expect, beforeEach } from 'vitest';
import { pricingService } from '../services/pricing.service';
import { orderService } from '../services/order.service';
import { ledgerService } from '../services/ledger.service';
import { payoutService } from '../services/payout.service';
import { refundService, allocateRefund } from '../services/refund.service';
import { cashReconciliationService } from '../services/cashReconciliation.service';
import {
  paymentService, setPaymentProvider, SandboxPaymentProvider, WompiPaymentProvider,
} from '../services/payments';
import { pricingConfigService } from '../services/pricingConfig.service';
import { config } from '../config';
import {
  Order,
  Payment,
  Payout,
  CashReconciliation,
  LedgerEntry,
  Coupon,
  Driver,
  ProcessedWebhook,
} from '../models';
import {
  PaymentMethod,
  PaymentStatus,
  OrderStatus,
  UserRole,
  CouponType,
  CouponFundedBy,
  CouponScope,
  LedgerAccount,
  PayoutBeneficiary,
  PayoutStatus,
  CashReconciliationStatus,
  RefundKind,
} from '../types';
import {
  makeUser,
  makeBusiness,
  makeProduct,
  makeDriver,
  makeCoupon,
  makePricingConfig,
  GARZON,
  offsetKm,
  runDelivery,
} from './factories';

/**
 * The delivery point sits 1 km north of the business, so with a 1 km free
 * radius the billable distance is zero and the driver's fee is exactly the
 * base fee. That keeps the arithmetic in these tests legible: every number
 * below is one a human can verify by hand.
 */
const DESTINATION = offsetKm(GARZON, 1);

async function baseScenario(
  configOverrides: Record<string, unknown> = {},
  businessOverrides: Record<string, unknown> = {}
) {
  await makePricingConfig(configOverrides);
  const client = await makeUser();
  const owner = await makeUser({ role: UserRole.BUSINESS });
  const business = await makeBusiness(owner._id, { commissionRateBps: 1000, ...businessOverrides });
  const product = await makeProduct(business._id, { price: 30000 });
  return { client, owner, business, product };
}

function quoteInput(
  clientId: string,
  businessId: string,
  productId: string,
  overrides: Record<string, unknown> = {}
) {
  return {
    userId: clientId,
    businessId,
    items: [{ productId, quantity: 1 }],
    deliveryLatitude: DESTINATION.lat,
    deliveryLongitude: DESTINATION.lng,
    paymentMethod: PaymentMethod.ONLINE,
    ...overrides,
  };
}

/** The invariant the whole design rests on. Asserted after every scenario. */
function expectBalanced(quote: {
  customerTotal: number;
  platformFundedDiscount: number;
  businessPayout: number;
  driverPayout: number;
  platformGrossRevenue: number;
  taxPayable: number;
}) {
  const inflow = quote.customerTotal + quote.platformFundedDiscount;
  const outflow =
    quote.businessPayout + quote.driverPayout + quote.platformGrossRevenue + quote.taxPayable;
  expect(outflow).toBe(inflow);
}

describe('1 · Reparto de referencia', () => {
  /**
   * The scenario from the specification:
   *   subtotal 30.000 · comisión 10% · domicilio cliente 4.800
   *   payout repartidor 4.300 · fee de servicio 1.000
   *
   * A 500 COP fixed delivery margin turns the driver's 4.300 guarantee into
   * a 4.800 customer price, which is the whole point of separating the two.
   */
  it('reparte 30.000 con comisión 10%, domicilio 4.800 y fee 1.000', async () => {
    const { client, business, product } = await baseScenario({
      driverBaseFee: 4300,
      driverMinFee: 4300,
      deliveryMarginFixed: 500,
      serviceFeeFixed: 1000,
      serviceFeeMax: 10000,
    });

    const quote = await pricingService.quote(
      quoteInput(client._id.toString(), business._id.toString(), product._id.toString())
    );

    expect(quote.productSubtotal).toBe(30000);
    expect(quote.merchantCommission).toBe(3000);
    expect(quote.deliveryCustomerFee).toBe(4800);
    expect(quote.driverDeliveryPayout).toBe(4300);
    expect(quote.deliveryMargin).toBe(500);
    expect(quote.customerServiceFee).toBe(1000);

    // El comercio recibe 27.000
    expect(quote.businessPayout).toBe(27000);
    // El repartidor recibe 4.300
    expect(quote.driverPayout).toBe(4300);
    // ZIPP recibe 3.000 + 1.000 + 500 = 4.500 antes de costos
    expect(quote.platformGrossRevenue).toBe(4500);
    expect(quote.platformNetRevenueBeforeOperatingCosts).toBe(4500);

    // El cliente paga 30.000 + 4.800 + 1.000 = 35.800
    expect(quote.customerTotal).toBe(35800);
    expectBalanced(quote);
  });

  it('la propina va completa al repartidor y no toca el ingreso de ZIPP', async () => {
    const { client, business, product } = await baseScenario({
      driverBaseFee: 4300,
      driverMinFee: 4300,
      deliveryMarginFixed: 500,
      serviceFeeFixed: 1000,
    });

    const quote = await pricingService.quote(
      quoteInput(client._id.toString(), business._id.toString(), product._id.toString(), {
        tip: 5000,
      })
    );

    expect(quote.tip).toBe(5000);
    expect(quote.driverPayout).toBe(4300 + 5000);
    expect(quote.platformGrossRevenue).toBe(4500);
    expect(quote.customerTotal).toBe(35800 + 5000);
    expectBalanced(quote);
  });

  it('el impuesto se aparta como pasivo y no como ingreso', async () => {
    const { client, business, product } = await baseScenario({
      driverBaseFee: 4300,
      driverMinFee: 4300,
      serviceFeeFixed: 1000,
      taxBps: 1900,
    });

    const quote = await pricingService.quote(
      quoteInput(client._id.toString(), business._id.toString(), product._id.toString())
    );

    // 19% sobre 30.000 + 4.300 + 1.000
    expect(quote.taxPayable).toBe(6707);
    expect(quote.platformGrossRevenue).toBe(3000 + 1000 + 0);
    expectBalanced(quote);
  });
});

describe('2 · El repartidor nunca queda en negativo', () => {
  /**
   * The old model computed the driver's pay as `deliveryFee − commission`,
   * so any order above roughly ten times the delivery fee left them working
   * for nothing and owing money. 50.000 at 10% is exactly that case.
   */
  it('un pedido de 50.000 no reduce el pago garantizado del repartidor', async () => {
    const { client, business } = await baseScenario({
      driverBaseFee: 4300,
      driverMinFee: 4300,
    });
    const product = await makeProduct(business._id, { price: 50000 });

    const quote = await pricingService.quote(
      quoteInput(client._id.toString(), business._id.toString(), product._id.toString())
    );

    expect(quote.merchantCommission).toBe(5000);
    expect(quote.driverDeliveryPayout).toBe(4300);
    expect(quote.driverPayout).toBe(4300);
    expect(quote.driverPayout).toBeGreaterThan(0);
    expect(quote.businessPayout).toBe(45000);
    expectBalanced(quote);
  });

  it('ningún tamaño de pedido produce un payout negativo', async () => {
    const { client, business } = await baseScenario({
      driverBaseFee: 4300,
      driverMinFee: 4300,
    });

    for (const price of [10000, 50000, 200000, 1_000_000]) {
      const product = await makeProduct(business._id, { price });
      const quote = await pricingService.quote(
        quoteInput(client._id.toString(), business._id.toString(), product._id.toString())
      );

      expect(quote.driverPayout).toBeGreaterThanOrEqual(4300);
      expect(quote.businessPayout).toBeGreaterThanOrEqual(0);
      expectBalanced(quote);
    }
  });

  it('el tope máximo de domicilio recorta el margen de ZIPP, no al repartidor', async () => {
    const { client, business, product } = await baseScenario({
      driverBaseFee: 8000,
      driverMinFee: 8000,
      deliveryMarginFixed: 2000,
      // El tope queda por debajo de tarifa + margen.
      deliveryMaxFee: 9000,
    });

    const quote = await pricingService.quote(
      quoteInput(client._id.toString(), business._id.toString(), product._id.toString())
    );

    expect(quote.driverDeliveryPayout).toBe(8000);
    expect(quote.deliveryCustomerFee).toBe(9000);
    expect(quote.deliveryMargin).toBe(1000);
    expectBalanced(quote);
  });

  it('un domicilio promocional por debajo del costo lo absorbe ZIPP', async () => {
    const { client, business, product } = await baseScenario({
      driverBaseFee: 8000,
      driverMinFee: 8000,
      deliveryMinFee: 2000,
      deliveryMaxFee: 3000,
    });

    const quote = await pricingService.quote(
      quoteInput(client._id.toString(), business._id.toString(), product._id.toString())
    );

    expect(quote.driverDeliveryPayout).toBe(8000);
    expect(quote.deliveryCustomerFee).toBe(3000);
    // ZIPP pierde 5.000 en el domicilio; el repartidor cobra completo.
    expect(quote.deliveryMargin).toBe(-5000);
    expect(quote.driverPayout).toBe(8000);
    expectBalanced(quote);
  });
});

describe('3 · Cupón de plataforma', () => {
  it('el descuento reduce el ingreso de ZIPP, no los payouts', async () => {
    const { client, business, product } = await baseScenario({
      driverBaseFee: 4300,
      driverMinFee: 4300,
      serviceFeeFixed: 1000,
    });

    // This promotion deliberately drives the order's margin negative, so it
    // needs an approved campaign — which is exactly the guard tested below.
    const coupon = await makeCoupon({
      type: CouponType.FIXED,
      value: 5000,
      fundedBy: CouponFundedBy.PLATFORM,
      scope: CouponScope.PRODUCT,
      campaignApproved: true,
    });

    const quote = await pricingService.quote(
      quoteInput(client._id.toString(), business._id.toString(), product._id.toString(), {
        couponCode: coupon.code,
      })
    );

    expect(quote.platformFundedDiscount).toBe(5000);
    expect(quote.merchantFundedDiscount).toBe(0);

    // El comercio cobra como si no hubiera descuento.
    expect(quote.businessPayout).toBe(27000);
    expect(quote.merchantCommission).toBe(3000);
    // El repartidor tampoco lo nota.
    expect(quote.driverPayout).toBe(4300);

    // ZIPP asume los 5.000 como gasto promocional.
    expect(quote.platformPromotionExpense).toBe(5000);
    expect(quote.platformGrossRevenue).toBe(4000);
    expect(quote.platformNetRevenueBeforeOperatingCosts).toBe(-1000);

    expect(quote.customerTotal).toBe(30000 - 5000 + 4300 + 1000);
    expectBalanced(quote);
  });

  it('rechaza el cupón si el margen cae bajo el mínimo sin campaña aprobada', async () => {
    const { client, business, product } = await baseScenario({
      driverBaseFee: 4300,
      driverMinFee: 4300,
      defaultMinimumContributionMargin: 1000,
    });

    const coupon = await makeCoupon({
      type: CouponType.FIXED,
      value: 5000,
      fundedBy: CouponFundedBy.PLATFORM,
      campaignApproved: false,
    });

    await expect(
      pricingService.quote(
        quoteInput(client._id.toString(), business._id.toString(), product._id.toString(), {
          couponCode: coupon.code,
        })
      )
    ).rejects.toThrow(/margen/i);
  });

  it('lo permite cuando la campaña está aprobada por finanzas', async () => {
    const { client, business, product } = await baseScenario({
      driverBaseFee: 4300,
      driverMinFee: 4300,
      defaultMinimumContributionMargin: 1000,
    });

    const coupon = await makeCoupon({
      type: CouponType.FIXED,
      value: 5000,
      fundedBy: CouponFundedBy.PLATFORM,
      campaignApproved: true,
    });

    const quote = await pricingService.quote(
      quoteInput(client._id.toString(), business._id.toString(), product._id.toString(), {
        couponCode: coupon.code,
      })
    );

    expect(quote.platformPromotionExpense).toBe(5000);
    expectBalanced(quote);
  });

  it('respeta el presupuesto de campaña', async () => {
    const { client, business, product } = await baseScenario({
      driverBaseFee: 4300,
      driverMinFee: 4300,
    });

    const coupon = await makeCoupon({
      type: CouponType.FIXED,
      value: 5000,
      fundedBy: CouponFundedBy.PLATFORM,
      budgetLimit: 8000,
      budgetSpent: 5000,
      campaignApproved: true,
    });

    await expect(
      pricingService.quote(
        quoteInput(client._id.toString(), business._id.toString(), product._id.toString(), {
          couponCode: coupon.code,
        })
      )
    ).rejects.toThrow(/presupuesto/i);
  });

  it('aplica el tope de subsidio configurado por el admin', async () => {
    const { client, business, product } = await baseScenario({
      driverBaseFee: 4300,
      driverMinFee: 4300,
      couponSubsidyLimit: 2000,
    });

    const coupon = await makeCoupon({
      type: CouponType.FIXED,
      value: 9000,
      fundedBy: CouponFundedBy.PLATFORM,
      campaignApproved: true,
    });

    const quote = await pricingService.quote(
      quoteInput(client._id.toString(), business._id.toString(), product._id.toString(), {
        couponCode: coupon.code,
      })
    );

    expect(quote.platformFundedDiscount).toBe(2000);
    expectBalanced(quote);
  });
});

describe('4 · Cupón de comercio', () => {
  it('el descuento reduce el payout del comercio', async () => {
    const { client, business, product } = await baseScenario({
      driverBaseFee: 4300,
      driverMinFee: 4300,
    });

    const coupon = await makeCoupon({
      type: CouponType.FIXED,
      value: 6000,
      fundedBy: CouponFundedBy.BUSINESS,
      scope: CouponScope.PRODUCT,
      businessId: business._id,
    });

    const quote = await pricingService.quote(
      quoteInput(client._id.toString(), business._id.toString(), product._id.toString(), {
        couponCode: coupon.code,
      })
    );

    expect(quote.merchantFundedDiscount).toBe(6000);
    expect(quote.platformFundedDiscount).toBe(0);
    expect(quote.platformPromotionExpense).toBe(0);

    // Comisión sobre 24.000, y el comercio se lleva el resto.
    expect(quote.merchantCommission).toBe(2400);
    expect(quote.businessPayout).toBe(30000 - 6000 - 2400);

    expect(quote.driverPayout).toBe(4300);
    expectBalanced(quote);
  });

  it('un comercio no puede financiar un descuento de domicilio', async () => {
    const owner = await makeUser({ role: UserRole.BUSINESS });
    const business = await makeBusiness(owner._id);

    await expect(
      makeCoupon({
        type: CouponType.FIXED,
        value: 3000,
        fundedBy: CouponFundedBy.BUSINESS,
        scope: CouponScope.DELIVERY,
        businessId: business._id,
      })
    ).rejects.toThrow(/domicilio|productos/i);
  });

  it('un cupón de comercio exige indicar el comercio', async () => {
    await expect(
      makeCoupon({
        type: CouponType.FIXED,
        value: 3000,
        fundedBy: CouponFundedBy.BUSINESS,
        businessId: null,
      })
    ).rejects.toThrow(/comercio/i);
  });
});

describe('5 · Envío gratis', () => {
  it('el repartidor conserva su tarifa y ZIPP registra la promoción', async () => {
    const { client, business, product } = await baseScenario({
      driverBaseFee: 4300,
      driverMinFee: 4300,
      deliveryMarginFixed: 500,
      serviceFeeFixed: 1000,
    });

    const coupon = await makeCoupon({
      type: CouponType.FREE_DELIVERY,
      value: 0,
      fundedBy: CouponFundedBy.PLATFORM,
      campaignApproved: true,
    });

    const quote = await pricingService.quote(
      quoteInput(client._id.toString(), business._id.toString(), product._id.toString(), {
        couponCode: coupon.code,
      })
    );

    // El cliente no paga domicilio…
    expect(quote.customerTotal).toBe(30000 + 0 + 1000);
    // …pero el repartidor cobra íntegro.
    expect(quote.driverDeliveryPayout).toBe(4300);
    expect(quote.driverPayout).toBe(4300);

    // La pérdida es de ZIPP: 4.800 de gasto promocional.
    expect(quote.platformFundedDiscount).toBe(4800);
    expect(quote.platformPromotionExpense).toBe(4800);
    expect(quote.platformGrossRevenue).toBe(3000 + 1000 + 500);
    expect(quote.platformNetRevenueBeforeOperatingCosts).toBe(-300);

    // El comercio no participa de la promoción.
    expect(quote.businessPayout).toBe(27000);
    expectBalanced(quote);
  });
});

describe('6 · Cancelaciones, reembolsos y contracargos', () => {
  async function placedOrder(configOverrides: Record<string, unknown> = {}) {
    const { client, business, product } = await baseScenario({
      driverBaseFee: 4300,
      driverMinFee: 4300,
      deliveryMarginFixed: 500,
      serviceFeeFixed: 1000,
      ...configOverrides,
    });

    const order = await orderService.create({
      clientId: client._id.toString(),
      businessId: business._id.toString(),
      items: [{ productId: product._id.toString(), quantity: 1 }],
      paymentMethod: PaymentMethod.ONLINE,
      deliveryAddress: 'Cra 10 #5-23',
      deliveryLatitude: DESTINATION.lat,
      deliveryLongitude: DESTINATION.lng,
    });

    return { client, business, product, order };
  }

  it('el pedido guarda su snapshot financiero y queda cuadrado en el libro', async () => {
    const { order } = await placedOrder();

    expect(order.finance.customerTotal).toBe(35800);
    expect(order.finance.businessPayout).toBe(27000);
    expect(order.finance.platformGrossRevenue).toBe(4500);
    expect(order.pricingConfigVersion).toBeGreaterThan(0);

    expect(await ledgerService.isBalanced({ orderId: order._id })).toBe(true);
  });

  it('cancelar antes de cobrar revierte todo contra el cobro pendiente', async () => {
    const { client, order } = await placedOrder();

    await orderService.updateStatus(
      order._id.toString(),
      OrderStatus.CANCELLED,
      client._id.toString(),
      UserRole.CLIENT,
      'El cliente cambió de opinión'
    );

    expect(await ledgerService.isBalanced({ orderId: order._id })).toBe(true);

    const receivable = await ledgerService.accountBalance(LedgerAccount.RECEIVABLE, {
      orderId: order._id,
    });
    expect(receivable.balance).toBe(0);

    const commission = await ledgerService.accountBalance(
      LedgerAccount.COMMISSION_REVENUE,
      { orderId: order._id }
    );
    expect(commission.balance).toBe(0);

    const payouts = await Payout.find({ orderId: order._id });
    for (const payout of payouts) {
      expect(payout.status).toBe(PayoutStatus.REVERSED);
      expect(payout.netAmount).toBe(0);
    }
  });

  it('un reembolso total revierte cada partida', async () => {
    setPaymentProvider(new SandboxPaymentProvider());
    const { client, order } = await placedOrder();

    await paymentService.initiate({
      orderId: order._id.toString(),
      userId: client._id.toString(),
      amount: order.finance.customerTotal,
      description: 'Prueba',
      customer: { name: 'Cliente', phone: '3101234567' },
    });

    const paid = await Order.findById(order._id);
    expect(paid!.paymentStatus).toBe(PaymentStatus.PAID);

    await refundService.issue({
      orderId: order._id.toString(),
      reason: 'Producto en mal estado',
      kind: RefundKind.FULL,
    });

    expect(await ledgerService.isBalanced({ orderId: order._id })).toBe(true);

    for (const account of [
      LedgerAccount.COMMISSION_REVENUE,
      LedgerAccount.SERVICE_FEE_REVENUE,
      LedgerAccount.DELIVERY_MARGIN_REVENUE,
      LedgerAccount.MERCHANT_PAYABLE,
    ]) {
      const balance = await ledgerService.accountBalance(account, { orderId: order._id });
      expect(balance.balance).toBe(0);
    }

    const refunded = await Order.findById(order._id);
    expect(refunded!.paymentStatus).toBe(PaymentStatus.REFUNDED);
  });

  it('un reembolso parcial no toca el pago del repartidor', async () => {
    setPaymentProvider(new SandboxPaymentProvider());
    const { client, order } = await placedOrder();

    await paymentService.initiate({
      orderId: order._id.toString(),
      userId: client._id.toString(),
      amount: order.finance.customerTotal,
      description: 'Prueba',
      customer: { name: 'Cliente', phone: '3101234567' },
    });

    await refundService.issue({
      orderId: order._id.toString(),
      amount: 10000,
      reason: 'Faltó un producto',
      kind: RefundKind.PARTIAL,
    });

    expect(await ledgerService.isBalanced({ orderId: order._id })).toBe(true);

    const driverPayable = await ledgerService.accountBalance(
      LedgerAccount.DRIVER_PAYABLE,
      { orderId: order._id }
    );
    // Sigue debiéndose íntegro al repartidor (saldo acreedor de 4.300).
    expect(driverPayable.balance).toBe(-4300);
  });

  it('la asignación parcial nunca carga nada al repartidor', () => {
    const finance = {
      productSubtotal: 30000,
      merchantCommission: 3000,
      customerServiceFee: 1000,
      deliveryCustomerFee: 4800,
      driverDeliveryPayout: 4300,
      deliveryMargin: 500,
      tip: 2000,
      merchantFundedDiscount: 0,
      platformFundedDiscount: 0,
      taxPayable: 0,
      businessPayout: 27000,
      driverPayout: 6300,
      platformGrossRevenue: 4500,
      platformPromotionExpense: 0,
      platformNetRevenueBeforeOperatingCosts: 4500,
      customerTotal: 35800,
      currency: 'COP',
      pricingConfigVersion: 1,
      appliedCommissionBps: 1000,
    };

    const allocation = allocateRefund(finance, 9000, RefundKind.PARTIAL);

    expect(allocation.fromDriverPayout).toBe(0);
    const total =
      allocation.fromMerchantPayout +
      allocation.fromCommission +
      allocation.fromServiceFee +
      allocation.fromDeliveryMargin +
      allocation.fromTax;
    // Las partes suman exactamente el reembolso: sin pesos perdidos.
    expect(total).toBe(9000);
  });

  it('un contracargo se registra en su propia cuenta y cuadra', async () => {
    setPaymentProvider(new SandboxPaymentProvider());
    const { client, order } = await placedOrder();

    await paymentService.initiate({
      orderId: order._id.toString(),
      userId: client._id.toString(),
      amount: order.finance.customerTotal,
      description: 'Prueba',
      customer: { name: 'Cliente', phone: '3101234567' },
    });

    await refundService.recordChargeback({
      orderId: order._id.toString(),
      reference: 'CB-001',
    });

    expect(await ledgerService.isBalanced({ orderId: order._id })).toBe(true);

    const chargeback = await ledgerService.accountBalance(LedgerAccount.CHARGEBACK, {
      orderId: order._id,
    });
    expect(chargeback.balance).toBe(-35800);
  });

  it('un reembolso repetido con la misma clave no duplica nada', async () => {
    setPaymentProvider(new SandboxPaymentProvider());
    const { client, order } = await placedOrder();

    await paymentService.initiate({
      orderId: order._id.toString(),
      userId: client._id.toString(),
      amount: order.finance.customerTotal,
      description: 'Prueba',
      customer: { name: 'Cliente', phone: '3101234567' },
    });

    const first = await refundService.issue({
      orderId: order._id.toString(),
      reason: 'Duplicado',
      idempotencyKey: 'refund-abc',
    });
    const second = await refundService.issue({
      orderId: order._id.toString(),
      reason: 'Duplicado',
      idempotencyKey: 'refund-abc',
    });

    expect(String(second._id)).toBe(String(first._id));
    expect(await refundService.refundedTotal(order._id)).toBe(35800);
    expect(await ledgerService.isBalanced({ orderId: order._id })).toBe(true);
  });

  it('devuelve el uso y el presupuesto del cupón al cancelar', async () => {
    await makePricingConfig({ driverBaseFee: 4300, driverMinFee: 4300 });
    const client = await makeUser();
    const owner = await makeUser({ role: UserRole.BUSINESS });
    const business = await makeBusiness(owner._id, { commissionRateBps: 1000 });
    const product = await makeProduct(business._id, { price: 30000 });

    const coupon = await makeCoupon({
      type: CouponType.FIXED,
      value: 5000,
      fundedBy: CouponFundedBy.PLATFORM,
      budgetLimit: 100000,
      campaignApproved: true,
    });

    const order = await orderService.create({
      clientId: client._id.toString(),
      businessId: business._id.toString(),
      items: [{ productId: product._id.toString(), quantity: 1 }],
      paymentMethod: PaymentMethod.ONLINE,
      deliveryAddress: 'Cra 10 #5-23',
      deliveryLatitude: DESTINATION.lat,
      deliveryLongitude: DESTINATION.lng,
      couponCode: coupon.code,
    });

    const consumed = await Coupon.findById(coupon._id);
    expect(consumed!.usedCount).toBe(1);
    expect(consumed!.budgetSpent).toBe(5000);

    await orderService.updateStatus(
      order._id.toString(),
      OrderStatus.CANCELLED,
      client._id.toString(),
      UserRole.CLIENT,
      'Cancelado'
    );

    const released = await Coupon.findById(coupon._id);
    expect(released!.usedCount).toBe(0);
    expect(released!.budgetSpent).toBe(0);
  });
});

describe('7 · Webhooks', () => {
  beforeEach(() => {
    setPaymentProvider(new SandboxPaymentProvider());
  });

  it('un webhook duplicado no duplica pagos ni liquidaciones', async () => {
    const { client, business, product } = await baseScenario({
      driverBaseFee: 4300,
      driverMinFee: 4300,
    });

    const order = await orderService.create({
      clientId: client._id.toString(),
      businessId: business._id.toString(),
      items: [{ productId: product._id.toString(), quantity: 1 }],
      paymentMethod: PaymentMethod.ONLINE,
      deliveryAddress: 'Cra 10 #5-23',
      deliveryLatitude: DESTINATION.lat,
      deliveryLongitude: DESTINATION.lng,
    });

    const provider = new SandboxPaymentProvider();
    setPaymentProvider(provider);

    const { intent } = await paymentService.initiate({
      orderId: order._id.toString(),
      userId: client._id.toString(),
      amount: order.finance.customerTotal,
      description: 'Prueba',
      customer: { name: 'Cliente', phone: '3101234567' },
    });

    const payload = JSON.stringify({
      eventId: 'evt-1',
      paymentId: intent.id,
      status: 'approved',
      amount: order.finance.customerTotal,
    });
    const signature = provider.sign(payload);

    const first = await paymentService.handleWebhook(payload, signature);
    const second = await paymentService.handleWebhook(payload, signature);
    const third = await paymentService.handleWebhook(payload, signature);

    expect(first.accepted).toBe(true);
    expect(second).toEqual({ accepted: true, duplicated: true, reason: 'evento ya procesado' });
    expect(third.duplicated).toBe(true);

    expect(await ProcessedWebhook.countDocuments({ eventKey: 'evt-1' })).toBe(1);

    // Un solo asiento de captura, por más veces que llegue el evento.
    const captures = await LedgerEntry.countDocuments({
      orderId: order._id,
      account: LedgerAccount.CUSTOMER_PAYMENT,
    });
    expect(captures).toBe(1);

    expect(await ledgerService.isBalanced({ orderId: order._id })).toBe(true);
  });

  it('un checkout de Wompi sin completar se puede reintentar sin duplicar el cargo', async () => {
    const originalWompiConfig = { ...config.payments.wompi };
    Object.assign(config.payments.wompi, {
      publicKey: 'pub_test_x',
      privateKey: 'prv_test_x',
      integritySecret: 'integrity_secret',
      eventsSecret: 'events_secret',
    });
    setPaymentProvider(new WompiPaymentProvider());

    try {
      const { client, business, product } = await baseScenario({
        driverBaseFee: 4300,
        driverMinFee: 4300,
      });

      const order = await orderService.create({
        clientId: client._id.toString(),
        businessId: business._id.toString(),
        items: [{ productId: product._id.toString(), quantity: 1 }],
        paymentMethod: PaymentMethod.ONLINE,
        deliveryAddress: 'Cra 10 #5-23',
        deliveryLatitude: DESTINATION.lat,
        deliveryLongitude: DESTINATION.lng,
      });

      const payArgs = {
        orderId: order._id.toString(),
        userId: client._id.toString(),
        amount: order.finance.customerTotal,
        description: 'Prueba',
        customer: { name: 'Cliente', phone: '3101234567' },
      };

      const first = await paymentService.initiate(payArgs);
      expect(first.intent.checkoutUrl).toContain('checkout.wompi.co');
      expect(first.intent.status).toBe('pending');

      // El cliente nunca completa el Web Checkout y vuelve a intentar. Wompi
      // no tiene ningún registro todavía para esa referencia, así que no
      // debe crearse un segundo Payment ni una referencia distinta.
      const second = await paymentService.initiate(payArgs);
      expect(second.intent.id).toBe(first.intent.id);
      expect(await Payment.countDocuments({ orderId: order._id })).toBe(1);

      // Ahora sí llega la confirmación de Wompi, con su propio id de transacción.
      const tx = {
        id: 'wompi-real-id-123',
        reference: first.intent.id,
        status: 'APPROVED',
        amount_in_cents: order.finance.customerTotal * 100,
        status_message: null,
        payment_method_type: 'NEQUI',
      };
      const properties = ['transaction.id', 'transaction.status', 'transaction.amount_in_cents'];
      const timestamp = Date.now();
      const checksum = crypto
        .createHash('sha256')
        .update(`${tx.id}${tx.status}${tx.amount_in_cents}${timestamp}events_secret`)
        .digest('hex');

      const payload = JSON.stringify({
        event: 'transaction.updated',
        data: { transaction: tx },
        environment: 'test',
        signature: { properties, checksum },
        timestamp,
      });

      const result = await paymentService.handleWebhook(payload, '');
      expect(result.accepted).toBe(true);

      const paidOrder = await Order.findById(order._id);
      expect(paidOrder!.paymentStatus).toBe(PaymentStatus.PAID);

      const payment = await Payment.findOne({ orderId: order._id });
      expect(payment!.reference).toBe(first.intent.id);
      expect(payment!.transactionId).toBe('wompi-real-id-123');
      expect(payment!.method).toBe('NEQUI');
      expect(payment!.gatewayStatus).toBe('APPROVED');
    } finally {
      Object.assign(config.payments.wompi, originalWompiConfig);
    }
  });

  it('rechaza un webhook con firma inválida', async () => {
    const result = await paymentService.handleWebhook(
      JSON.stringify({ paymentId: 'sbx_x', status: 'approved' }),
      'firma-falsa'
    );
    expect(result).toEqual({
      accepted: false,
      duplicated: false,
      reason: 'firma inválida',
    });
  });

  it('el pedido no queda PAID al entregarse sin confirmación de la pasarela', async () => {
    const { client, business, product } = await baseScenario({
      driverBaseFee: 4300,
      driverMinFee: 4300,
    });
    const driverUser = await makeUser({ role: UserRole.DRIVER });
    const driver = await makeDriver(driverUser._id);

    const order = await orderService.create({
      clientId: client._id.toString(),
      businessId: business._id.toString(),
      items: [{ productId: product._id.toString(), quantity: 1 }],
      paymentMethod: PaymentMethod.ONLINE,
      deliveryAddress: 'Cra 10 #5-23',
      deliveryLatitude: DESTINATION.lat,
      deliveryLongitude: DESTINATION.lng,
    });

    // El local ya no puede aceptar un pedido en línea impago, así que la
    // única forma de llegar hasta aquí es saltar la máquina de estados a
    // mano. Es deliberado: lo que se prueba es que `onDelivered` no cobra
    // por su cuenta, no el camino por el que el pedido quedó listo.
    await Order.updateOne({ _id: order._id }, { $set: { status: OrderStatus.READY } });
    await orderService.assignDriver(order._id.toString(), driver._id.toString());

    // Recoger y entregar exigen evidencia y código: `runDelivery` hace ese
    // camino completo, que es el único por el que un pedido puede llegar a
    // "entregado".
    await runDelivery(order._id.toString(), driverUser);

    const delivered = await Order.findById(order._id);
    expect(delivered!.status).toBe(OrderStatus.DELIVERED);
    // Entregar no es cobrar.
    expect(delivered!.paymentStatus).toBe(PaymentStatus.PENDING);

    // Y por lo tanto nada es todavía pagadero.
    const payouts = await Payout.find({ orderId: order._id });
    expect(payouts.every((p) => p.status === PayoutStatus.ACCRUED)).toBe(true);
  });
});

describe('8 · Efectivo contra entrega', () => {
  it('no se puede pagar en efectivo si la bandera está desactivada', async () => {
    const { client, business, product } = await baseScenario({
      cashOnDeliveryEnabled: false,
    });

    await expect(
      pricingService.quote(
        quoteInput(client._id.toString(), business._id.toString(), product._id.toString(), {
          paymentMethod: PaymentMethod.CASH_ON_DELIVERY,
        })
      )
    ).rejects.toThrow(/contra entrega no está disponible/i);
  });

  it('respeta el monto máximo permitido en efectivo', async () => {
    const { client, business } = await baseScenario({
      cashOnDeliveryEnabled: true,
      cashOnDeliveryMaxAmount: 20000,
      driverBaseFee: 4300,
      driverMinFee: 4300,
    });
    const product = await makeProduct(business._id, { price: 30000 });

    await expect(
      pricingService.quote(
        quoteInput(client._id.toString(), business._id.toString(), product._id.toString(), {
          paymentMethod: PaymentMethod.CASH_ON_DELIVERY,
        })
      )
    ).rejects.toThrow(/contra entrega admite hasta/i);
  });

  it('el repartidor solo adelanta el payout del comercio, no el subtotal', async () => {
    const { client, business, product } = await baseScenario({
      cashOnDeliveryEnabled: true,
      driverBaseFee: 4300,
      driverMinFee: 4300,
      serviceFeeFixed: 1000,
    });

    const driverUser = await makeUser({ role: UserRole.DRIVER });
    const driver = await makeDriver(driverUser._id, { currentFund: 50000 });

    const order = await orderService.create({
      clientId: client._id.toString(),
      businessId: business._id.toString(),
      items: [{ productId: product._id.toString(), quantity: 1 }],
      paymentMethod: PaymentMethod.CASH_ON_DELIVERY,
      deliveryAddress: 'Cra 10 #5-23',
      deliveryLatitude: DESTINATION.lat,
      deliveryLongitude: DESTINATION.lng,
    });

    const ownerId = business.ownerId.toString();
    for (const status of [OrderStatus.ACCEPTED, OrderStatus.PREPARING, OrderStatus.READY]) {
      await orderService.updateStatus(order._id.toString(), status, ownerId, UserRole.BUSINESS);
    }
    await orderService.assignDriver(order._id.toString(), driver._id.toString());

    // Adelanta 27.000 (el payout del comercio), no los 30.000 del subtotal.
    const reserved = await Driver.findById(driver._id);
    expect(reserved!.currentFund).toBe(50000 - 27000);
  });

  it('al entregar, el efectivo por rendir excluye la tarifa del repartidor', async () => {
    const { client, business, product } = await baseScenario({
      cashOnDeliveryEnabled: true,
      driverBaseFee: 4300,
      driverMinFee: 4300,
      deliveryMarginFixed: 500,
      serviceFeeFixed: 1000,
    });

    const driverUser = await makeUser({ role: UserRole.DRIVER });
    const driver = await makeDriver(driverUser._id, { currentFund: 50000 });

    const order = await orderService.create({
      clientId: client._id.toString(),
      businessId: business._id.toString(),
      items: [{ productId: product._id.toString(), quantity: 1 }],
      paymentMethod: PaymentMethod.CASH_ON_DELIVERY,
      deliveryAddress: 'Cra 10 #5-23',
      deliveryLatitude: DESTINATION.lat,
      deliveryLongitude: DESTINATION.lng,
    });

    const ownerId = business.ownerId.toString();
    for (const status of [OrderStatus.ACCEPTED, OrderStatus.PREPARING, OrderStatus.READY]) {
      await orderService.updateStatus(order._id.toString(), status, ownerId, UserRole.BUSINESS);
    }
    await orderService.assignDriver(order._id.toString(), driver._id.toString());

    // Recoger y entregar exigen evidencia y código: `runDelivery` hace ese
    // camino completo, que es el único por el que un pedido puede llegar a
    // "entregado".
    await runDelivery(order._id.toString(), driverUser);

    const reconciliation = await CashReconciliation.findOne({ orderId: order._id });
    expect(reconciliation).toBeTruthy();
    // Comisión 3.000 + fee 1.000 + margen 500 = 4.500
    expect(reconciliation!.amount).toBe(4500);
    expect(reconciliation!.status).toBe(CashReconciliationStatus.PENDING);

    // El fondo vuelve completo: adelantó 27.000 y los recuperó del cliente.
    const settled = await Driver.findById(driver._id);
    expect(settled!.currentFund).toBe(50000);

    expect(await ledgerService.isBalanced({ orderId: order._id })).toBe(true);
  });

  it('el repartidor puede reportar pero no liquidar su propio saldo', async () => {
    const { client, business, product } = await baseScenario({
      cashOnDeliveryEnabled: true,
      driverBaseFee: 4300,
      driverMinFee: 4300,
    });

    const driverUser = await makeUser({ role: UserRole.DRIVER });
    const driver = await makeDriver(driverUser._id, { currentFund: 50000 });

    const order = await orderService.create({
      clientId: client._id.toString(),
      businessId: business._id.toString(),
      items: [{ productId: product._id.toString(), quantity: 1 }],
      paymentMethod: PaymentMethod.CASH_ON_DELIVERY,
      deliveryAddress: 'Cra 10 #5-23',
      deliveryLatitude: DESTINATION.lat,
      deliveryLongitude: DESTINATION.lng,
    });

    const ownerId = business.ownerId.toString();
    for (const status of [OrderStatus.ACCEPTED, OrderStatus.PREPARING, OrderStatus.READY]) {
      await orderService.updateStatus(order._id.toString(), status, ownerId, UserRole.BUSINESS);
    }
    await orderService.assignDriver(order._id.toString(), driver._id.toString());

    // Recoger y entregar exigen evidencia y código: `runDelivery` hace ese
    // camino completo, que es el único por el que un pedido puede llegar a
    // "entregado".
    const driverId = driverUser._id.toString();
    await runDelivery(order._id.toString(), driverUser);

    const report = await cashReconciliationService.report(driverId, [], 'CONSIGNACION-9912');
    expect(report.reportedCount).toBe(1);

    const afterReport = await CashReconciliation.findOne({ orderId: order._id });
    // Reportar no liquida: el saldo sigue debiéndose.
    expect(afterReport!.status).toBe(CashReconciliationStatus.REPORTED);
    expect(afterReport!.settledAt).toBeNull();

    // Y no existe transición REPORTED → SETTLED.
    await expect(
      cashReconciliationService.settle([String(afterReport!._id)], driverId)
    ).rejects.toThrow(/verificados/i);

    const stillOwed = await cashReconciliationService.forDriver(driverId);
    expect(stillOwed.reported).toBe(3000);
  });

  it('un admin financiero verifica y luego liquida, y el libro cuadra', async () => {
    const { client, business, product } = await baseScenario({
      cashOnDeliveryEnabled: true,
      driverBaseFee: 4300,
      driverMinFee: 4300,
    });

    const financeAdmin = await makeUser({ role: UserRole.ADMIN, isFinanceAdmin: true });
    const driverUser = await makeUser({ role: UserRole.DRIVER });
    const driver = await makeDriver(driverUser._id, { currentFund: 50000 });

    const order = await orderService.create({
      clientId: client._id.toString(),
      businessId: business._id.toString(),
      items: [{ productId: product._id.toString(), quantity: 1 }],
      paymentMethod: PaymentMethod.CASH_ON_DELIVERY,
      deliveryAddress: 'Cra 10 #5-23',
      deliveryLatitude: DESTINATION.lat,
      deliveryLongitude: DESTINATION.lng,
    });

    const ownerId = business.ownerId.toString();
    for (const status of [OrderStatus.ACCEPTED, OrderStatus.PREPARING, OrderStatus.READY]) {
      await orderService.updateStatus(order._id.toString(), status, ownerId, UserRole.BUSINESS);
    }
    await orderService.assignDriver(order._id.toString(), driver._id.toString());

    // Recoger y entregar exigen evidencia y código: `runDelivery` hace ese
    // camino completo, que es el único por el que un pedido puede llegar a
    // "entregado".
    await runDelivery(order._id.toString(), driverUser);

    const record = await CashReconciliation.findOne({ orderId: order._id });
    const adminId = financeAdmin._id.toString();

    await cashReconciliationService.verifyByAdmin([String(record!._id)], adminId, 'Depósito 991');
    await cashReconciliationService.settle([String(record!._id)], adminId);

    const settled = await CashReconciliation.findById(record!._id);
    expect(settled!.status).toBe(CashReconciliationStatus.SETTLED);
    expect(settled!.verifiedBy!.toString()).toBe(adminId);

    const cashInTransit = await ledgerService.accountBalance(LedgerAccount.CASH_IN_TRANSIT, {
      orderId: order._id,
    });
    expect(cashInTransit.balance).toBe(0);
    expect(await ledgerService.isBalanced({ orderId: order._id })).toBe(true);
  });

  it('cancelar un pedido en efectivo devuelve el fondo al repartidor', async () => {
    const { client, business, product } = await baseScenario({
      cashOnDeliveryEnabled: true,
      driverBaseFee: 4300,
      driverMinFee: 4300,
    });

    const driverUser = await makeUser({ role: UserRole.DRIVER });
    const driver = await makeDriver(driverUser._id, { currentFund: 50000 });

    const order = await orderService.create({
      clientId: client._id.toString(),
      businessId: business._id.toString(),
      items: [{ productId: product._id.toString(), quantity: 1 }],
      paymentMethod: PaymentMethod.CASH_ON_DELIVERY,
      deliveryAddress: 'Cra 10 #5-23',
      deliveryLatitude: DESTINATION.lat,
      deliveryLongitude: DESTINATION.lng,
    });

    const ownerId = business.ownerId.toString();
    for (const status of [OrderStatus.ACCEPTED, OrderStatus.PREPARING, OrderStatus.READY]) {
      await orderService.updateStatus(order._id.toString(), status, ownerId, UserRole.BUSINESS);
    }
    await orderService.assignDriver(order._id.toString(), driver._id.toString());

    expect((await Driver.findById(driver._id))!.currentFund).toBe(50000 - 27000);

    await orderService.updateStatus(
      order._id.toString(),
      OrderStatus.CANCELLED,
      ownerId,
      UserRole.BUSINESS,
      'Sin inventario'
    );

    // Esto era el error: el fondo quedaba congelado para siempre.
    expect((await Driver.findById(driver._id))!.currentFund).toBe(50000);
  });
});

describe('9 · Configuración editable y aislamiento histórico', () => {
  it('un cambio de configuración no altera pedidos ya creados', async () => {
    const { client, business, product } = await baseScenario({
      driverBaseFee: 4300,
      driverMinFee: 4300,
      serviceFeeFixed: 1000,
    });

    const order = await orderService.create({
      clientId: client._id.toString(),
      businessId: business._id.toString(),
      items: [{ productId: product._id.toString(), quantity: 1 }],
      paymentMethod: PaymentMethod.ONLINE,
      deliveryAddress: 'Cra 10 #5-23',
      deliveryLatitude: DESTINATION.lat,
      deliveryLongitude: DESTINATION.lng,
    });

    const originalTotal = order.finance.customerTotal;
    const originalVersion = order.pricingConfigVersion;

    const admin = await makeUser({ role: UserRole.ADMIN, isFinanceAdmin: true });
    await pricingConfigService.update(
      { serviceFeeFixed: 5000, merchantCommissionBps: 2500 },
      { userId: admin._id.toString(), reason: 'Ajuste comercial de prueba' }
    );

    const reloaded = await Order.findById(order._id);
    expect(reloaded!.finance.customerTotal).toBe(originalTotal);
    expect(reloaded!.finance.merchantCommission).toBe(3000);
    expect(reloaded!.pricingConfigVersion).toBe(originalVersion);

    // Los pedidos nuevos sí usan la versión nueva.
    const next = await pricingService.quote(
      quoteInput(client._id.toString(), business._id.toString(), product._id.toString())
    );
    expect(next.pricingConfigVersion).toBe(originalVersion + 1);
  });

  it('cada cambio queda auditado con motivo, autor y valores', async () => {
    await makePricingConfig();
    const admin = await makeUser({ role: UserRole.ADMIN, isFinanceAdmin: true });

    await pricingConfigService.update(
      { merchantCommissionBps: 1200 },
      {
        userId: admin._id.toString(),
        userName: admin.name,
        reason: 'Subida de comisión acordada con dirección',
      }
    );

    const trail = await pricingConfigService.getAuditTrail(10);
    expect(trail).toHaveLength(1);
    expect(trail[0].reason).toMatch(/dirección/);
    expect(trail[0].changes.merchantCommissionBps).toEqual({ before: 1000, after: 1200 });
    expect(trail[0].fromVersion).toBe(1);
    expect(trail[0].toVersion).toBe(2);
  });

  it('exige un motivo para cambiar la configuración', async () => {
    await makePricingConfig();
    const admin = await makeUser({ role: UserRole.ADMIN, isFinanceAdmin: true });

    await expect(
      pricingConfigService.update(
        { merchantCommissionBps: 1200 },
        { userId: admin._id.toString(), reason: '' }
      )
    ).rejects.toThrow(/motivo/i);
  });

  it('la comisión por categoría se aplica cuando el comercio no la sobreescribe', async () => {
    await makePricingConfig({
      merchantCommissionBps: 1000,
      categoryCommissionBps: { supermarket: 800 },
    });

    const client = await makeUser();
    const owner = await makeUser({ role: UserRole.BUSINESS });
    const business = await makeBusiness(owner._id, {
      category: 'supermarket',
      commissionRateBps: -1,
    });
    const product = await makeProduct(business._id, { price: 30000 });

    const quote = await pricingService.quote(
      quoteInput(client._id.toString(), business._id.toString(), product._id.toString())
    );

    expect(quote.appliedCommissionBps).toBe(800);
    expect(quote.merchantCommission).toBe(2400);
    expectBalanced(quote);
  });

  it('rechaza rangos de tarifa incoherentes', async () => {
    await expect(
      makePricingConfig({ deliveryMinFee: 9000, deliveryMaxFee: 5000 })
    ).rejects.toThrow(/mínima .* no puede superar la máxima/i);

    await expect(
      makePricingConfig({ serviceFeeMin: 5000, serviceFeeMax: 1000 })
    ).rejects.toThrow(/servicio mínimo/i);
  });
});

describe('10 · Liquidaciones', () => {
  it('los payouts pasan de devengado a pagadero solo al confirmarse el cobro', async () => {
    setPaymentProvider(new SandboxPaymentProvider());
    const { client, business, product } = await baseScenario({
      driverBaseFee: 4300,
      driverMinFee: 4300,
    });

    const order = await orderService.create({
      clientId: client._id.toString(),
      businessId: business._id.toString(),
      items: [{ productId: product._id.toString(), quantity: 1 }],
      paymentMethod: PaymentMethod.ONLINE,
      deliveryAddress: 'Cra 10 #5-23',
      deliveryLatitude: DESTINATION.lat,
      deliveryLongitude: DESTINATION.lng,
    });

    let summary = await payoutService.summaryFor({
      beneficiary: PayoutBeneficiary.BUSINESS,
      businessId: business._id.toString(),
    });
    expect(summary.accrued).toBe(27000);
    expect(summary.payable).toBe(0);

    await paymentService.initiate({
      orderId: order._id.toString(),
      userId: client._id.toString(),
      amount: order.finance.customerTotal,
      description: 'Prueba',
      customer: { name: 'Cliente', phone: '3101234567' },
    });

    summary = await payoutService.summaryFor({
      beneficiary: PayoutBeneficiary.BUSINESS,
      businessId: business._id.toString(),
    });
    expect(summary.accrued).toBe(0);
    expect(summary.payable).toBe(27000);
  });

  it('una liquidación agrupa lo pagadero y lo marca liquidado', async () => {
    setPaymentProvider(new SandboxPaymentProvider());
    const { client, business, product } = await baseScenario({
      driverBaseFee: 4300,
      driverMinFee: 4300,
    });
    const admin = await makeUser({ role: UserRole.ADMIN, isFinanceAdmin: true });

    for (let i = 0; i < 2; i += 1) {
      const order = await orderService.create({
        clientId: client._id.toString(),
        businessId: business._id.toString(),
        items: [{ productId: product._id.toString(), quantity: 1 }],
        paymentMethod: PaymentMethod.ONLINE,
        deliveryAddress: 'Cra 10 #5-23',
        deliveryLatitude: DESTINATION.lat,
        deliveryLongitude: DESTINATION.lng,
        idempotencyKey: `order-${i}`,
      });
      await paymentService.initiate({
        orderId: order._id.toString(),
        userId: client._id.toString(),
        amount: order.finance.customerTotal,
        description: 'Prueba',
        customer: { name: 'Cliente', phone: '3101234567' },
      });
    }

    const result = await payoutService.settle({
      beneficiary: PayoutBeneficiary.BUSINESS,
      businessId: business._id.toString(),
      reference: 'TRF-2026-001',
      createdBy: admin._id.toString(),
    });

    expect(result.count).toBe(2);
    expect(result.netAmount).toBe(54000);
    expect(result.settlement!.reference).toBe('TRF-2026-001');

    const summary = await payoutService.summaryFor({
      beneficiary: PayoutBeneficiary.BUSINESS,
      businessId: business._id.toString(),
    });
    expect(summary.payable).toBe(0);
    expect(summary.settled).toBe(54000);
  });
});
