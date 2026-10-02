import mongoose from 'mongoose';
import { config } from '../config';
import { Business, Order, Product, User, Driver } from '../models';
import { OrderStatus, PaymentMethod, PaymentStatus, CancellationReason, CancelledBy, UserRole } from '../types';
import { applyBps } from '../utils/money';

/**
 * Pedidos de demostración para "Terminal neiva" (solo dev). Sirve para ver el
 * panel de comercios con datos. Idempotente por `idempotencyKey`. No toca el
 * libro mayor: son pedidos de muestra, no dinero real.
 */

const SLUG = 'terminal-neiva';
const COMMISSION_BPS = 1000;
const DELIVERY_FEE = 4000;
const DRIVER_PAYOUT = 3000;
const MIN = 60_000;

interface Seed {
  key: string;
  minutesAgo: number;
  status: OrderStatus;
  payment: PaymentMethod;
  client: number;
  items: Array<[string, number]>;
  tip?: number;
  notes?: string;
  cancel?: { code: CancellationReason; by: CancelledBy; reason: string };
}

const D = 24 * 60;
const ON = PaymentMethod.ONLINE;
const CASH = PaymentMethod.CASH_ON_DELIVERY;
const SEEDS: Seed[] = [
  { key: 'a1', minutesAgo: 3, status: OrderStatus.PENDING, payment: ON, client: 0, items: [['Salchipapa Ranchera', 1], ['Gaseosa 1,5 L', 1]], notes: 'Sin cebolla, por favor' },
  { key: 'a2', minutesAgo: 8, status: OrderStatus.PENDING, payment: CASH, client: 1, items: [['Pizza Mitad y Mitad', 1]] },
  { key: 'a3', minutesAgo: 16, status: OrderStatus.PREPARING, payment: ON, client: 2, items: [['Mazorcada Mixta', 2], ['Jugo Natural 16 oz', 2]], tip: 2000 },
  { key: 'a4', minutesAgo: 24, status: OrderStatus.READY, payment: ON, client: 3, items: [['Perro Americano', 2], ['Choripapa', 1]] },
  { key: 'a5', minutesAgo: 33, status: OrderStatus.ON_WAY, payment: CASH, client: 0, items: [['Alitas BBQ x8', 1], ['Gaseosa 1,5 L', 1]] },
  { key: 'd1', minutesAgo: 95, status: OrderStatus.DELIVERED, payment: ON, client: 1, items: [['Sándwich Cubano', 2]], tip: 1500 },
  { key: 'd2', minutesAgo: 180, status: OrderStatus.DELIVERED, payment: CASH, client: 2, items: [['Patacón con Todo', 1], ['Jugo Natural 16 oz', 1]] },
  { key: 'd3', minutesAgo: 260, status: OrderStatus.DELIVERED, payment: ON, client: 3, items: [['Pizza Mitad y Mitad', 1], ['Gaseosa 1,5 L', 1]] },
  { key: 'd4', minutesAgo: D + 120, status: OrderStatus.DELIVERED, payment: ON, client: 0, items: [['Salchipapa Ranchera', 2]], tip: 2000 },
  { key: 'd5', minutesAgo: D + 300, status: OrderStatus.DELIVERED, payment: CASH, client: 1, items: [['Choripapa', 2], ['Gaseosa 1,5 L', 2]] },
  { key: 'd6', minutesAgo: 2 * D + 90, status: OrderStatus.DELIVERED, payment: ON, client: 2, items: [['Alitas BBQ x8', 2]] },
  { key: 'd7', minutesAgo: 2 * D + 400, status: OrderStatus.DELIVERED, payment: ON, client: 3, items: [['Perro Americano', 3], ['Jugo Natural 16 oz', 3]] },
  { key: 'd8', minutesAgo: 3 * D + 60, status: OrderStatus.DELIVERED, payment: CASH, client: 0, items: [['Mazorcada Mixta', 1]] },
  { key: 'd9', minutesAgo: 4 * D + 200, status: OrderStatus.DELIVERED, payment: ON, client: 1, items: [['Sándwich Cubano', 1], ['Patacón con Todo', 1]], tip: 1000 },
  { key: 'd10', minutesAgo: 5 * D + 150, status: OrderStatus.DELIVERED, payment: ON, client: 2, items: [['Pizza Mitad y Mitad', 2]] },
  { key: 'd11', minutesAgo: 6 * D + 310, status: OrderStatus.DELIVERED, payment: CASH, client: 3, items: [['Salchipapa Ranchera', 1], ['Choripapa', 1]] },
  { key: 'd12', minutesAgo: 8 * D + 100, status: OrderStatus.DELIVERED, payment: ON, client: 0, items: [['Alitas BBQ x8', 1], ['Jugo Natural 16 oz', 1]] },
  { key: 'c1', minutesAgo: D + 40, status: OrderStatus.CANCELLED, payment: ON, client: 1, items: [['Pizza Mitad y Mitad', 1]], cancel: { code: CancellationReason.BUSINESS_OUT_OF_STOCK, by: CancelledBy.BUSINESS, reason: 'Se agotó la masa de pizza' } },
  { key: 'c2', minutesAgo: 3 * D + 220, status: OrderStatus.CANCELLED, payment: CASH, client: 2, items: [['Perro Americano', 1]], cancel: { code: CancellationReason.CLIENT_CHANGED_MIND, by: CancelledBy.CLIENT, reason: 'Cambié de opinión' } },
];

const ADDRESSES = ['Carrera 5 # 12-30, Neiva', 'Calle 8 # 14-22, Neiva', 'Carrera 16 # 20-05, Neiva', 'Calle 26 # 7-48, Neiva'];

async function main(): Promise<void> {
  if (config.nodeEnv === 'production') {
    console.error('Este script no corre en producción.');
    process.exit(1);
  }
  await mongoose.connect(config.mongodb.uri);

  const business = await Business.findOne({ slug: SLUG });
  if (!business) throw new Error(`No existe el negocio ${SLUG}`);
  const products = await Product.find({ businessId: business._id });
  const byName = new Map(products.map((p) => [p.name, p]));
  const clients = await User.find({ role: UserRole.CLIENT, isActive: true }).sort({ createdAt: 1 }).limit(4);
  const driver = await Driver.findOne().select('_id');
  if (clients.length === 0) throw new Error('No hay clientes');

  let created = 0;
  for (const s of SEEDS) {
    const key = `demo-terminal-neiva-${s.key}`;
    if (await Order.exists({ idempotencyKey: key })) continue;

    const items = s.items.map(([name, quantity]) => {
      const p = byName.get(name);
      if (!p) throw new Error(`Producto no encontrado: ${name}`);
      return { productId: p._id, productName: p.name, quantity, unitPrice: p.price, totalPrice: p.price * quantity, selectedExtras: [] };
    });
    const subtotal = items.reduce((n, i) => n + i.totalPrice, 0);
    const tip = s.tip ?? 0;
    const commission = applyBps(subtotal, COMMISSION_BPS);
    const businessPayout = subtotal - commission;
    const total = subtotal + DELIVERY_FEE + tip;
    const at = new Date(Date.now() - s.minutesAgo * MIN);
    const after = (m: number) => new Date(at.getTime() + m * MIN);
    const st = s.status;
    const cash = s.payment === CASH;
    const hasDriver = [OrderStatus.PICKED_UP, OrderStatus.ON_WAY, OrderStatus.DELIVERED].includes(st);
    const progressed = st !== OrderStatus.PENDING && st !== OrderStatus.CANCELLED;
    const prepared = [OrderStatus.READY, OrderStatus.PICKED_UP, OrderStatus.ON_WAY, OrderStatus.DELIVERED].includes(st);
    let paymentStatus: PaymentStatus;
    if (st === OrderStatus.CANCELLED) paymentStatus = cash ? PaymentStatus.PENDING_CASH : PaymentStatus.REFUNDED;
    else if (cash) paymentStatus = st === OrderStatus.DELIVERED ? PaymentStatus.CASH_RECEIVED : PaymentStatus.PENDING_CASH;
    else paymentStatus = PaymentStatus.PAID;

    await Order.create({
      clientId: clients[s.client % clients.length]._id,
      businessId: business._id,
      driverId: hasDriver && driver ? driver._id : undefined,
      items,
      status: st,
      paymentMethod: s.payment,
      paymentStatus,
      cashPayment: cash ? { needsChange: false } : undefined,
      deliveryAddress: ADDRESSES[s.client % 4],
      deliveryLocation: { type: 'Point', coordinates: [-75.2819 + s.client * 0.002, 2.9273 + s.client * 0.001] },
      subtotal,
      deliveryFee: DELIVERY_FEE,
      tip,
      platformCommission: commission,
      businessPayout,
      driverPayout: DRIVER_PAYOUT + tip,
      total,
      finance: {
        productSubtotal: subtotal,
        merchantCommission: commission,
        deliveryCustomerFee: DELIVERY_FEE,
        driverDeliveryPayout: DRIVER_PAYOUT,
        deliveryMargin: DELIVERY_FEE - DRIVER_PAYOUT,
        tip,
        businessPayout,
        driverPayout: DRIVER_PAYOUT + tip,
        platformGrossRevenue: commission + DELIVERY_FEE - DRIVER_PAYOUT,
        platformNetRevenueBeforeOperatingCosts: commission + DELIVERY_FEE - DRIVER_PAYOUT,
        customerTotal: total,
        appliedCommissionBps: COMMISSION_BPS,
      },
      notes: s.notes ?? '',
      city: 'Neiva',
      idempotencyKey: key,
      acceptedAt: progressed ? after(2) : undefined,
      preparedAt: prepared ? after(15) : undefined,
      pickedUpAt: hasDriver ? after(20) : undefined,
      deliveredAt: st === OrderStatus.DELIVERED ? after(38) : undefined,
      cancelledAt: s.cancel ? after(5) : undefined,
      cancellationCode: s.cancel?.code,
      cancellationReason: s.cancel?.reason,
      cancelledBy: s.cancel?.by,
      createdAt: at,
      updatedAt: at,
    });
    created += 1;
  }
  console.log(`Pedidos creados: ${created} (de ${SEEDS.length})`);
  await mongoose.disconnect();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
