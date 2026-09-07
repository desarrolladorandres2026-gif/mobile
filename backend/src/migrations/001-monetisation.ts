import mongoose from 'mongoose';
import {
  Order,
  Business,
  Coupon,
  DriverDebt,
  CashReconciliation,
  PlatformPricingConfig,
} from '../models';
import {
  CouponFundedBy,
  CouponScope,
  CouponType,
  CashReconciliationStatus,
  DebtStatus,
  PaymentMethod,
  PaymentStatus,
  OrderStatus,
  PayoutStatus,
} from '../types';
import { pricingConfigService } from '../services/pricingConfig.service';
import { payoutService } from '../services/payout.service';

/**
 * Migration 001 — monetisation model.
 *
 * Guiding rule: **historical orders keep the money they were priced with.**
 * Nothing here recomputes a past order. The snapshot is *derived* from the
 * fields already on the row, so the numbers stay byte-identical; what
 * changes is that they now live in a structured, versioned place.
 *
 * Version 0 is reserved for "priced before this migration", which makes
 * pre-migration orders trivially identifiable in any report.
 *
 * Safe to run repeatedly: every step skips rows it has already handled.
 */

export interface MigrationReport {
  pricingConfigVersion: number;
  ordersMigrated: number;
  ordersSkipped: number;
  businessesMigrated: number;
  couponsMigrated: number;
  debtsMigrated: number;
  payoutsCreated: number;
  warnings: string[];
}

export async function migrateMonetisation(
  options: { dryRun?: boolean } = {}
): Promise<MigrationReport> {
  const report: MigrationReport = {
    pricingConfigVersion: 0,
    ordersMigrated: 0,
    ordersSkipped: 0,
    businessesMigrated: 0,
    couponsMigrated: 0,
    debtsMigrated: 0,
    payoutsCreated: 0,
    warnings: [],
  };

  // ── 1. Bootstrap pricing config from the current environment ──
  const existing = await PlatformPricingConfig.findOne({ isCurrent: true });
  const config = existing ?? (await pricingConfigService.getCurrent());
  report.pricingConfigVersion = config.version;

  if (options.dryRun) {
    report.warnings.push('Ejecución en seco: no se escribió ningún cambio.');
  }

  // ── 2. Businesses: decimal rate → basis points, grandfather approval ──
  const businesses = await Business.find({
    $or: [{ commissionRateBps: { $exists: false } }, { commissionRateBps: -1 }],
  });

  for (const business of businesses) {
    // Every business that was already live keeps trading. Requiring a fresh
    // approval on migration day would take the whole catalogue offline.
    const updates: Record<string, unknown> = { isApproved: true };

    if (typeof business.commissionRate === 'number') {
      updates.commissionRateBps = Math.round(business.commissionRate * 10_000);
    }

    if (!options.dryRun) {
      await Business.updateOne({ _id: business._id }, { $set: updates });
    }
    report.businessesMigrated += 1;
  }

  // ── 3. Coupons: infer funding from how they used to behave ──
  const coupons = await Coupon.find({ fundedBy: { $exists: false } });

  for (const coupon of coupons) {
    // The old rule was implicit: a coupon tied to a business was funded by
    // that business. Free-delivery coupons were charged to whoever
    // collected, which in practice was the platform.
    const scope =
      coupon.type === CouponType.FREE_DELIVERY ? CouponScope.DELIVERY : CouponScope.PRODUCT;

    const fundedBy =
      coupon.businessId && scope === CouponScope.PRODUCT
        ? CouponFundedBy.BUSINESS
        : CouponFundedBy.PLATFORM;

    if (coupon.businessId && scope === CouponScope.DELIVERY) {
      report.warnings.push(
        `Cupón ${coupon.code}: era de envío gratis atado a un comercio. ` +
          'Ahora lo financia la plataforma, porque el domicilio no es dinero del comercio.'
      );
    }

    if (!options.dryRun) {
      await Coupon.updateOne(
        { _id: coupon._id },
        {
          $set: {
            fundedBy,
            scope,
            maxDiscountAmount: coupon.maxDiscount ?? 0,
            budgetLimit: 0,
            budgetSpent: 0,
            minimumContributionMargin: -1,
            campaignApproved: true, // grandfather running campaigns
          },
        }
      );
    }
    report.couponsMigrated += 1;
  }

  // ── 4. Orders: derive the snapshot from what is already stored ──
  const cursor = Order.find({
    $or: [{ 'finance.customerTotal': { $exists: false } }, { 'finance.customerTotal': 0 }],
  }).cursor();

  for await (const order of cursor) {
    if (!order.total) {
      report.ordersSkipped += 1;
      continue;
    }

    const subtotal = order.subtotal ?? 0;
    const deliveryFee = order.deliveryFee ?? 0;
    const commission = order.platformCommission ?? 0;
    const businessPayout = order.businessPayout ?? 0;
    const driverPayout = order.driverPayout ?? 0;
    const tip = order.tip ?? 0;
    const tax = order.tax ?? 0;
    const discount = order.discount ?? 0;

    // Under the old model the merchant funded a discount exactly when its
    // payout had been reduced below the full subtotal by more than the
    // commission. Anything else the platform absorbed.
    const merchantFundedDiscount = Math.max(
      0,
      Math.min(discount, subtotal - commission - businessPayout)
    );
    const platformFundedDiscount = discount - merchantFundedDiscount;

    // The old model paid the whole delivery fee to the driver (minus, on
    // cash orders, the commission it clawed back). There was no margin
    // concept, so the driver's guarantee is reconstructed as what they
    // actually received for the trip.
    const driverDeliveryPayout = Math.max(0, driverPayout - tip);
    const deliveryMargin = deliveryFee - driverDeliveryPayout;

    const platformGrossRevenue = commission + deliveryMargin;

    const finance = {
      productSubtotal: subtotal,
      merchantCommission: commission,
      customerServiceFee: 0, // did not exist before this migration
      deliveryCustomerFee: deliveryFee,
      driverDeliveryPayout,
      deliveryMargin,
      tip,
      merchantFundedDiscount,
      platformFundedDiscount,
      taxPayable: tax,
      businessPayout,
      driverPayout,
      platformGrossRevenue,
      platformPromotionExpense: platformFundedDiscount,
      platformNetRevenueBeforeOperatingCosts:
        platformGrossRevenue - platformFundedDiscount,
      customerTotal: order.total,
      currency: 'COP',
      // 0 marks "priced under the pre-migration rules".
      pricingConfigVersion: 0,
      appliedCommissionBps: subtotal > 0 ? Math.round((commission / subtotal) * 10_000) : 0,
    };

    // Report, but do not "fix", any historical order whose books never
    // balanced. Rewriting settled history would be worse than recording
    // that it was inconsistent.
    const inflow = finance.customerTotal + finance.platformFundedDiscount;
    const outflow =
      finance.businessPayout +
      finance.driverPayout +
      finance.platformGrossRevenue +
      finance.taxPayable;

    if (inflow !== outflow) {
      report.warnings.push(
        `Pedido ${order.orderNumber}: descuadre histórico de ${inflow - outflow} COP. ` +
          'Se conserva tal cual; no se recalcula.'
      );
    }

    if (!options.dryRun) {
      await Order.updateOne(
        { _id: order._id },
        { $set: { finance, pricingConfigVersion: 0 } }
      );
    }
    report.ordersMigrated += 1;
  }

  // ── 5. Payouts for orders that already completed ──
  const settledOrders = await Order.find({
    status: OrderStatus.DELIVERED,
    'finance.customerTotal': { $gt: 0 },
  }).limit(5000);

  for (const order of settledOrders) {
    if (options.dryRun) continue;

    const payouts = await payoutService.accrueForOrder(order);
    report.payoutsCreated += payouts.length;

    // A delivered order was, under the old model, considered paid — so its
    // payouts are already earned rather than merely accrued.
    if (order.paymentStatus === PaymentStatus.PAID) {
      await payoutService.release(order._id);
    }
  }

  // ── 6. DriverDebt → CashReconciliation ──
  const debts = await DriverDebt.find({ status: DebtStatus.PENDING });

  for (const debt of debts) {
    const already = await CashReconciliation.findOne({ orderId: debt.orderId });
    if (already) continue;

    const order = await Order.findById(debt.orderId);

    if (!options.dryRun) {
      await CashReconciliation.create({
        driverId: debt.driverId,
        orderId: debt.orderId,
        amount: debt.amount,
        breakdown: {
          merchantCommission: debt.amount,
          customerServiceFee: 0,
          deliveryMargin: 0,
          taxPayable: 0,
        },
        // Carried over as pending: these balances were never actually
        // verified, and the old endpoint let drivers clear them unilaterally.
        status: CashReconciliationStatus.PENDING,
        dueAt: new Date(Date.now() + 7 * 24 * 3600_000),
        createdAt: debt.createdAt,
      });
    }
    report.debtsMigrated += 1;

    if (order && order.paymentMethod !== PaymentMethod.CASH_ON_DELIVERY) {
      report.warnings.push(
        `Deuda ${debt._id}: el pedido ${order.orderNumber} no era contra entrega.`
      );
    }
  }

  return report;
}

// ── CLI entry point ──────────────────────────────────────────────────
// Run with: npm run migrate:monetisation [-- --dry-run]
if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');

  (async () => {
    const { config } = await import('../config');
    await mongoose.connect(config.mongodb.uri);
    console.log(`\n▸ Migración 001 — monetización${dryRun ? ' (ejecución en seco)' : ''}\n`);

    try {
      const report = await migrateMonetisation({ dryRun });

      console.log(`  Config de precios      v${report.pricingConfigVersion}`);
      console.log(`  Pedidos migrados       ${report.ordersMigrated}`);
      console.log(`  Pedidos omitidos       ${report.ordersSkipped}`);
      console.log(`  Comercios migrados     ${report.businessesMigrated}`);
      console.log(`  Cupones migrados       ${report.couponsMigrated}`);
      console.log(`  Deudas migradas        ${report.debtsMigrated}`);
      console.log(`  Payouts creados        ${report.payoutsCreated}`);

      if (report.warnings.length > 0) {
        console.log(`\n  Advertencias (${report.warnings.length}):`);
        for (const warning of report.warnings.slice(0, 50)) {
          console.log(`   • ${warning}`);
        }
        if (report.warnings.length > 50) {
          console.log(`   … y ${report.warnings.length - 50} más`);
        }
      }

      console.log('\n✔ Migración completada\n');
      process.exit(0);
    } catch (error) {
      console.error('\n✖ La migración falló:', error);
      process.exit(1);
    }
  })();
}
