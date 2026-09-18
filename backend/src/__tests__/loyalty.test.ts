import { describe, it, expect, beforeEach } from 'vitest';
import { Order, LoyaltyMovement, LoyaltyMovementKind, Coupon, LedgerEntry } from '../models';
import {
  OrderStatus, UserRole, PaymentMethod, LedgerAccount, LedgerDirection, RefundKind,
} from '../types';
import { loyaltyService, POINT_VALUE_COP } from '../services/loyalty.service';
import { ledgerService } from '../services/ledger.service';
import { couponService } from '../services/coupon.service';
import { orderService } from '../services/order.service';
import { refundService } from '../services/refund.service';
import { paymentService, setPaymentProvider, SandboxPaymentProvider } from '../services/payments';
import { pricingConfigService } from '../services/pricingConfig.service';
import {
  makeUser, makeBusiness, makeProduct, makePricingConfig, GARZON,
} from './factories';

/** Lo que ZIPP sigue debiendo en puntos, según el libro mayor. */
const payableNet = async () => {
  const lines = await LedgerEntry.find({ account: LedgerAccount.LOYALTY_PAYABLE });
  return lines.reduce(
    (sum, l) => sum + (l.direction === LedgerDirection.CREDIT ? l.amount : -l.amount),
    0
  );
};

/**
 * Puntos ZIPP.
 *
 * Antes eran ficción del cliente: se derivaban del historial local del
 * teléfono, así que cambiaban de dispositivo y desaparecían al reinstalar.
 * Nadie los debía porque no existían en ninguna parte.
 *
 * Al hacerlos reales pasan a ser un pasivo: una promesa de descuento futuro
 * que ZIPP tiene que pagar. La mitad de estas pruebas existe para que ese
 * pasivo no se pierda ni se cuente dos veces.
 */
describe('Puntos y canje', () => {
  let client: any;
  let business: any;
  let product: any;

  const deliveredOrder = async (price = 50000) => {
    const localProduct = await makeProduct(business._id, { price });
    const order = await orderService.create({
      clientId: client._id.toString(),
      businessId: business._id.toString(),
      items: [{ productId: localProduct._id.toString(), quantity: 1 }],
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

  beforeEach(async () => {
    // 2% en puntos, sin mínimo de canje que estorbe a las pruebas.
    await makePricingConfig({ loyaltyEarnBps: 200, loyaltyMinRedeem: 100 });
    pricingConfigService.invalidate();

    client = await makeUser({ role: UserRole.CLIENT });
    const owner = await makeUser({ role: UserRole.BUSINESS });
    business = await makeBusiness(owner._id, { lat: GARZON.lat, lng: GARZON.lng });
    product = await makeProduct(business._id);
  });

  it('otorga puntos sobre el subtotal de productos', async () => {
    const order = await deliveredOrder(50000);

    const points = await loyaltyService.earnForOrder(order);

    // 2% de 50.000 = 1.000 puntos. No se premia el domicilio ni el impuesto.
    expect(points).toBe(1000);
    expect(await loyaltyService.balanceOf(client._id.toString())).toBe(1000);
  });

  it('con el programa apagado no otorga nada', async () => {
    await makePricingConfig({ loyaltyEarnBps: 0 });
    pricingConfigService.invalidate();

    const order = await deliveredOrder();
    expect(await loyaltyService.earnForOrder(order)).toBe(0);
  });

  it('no otorga dos veces por el mismo pedido', async () => {
    const order = await deliveredOrder(50000);

    await loyaltyService.earnForOrder(order);
    // El evento de entrega puede llegar dos veces: una pasarela que
    // reintenta, un despliegue a mitad.
    expect(await loyaltyService.earnForOrder(order)).toBe(0);

    expect(await loyaltyService.balanceOf(client._id.toString())).toBe(1000);
  });

  it('emitir puntos crea el pasivo en el libro mayor', async () => {
    const order = await deliveredOrder(50000);
    await loyaltyService.earnForOrder(order);

    // Un punto emitido es dinero que ZIPP debe. Sin registrarlo, el
    // programa se come el margen sin que nadie lo vea venir.
    const liability = await LedgerEntry.find({ account: LedgerAccount.LOYALTY_PAYABLE });
    expect(liability).toHaveLength(1);
    expect(liability[0].amount).toBe(1000 * POINT_VALUE_COP);
    expect(liability[0].direction).toBe(LedgerDirection.CREDIT);
  });

  it('el libro sigue cuadrado tras emitir', async () => {
    const order = await deliveredOrder(50000);
    await loyaltyService.earnForOrder(order);

    expect(await ledgerService.isBalanced()).toBe(true);
  });

  // ── Canje ──

  it('canjear genera un cupón por el valor de los puntos', async () => {
    const order = await deliveredOrder(50000);
    await loyaltyService.earnForOrder(order);

    const { coupon, value } = await loyaltyService.redeem(client._id.toString(), 1000);

    expect(value).toBe(1000);
    expect(coupon.value).toBe(1000);
    expect(await loyaltyService.balanceOf(client._id.toString())).toBe(0);
  });

  it('el cupón del canje es nominal: solo lo usa quien lo canjeó', async () => {
    const order = await deliveredOrder(50000);
    await loyaltyService.earnForOrder(order);
    const { coupon } = await loyaltyService.redeem(client._id.toString(), 1000);

    const saved = await Coupon.findById(coupon._id);
    expect(saved!.restrictedToUserId!.toString()).toBe(client._id.toString());

    // Un cupón de puntos que circula por WhatsApp deja de ser un canje:
    // quien lo usa no gastó ningún punto.
    const otro = await makeUser({ role: UserRole.CLIENT });
    await expect(
      couponService.validate(coupon.code, {
        userId: otro._id.toString(),
        businessId: business._id.toString(),
        city: 'Garzón',
        subtotal: 50000,
        deliveryFee: 3000,
        serviceFee: 0,
        zoneId: null,
        userRole: 'client',
      } as never,
      await pricingConfigService.getCurrent())
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('canjear extingue el pasivo y revierte la provisión', async () => {
    const order = await deliveredOrder(50000);
    await loyaltyService.earnForOrder(order);
    await loyaltyService.redeem(client._id.toString(), 1000);

    // El pasivo neto se va: ya no se deben esos puntos. Y la provisión de
    // gasto se revierte, porque el gasto real lo registrará el pedido
    // cuando el cupón se aplique — si no, se contaría dos veces.
    const lines = await LedgerEntry.find({ account: LedgerAccount.LOYALTY_PAYABLE });
    const net = lines.reduce(
      (sum, l) => sum + (l.direction === LedgerDirection.CREDIT ? l.amount : -l.amount),
      0
    );
    expect(net).toBe(0);

    const promo = await LedgerEntry.find({ account: LedgerAccount.PROMOTION_EXPENSE });
    const promoNet = promo.reduce(
      (sum, l) => sum + (l.direction === LedgerDirection.DEBIT ? l.amount : -l.amount),
      0
    );
    expect(promoNet).toBe(0);

    expect(await ledgerService.isBalanced()).toBe(true);
  });

  it('no deja canjear más de lo que se tiene', async () => {
    const order = await deliveredOrder(50000);
    await loyaltyService.earnForOrder(order);

    await expect(
      loyaltyService.redeem(client._id.toString(), 5000)
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('respeta el mínimo de canje', async () => {
    await makePricingConfig({ loyaltyEarnBps: 200, loyaltyMinRedeem: 5000 });
    pricingConfigService.invalidate();

    const order = await deliveredOrder(50000);
    await loyaltyService.earnForOrder(order);

    await expect(
      loyaltyService.redeem(client._id.toString(), 500)
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('canjear dos veces no deja saldo negativo', async () => {
    const order = await deliveredOrder(50000);
    await loyaltyService.earnForOrder(order);

    await loyaltyService.redeem(client._id.toString(), 1000);
    await expect(
      loyaltyService.redeem(client._id.toString(), 1000)
    ).rejects.toMatchObject({ statusCode: 400 });

    expect(await loyaltyService.balanceOf(client._id.toString())).toBe(0);
  });

  it('dos canjes simultáneos no se llevan dos cupones con los mismos puntos', async () => {
    const order = await deliveredOrder(50000);
    await loyaltyService.earnForOrder(order);
    expect(await loyaltyService.balanceOf(client._id.toString())).toBe(1000);

    // La carrera de verdad: leer el saldo, decidir y escribir son tres
    // pasos, y entre ellos cabe el otro canje. Sin el débito atómico las
    // dos peticiones leerían 1000, las dos pasarían la comprobación y el
    // cliente se llevaría 2000 pesos en cupones habiendo ganado 1000.
    const results = await Promise.allSettled([
      loyaltyService.redeem(client._id.toString(), 1000),
      loyaltyService.redeem(client._id.toString(), 1000),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await loyaltyService.balanceOf(client._id.toString())).toBe(0);
    expect(await Coupon.countDocuments({ restrictedToUserId: client._id })).toBe(1);
  });

  it('el saldo materializado coincide con el libro de movimientos', async () => {
    const order = await deliveredOrder(50000);
    await loyaltyService.earnForOrder(order);
    await loyaltyService.redeem(client._id.toString(), 400);

    // El libro es la verdad; el saldo es un derivado que existe para poder
    // debitarlo de forma atómica. Si se separan, hay un error detrás.
    const stored = await loyaltyService.balanceOf(client._id.toString());
    const recomputed = await loyaltyService.recomputeBalance(client._id.toString());

    expect(stored).toBe(600);
    expect(recomputed).toBe(600);
  });

  // ── Reversión ──

  it('reembolsar un pedido le quita los puntos que dio', async () => {
    const order = await deliveredOrder(50000);
    await loyaltyService.earnForOrder(order);

    // Sin esto, el pedido se deshace y el premio se queda.
    expect(await loyaltyService.reverseForOrder(order)).toBe(1000);
    expect(await loyaltyService.balanceOf(client._id.toString())).toBe(0);
  });

  it('no revierte dos veces', async () => {
    const order = await deliveredOrder(50000);
    await loyaltyService.earnForOrder(order);

    await loyaltyService.reverseForOrder(order);
    expect(await loyaltyService.reverseForOrder(order)).toBe(0);
  });

  it('revertir deshace la provisión y el libro sigue cuadrado', async () => {
    const order = await deliveredOrder(50000);
    await loyaltyService.earnForOrder(order);
    await loyaltyService.reverseForOrder(order);

    expect(await payableNet()).toBe(0);
    expect(await ledgerService.isBalanced()).toBe(true);
  });

  it('dos reversas simultáneas no quitan dos veces los mismos puntos', async () => {
    await loyaltyService.grantPoints(client._id.toString(), 5000, 'Referido de prueba');
    const order = await deliveredOrder(50000);
    await loyaltyService.earnForOrder(order);

    // Un reembolso que se reintenta a la vez que el original. La lectura
    // previa que había antes la pasaban los dos.
    await Promise.allSettled([
      loyaltyService.reverseForOrder(order),
      loyaltyService.reverseForOrder(order),
    ]);

    expect(await loyaltyService.balanceOf(client._id.toString())).toBe(5000);
    expect(
      await LoyaltyMovement.countDocuments({ orderId: order._id, kind: LoyaltyMovementKind.REVERSED })
    ).toBe(1);
  });

  it('un reembolso total devuelve los puntos por su cuenta', async () => {
    setPaymentProvider(new SandboxPaymentProvider());
    const localProduct = await makeProduct(business._id, { price: 50000 });
    const placed = await orderService.create({
      clientId: client._id.toString(),
      businessId: business._id.toString(),
      items: [{ productId: localProduct._id.toString(), quantity: 1 }],
      paymentMethod: PaymentMethod.ONLINE,
      deliveryAddress: 'Cra 1 #2-3',
      deliveryLongitude: GARZON.lng,
      deliveryLatitude: GARZON.lat,
    });
    await paymentService.initiate({
      orderId: placed._id.toString(),
      userId: client._id.toString(),
      amount: placed.finance.customerTotal,
      description: 'Prueba',
      customer: { name: 'Cliente', phone: '3101234567' },
    });
    await Order.updateOne({ _id: placed._id }, { status: OrderStatus.DELIVERED, deliveredAt: new Date() });
    await loyaltyService.earnForOrder((await Order.findById(placed._id))!);
    expect(await loyaltyService.balanceOf(client._id.toString())).toBe(1000);

    // Antes nadie llamaba a `reverseForOrder`: el pedido se reembolsaba
    // entero y los puntos que había dado se quedaban.
    await refundService.issue({
      orderId: placed._id.toString(),
      reason: 'Pedido nunca llegó',
      kind: RefundKind.FULL,
    });

    expect(await loyaltyService.balanceOf(client._id.toString())).toBe(0);
  });

  // ── Caducidad ──

  const inDays = (days: number) => new Date(Date.now() + days * 24 * 60 * 60 * 1000);

  it('caduca lo que venció sin usarse y libera el pasivo', async () => {
    const order = await deliveredOrder(50000);
    await loyaltyService.earnForOrder(order);

    // La configuración de prueba deja la vigencia por defecto: 180 días.
    expect(await loyaltyService.expireDue(inDays(181))).toBe(1000);

    expect(await loyaltyService.balanceOf(client._id.toString())).toBe(0);
    expect(await payableNet()).toBe(0);
    expect(await ledgerService.isBalanced()).toBe(true);
  });

  it('lo que todavía no vence no se toca', async () => {
    const order = await deliveredOrder(50000);
    await loyaltyService.earnForOrder(order);

    expect(await loyaltyService.expireDue(inDays(30))).toBe(0);
    expect(await loyaltyService.balanceOf(client._id.toString())).toBe(1000);
  });

  it('de un lote a medio usar solo caduca el resto', async () => {
    const order = await deliveredOrder(50000);
    await loyaltyService.earnForOrder(order);
    await loyaltyService.redeem(client._id.toString(), 400);

    expect(await loyaltyService.expireDue(inDays(181))).toBe(600);
    expect(await loyaltyService.balanceOf(client._id.toString())).toBe(0);
  });

  it('el mismo lote no caduca dos veces', async () => {
    const order = await deliveredOrder(50000);
    await loyaltyService.earnForOrder(order);

    await loyaltyService.expireDue(inDays(181));
    expect(await loyaltyService.expireDue(inDays(200))).toBe(0);
  });

  it('lo consumido se imputa primero a lo que vence, no a los puntos que no caducan', async () => {
    await loyaltyService.grantPoints(client._id.toString(), 500, 'Referido de prueba');
    const order = await deliveredOrder(50000);
    await loyaltyService.earnForOrder(order);
    await loyaltyService.redeem(client._id.toString(), 1000);

    // Los 1000 canjeados salen del lote que caduca: el cliente conserva los
    // 500 de referido, que no vencen. Al revés, perdería puntos que ya
    // había "usado" según cualquier lectura razonable.
    expect(await loyaltyService.expireDue(inDays(181))).toBe(0);
    expect(await loyaltyService.balanceOf(client._id.toString())).toBe(500);
  });

  // ── Ajuste manual ──

  it('el ajuste manual suma y resta, con autor, y deja el libro cuadrado', async () => {
    const admin = await makeUser({ role: UserRole.ADMIN, isFinanceAdmin: true });

    await loyaltyService.adjust(client._id.toString(), 300, 'Pedido llegó tarde', admin._id.toString());
    const { balance } = await loyaltyService.adjust(
      client._id.toString(), -100, 'Corrección del ajuste anterior', admin._id.toString()
    );

    expect(balance).toBe(200);
    const adjustments = await LoyaltyMovement.find({ userId: client._id, kind: LoyaltyMovementKind.ADJUSTED });
    expect(adjustments.every((m) => m.createdBy?.toString() === admin._id.toString())).toBe(true);
    expect(await payableNet()).toBe(200);
    expect(await ledgerService.isBalanced()).toBe(true);
  });

  it('un ajuste no puede dejar el saldo en negativo', async () => {
    const admin = await makeUser({ role: UserRole.ADMIN, isFinanceAdmin: true });

    await expect(
      loyaltyService.adjust(client._id.toString(), -100, 'Quitar puntos', admin._id.toString())
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('un ajuste sin motivo no se acepta', async () => {
    const admin = await makeUser({ role: UserRole.ADMIN, isFinanceAdmin: true });

    await expect(
      loyaltyService.adjust(client._id.toString(), 100, '', admin._id.toString())
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  // ── Mis cupones ──

  it('el cupón de un canje se puede volver a encontrar, y solo su dueño lo ve', async () => {
    const order = await deliveredOrder(50000);
    await loyaltyService.earnForOrder(order);
    const { coupon } = await loyaltyService.redeem(client._id.toString(), 1000);

    // Antes el código solo aparecía en el aviso del canje: cerrarlo era
    // perder de vista un cupón que seguía vivo un mes.
    const mine = await couponService.getForUser(client._id.toString());
    expect(mine.map((c) => c.code)).toEqual([coupon.code]);

    const otro = await makeUser({ role: UserRole.CLIENT });
    expect(await couponService.getForUser(otro._id.toString())).toHaveLength(0);
  });

  it('el historial explica de dónde sale cada punto', async () => {
    const order = await deliveredOrder(50000);
    await loyaltyService.earnForOrder(order);
    await loyaltyService.redeem(client._id.toString(), 1000);

    const history = await loyaltyService.historyOf(client._id.toString());

    expect(history).toHaveLength(2);
    expect(history.map((m) => m.kind)).toContain(LoyaltyMovementKind.EARNED);
    expect(history.map((m) => m.kind)).toContain(LoyaltyMovementKind.REDEEMED);
    // Cuando un cliente pregunte por qué tiene X puntos, la respuesta tiene
    // que poder reconstruirse.
    expect(history.every((m) => m.description.length > 0)).toBe(true);
  });

  it('un movimiento de cero puntos no es un movimiento', async () => {
    await expect(
      LoyaltyMovement.create({
        userId: client._id,
        kind: LoyaltyMovementKind.ADJUSTED,
        points: 0,
        description: 'Nada',
      })
    ).rejects.toBeDefined();
  });
});
