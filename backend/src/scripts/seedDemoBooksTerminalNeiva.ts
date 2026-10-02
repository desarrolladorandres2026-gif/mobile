import mongoose from 'mongoose';
import { config } from '../config';
import { Order } from '../models';
import { OrderStatus, PaymentMethod } from '../types';
import { ledgerService } from '../services/ledger.service';
import { payoutService } from '../services/payout.service';
import { cashReconciliationService } from '../services/cashReconciliation.service';

/**
 * Asienta en el libro mayor y los payouts los pedidos de demostración de
 * "Terminal neiva" (ver seedDemoOrdersTerminalNeiva.ts), con las mismas
 * llamadas que hace el flujo real: así Liquidaciones y Resumen se llenan por
 * el camino legítimo y no con filas inventadas.
 *
 * Solo dev. Idempotente: cada servicio ya lo es por pedido+evento. Los
 * cancelados no se asientan. Sin comisión de pasarela estimada (no hay cobro
 * real de Wompi detrás).
 */
async function main(): Promise<void> {
  if (config.nodeEnv === 'production') {
    console.error('Este script no corre en producción.');
    process.exit(1);
  }
  await mongoose.connect(config.mongodb.uri);

  const orders = await Order.find({
    idempotencyKey: /^demo-terminal-neiva-/,
    status: { $ne: OrderStatus.CANCELLED },
  }).sort({ createdAt: 1 });

  let booked = 0;
  for (const order of orders) {
    const finance = order.finance;
    await ledgerService.recordOrderPlaced({ orderId: order._id, finance, businessId: order.businessId });
    await payoutService.accrueForOrder(order);

    if (order.paymentMethod === PaymentMethod.ONLINE) {
      await ledgerService.recordPaymentCaptured({
        orderId: order._id,
        amount: finance.customerTotal,
        pricingConfigVersion: finance.pricingConfigVersion,
        transactionId: `demo-${order.orderNumber}`,
        currency: finance.currency,
      });
      await payoutService.release(order._id);
    } else if (order.status === OrderStatus.DELIVERED && order.driverId) {
      await ledgerService.recordCashCollected({
        orderId: order._id,
        customerTotal: finance.customerTotal,
        businessPayout: finance.businessPayout,
        driverPayout: finance.driverPayout,
        cashToRemit: finance.customerTotal - finance.businessPayout - finance.driverPayout,
        pricingConfigVersion: finance.pricingConfigVersion,
        driverId: order.driverId,
        businessId: order.businessId,
        currency: finance.currency,
      });
      await cashReconciliationService.open(order);
      await payoutService.dischargeInCash(order._id);
    }
    booked += 1;
  }

  console.log(`Pedidos asentados: ${booked}`);
  await mongoose.disconnect();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
