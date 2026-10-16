import { describe, it, expect, beforeEach } from 'vitest';
import { Order } from '../models';
import { OrderStatus, UserRole, PaymentMethod, PaymentStatus } from '../types';
import { businessAnalyticsService } from '../services/businessAnalytics.service';
import { orderService } from '../services/order.service';
import {
  makeUser, makeBusiness, makeProduct, makePricingConfig, GARZON,
} from './factories';

/**
 * Analíticas del comercio.
 *
 * El panel las calculaba en el navegador sobre los últimos cien pedidos, y
 * ese número no es una muestra: es "lo que cupo en la primera página". Un
 * negocio con tráfico veía como "ventas del mes" las de dos días, y no
 * tenía forma de notarlo.
 */
describe('Analíticas del comercio', () => {
  let client: any;
  let business: any;
  let product: any;

  const orderAt = async (when: Date, status = OrderStatus.DELIVERED) => {
    const order = await orderService.create({
      clientId: client._id.toString(),
      businessId: business._id.toString(),
      items: [{ productId: product._id.toString(), quantity: 1 }],
      paymentMethod: PaymentMethod.ONLINE,
      deliveryAddress: 'Cra 1 #2-3',
      deliveryLongitude: GARZON.lng,
      deliveryLatitude: GARZON.lat,
    });

    // Se escribe por el driver nativo y no por Mongoose: `createdAt` es
    // inmutable cuando el esquema usa timestamps, así que un `updateOne`
    // normal lo ignora en silencio y todos los pedidos quedan con la fecha
    // de hoy — que es justo lo que estas pruebas necesitan mover.
    await Order.collection.updateOne(
      { _id: order._id },
      {
        $set: {
          status,
          // Un pedido en línea entregado ya se cobró; uno cancelado que
          // llegó a cobrarse, se reembolsó. Sin cobro no cuenta para el
          // comercio (nunca lo vio).
          paymentStatus: status === OrderStatus.CANCELLED ? PaymentStatus.REFUNDED : PaymentStatus.PAID,
          createdAt: when,
          ...(status === OrderStatus.DELIVERED ? { deliveredAt: when } : {}),
        },
      }
    );
    return order;
  };

  const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

  beforeEach(async () => {
    await makePricingConfig();
    client = await makeUser({ role: UserRole.CLIENT });
    const owner = await makeUser({ role: UserRole.BUSINESS });
    business = await makeBusiness(owner._id, { lat: GARZON.lat, lng: GARZON.lng });
    product = await makeProduct(business._id, { price: 10000 });
  });

  it('cuenta los pedidos del rango pedido', async () => {
    await orderAt(daysAgo(1));
    await orderAt(daysAgo(2));

    const analytics = await businessAnalyticsService.analyticsFor(business._id.toString());

    expect(analytics.totals.orders).toBe(2);
    expect(analytics.totals.delivered).toBe(2);
  });

  it('solo lo entregado cuenta como venta', async () => {
    await orderAt(daysAgo(1), OrderStatus.DELIVERED);
    await orderAt(daysAgo(1), OrderStatus.CANCELLED);

    const analytics = await businessAnalyticsService.analyticsFor(business._id.toString());

    // Contar lo cancelado infla el número justo cuando algo va mal, que es
    // cuando más se mira.
    expect(analytics.totals.orders).toBe(2);
    expect(analytics.totals.revenue).toBe(10000);
    expect(analytics.totals.cancelled).toBe(1);
  });

  it('calcula la tasa de cancelación', async () => {
    await orderAt(daysAgo(1), OrderStatus.DELIVERED);
    await orderAt(daysAgo(1), OrderStatus.DELIVERED);
    await orderAt(daysAgo(1), OrderStatus.DELIVERED);
    await orderAt(daysAgo(1), OrderStatus.CANCELLED);

    const analytics = await businessAnalyticsService.analyticsFor(business._id.toString());
    expect(analytics.totals.cancellationRate).toBe(25);
  });

  it('el ticket promedio se calcula sobre lo entregado, no sobre todo', async () => {
    await orderAt(daysAgo(1), OrderStatus.DELIVERED);
    await orderAt(daysAgo(1), OrderStatus.CANCELLED);

    const analytics = await businessAnalyticsService.analyticsFor(business._id.toString());
    expect(analytics.totals.averageTicket).toBe(10000);
  });

  it('deja fuera lo anterior al rango', async () => {
    await orderAt(daysAgo(1));
    await orderAt(daysAgo(60));

    const analytics = await businessAnalyticsService.analyticsFor(business._id.toString(), {
      days: 30,
    });

    expect(analytics.totals.orders).toBe(1);
  });

  it('compara con un periodo anterior del mismo tamaño', async () => {
    await orderAt(daysAgo(3));
    await orderAt(daysAgo(12));
    await orderAt(daysAgo(13));

    // Siete días contra los siete anteriores. Comparar con un mes natural
    // daría subidas y bajadas que solo existen en el calendario.
    const analytics = await businessAnalyticsService.analyticsFor(business._id.toString(), {
      days: 7,
    });

    expect(analytics.totals.orders).toBe(1);
    expect(analytics.previous.orders).toBe(2);
  });

  it('agrupa las ventas por día', async () => {
    await orderAt(daysAgo(1));
    await orderAt(daysAgo(1));
    await orderAt(daysAgo(3));

    const analytics = await businessAnalyticsService.analyticsFor(business._id.toString());

    expect(analytics.byDay).toHaveLength(2);
    const busiest = analytics.byDay.find((d) => d.orders === 2);
    expect(busiest).toBeDefined();
    expect(busiest!.revenue).toBe(20000);
  });

  it('agrupa por hora, para poder ver las horas pico', async () => {
    const at = new Date(daysAgo(1));
    at.setUTCHours(13, 0, 0, 0);
    await orderAt(at);

    const analytics = await businessAnalyticsService.analyticsFor(business._id.toString());

    expect(analytics.byHour).toHaveLength(1);
    // 13:00 UTC son las 8 de la mañana en Colombia: las horas pico son del comercio.
    expect(analytics.byHour[0].hour).toBe(8);
  });

  it('no mezcla las ventas de otro negocio', async () => {
    const otherOwner = await makeUser({ role: UserRole.BUSINESS });
    const other = await makeBusiness(otherOwner._id, { lat: GARZON.lat, lng: GARZON.lng });

    await orderAt(daysAgo(1));

    const analytics = await businessAnalyticsService.analyticsFor(other._id.toString());
    expect(analytics.totals.orders).toBe(0);
  });

  it('los días se agrupan con la fecha de Colombia, no la de UTC', async () => {
    // 02:00 UTC del día 15 son las 21:00 del día 14 en Colombia.
    const at = new Date('2026-10-15T02:00:00Z');
    await orderAt(at);
    const analytics = await businessAnalyticsService.analyticsFor(business._id.toString(), { days: 365 });
    expect(analytics.byDay.map((d) => d.date)).toEqual(['2026-10-14']);
  });

  it('lo más vendido sale por unidades', async () => {
    const other = await makeProduct(business._id, { price: 5000 });
    await orderAt(daysAgo(1));
    await orderAt(daysAgo(2));
    const third = await orderService.create({
      clientId: client._id.toString(),
      businessId: business._id.toString(),
      items: [{ productId: other._id.toString(), quantity: 1 }],
      paymentMethod: PaymentMethod.ONLINE,
      deliveryAddress: 'Cra 1 #2-3',
      deliveryLongitude: GARZON.lng,
      deliveryLatitude: GARZON.lat,
    });
    await Order.collection.updateOne(
      { _id: third._id },
      { $set: { status: OrderStatus.DELIVERED, paymentStatus: PaymentStatus.PAID, createdAt: daysAgo(1) } }
    );

    const analytics = await businessAnalyticsService.analyticsFor(business._id.toString());

    expect(analytics.topProducts[0]).toMatchObject({ productId: product._id.toString(), quantity: 2, sales: 20000 });
    expect(analytics.topProducts[1]).toMatchObject({ productId: other._id.toString(), quantity: 1 });
  });

  it('el tiempo de preparación va de aceptar a dejar listo', async () => {
    const a = await orderAt(daysAgo(1));
    const b = await orderAt(daysAgo(1));
    const base = daysAgo(1).getTime();
    await Order.collection.updateOne({ _id: a._id }, { $set: { acceptedAt: new Date(base), preparedAt: new Date(base + 10 * 60_000) } });
    await Order.collection.updateOne({ _id: b._id }, { $set: { acceptedAt: new Date(base), preparedAt: new Date(base + 20 * 60_000) } });

    const analytics = await businessAnalyticsService.analyticsFor(business._id.toString());
    expect(analytics.avgPrepMinutes).toBe(15);
  });

  it('sin datos de preparación devuelve null, no cero', async () => {
    await orderAt(daysAgo(1));
    expect((await businessAnalyticsService.analyticsFor(business._id.toString())).avgPrepMinutes).toBeNull();
  });

  it('separa clientes nuevos de recurrentes', async () => {
    const returning = await makeUser({ role: UserRole.CLIENT });
    const fresh = await makeUser({ role: UserRole.CLIENT });
    const buy = async (who: any, when: Date) => {
      const order = await orderService.create({
        clientId: who._id.toString(),
        businessId: business._id.toString(),
        items: [{ productId: product._id.toString(), quantity: 1 }],
        paymentMethod: PaymentMethod.ONLINE,
        deliveryAddress: 'Cra 1 #2-3',
        deliveryLongitude: GARZON.lng,
        deliveryLatitude: GARZON.lat,
      });
      await Order.collection.updateOne(
        { _id: order._id },
        { $set: { status: OrderStatus.DELIVERED, paymentStatus: PaymentStatus.PAID, createdAt: when } }
      );
    };
    await buy(returning, daysAgo(60)); // antes del periodo de 30 días
    await buy(returning, daysAgo(2));
    await buy(fresh, daysAgo(3));

    const analytics = await businessAnalyticsService.analyticsFor(business._id.toString());
    expect(analytics.customers).toEqual({ total: 2, new: 1, returning: 1 });
  });

  it('cuenta los pedidos que el comercio rechazó o dejó vencer', async () => {
    const mine = await orderAt(daysAgo(1), OrderStatus.CANCELLED);
    const expired = await orderAt(daysAgo(1), OrderStatus.CANCELLED);
    const byClient = await orderAt(daysAgo(1), OrderStatus.CANCELLED);
    await Order.collection.updateOne({ _id: mine._id }, { $set: { cancelledBy: 'business' } });
    await Order.collection.updateOne({ _id: expired._id }, { $set: { cancelledBy: 'system', cancellationCode: 'business_no_response' } });
    await Order.collection.updateOne({ _id: byClient._id }, { $set: { cancelledBy: 'client' } });

    const analytics = await businessAnalyticsService.analyticsFor(business._id.toString());
    expect(analytics.lostByBusiness).toEqual({ orders: 2, rate: 67 });
  });

  it('un negocio sin ventas devuelve ceros, no se rompe', async () => {
    const analytics = await businessAnalyticsService.analyticsFor(business._id.toString());

    expect(analytics.totals.orders).toBe(0);
    expect(analytics.totals.averageTicket).toBe(0);
    expect(analytics.totals.cancellationRate).toBe(0);
    expect(analytics.byDay).toEqual([]);
  });
});
