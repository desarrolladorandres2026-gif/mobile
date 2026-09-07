import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'crypto';
import { orderService } from '../services/order.service';
import { orderSecurityService } from '../services/orderSecurity.service';
import { resolveOrderAccess } from '../services/orderAccess.service';
import { OrderSecurity } from '../security/orderSecurity';
import { decrypt } from '../security/encryption';
import { Order, Payout, Driver, OrderEvidence, LedgerEntry } from '../models';
import {
  PaymentMethod,
  PayoutBeneficiary,
  UserRole,
  OrderStatus,
  OrderCodeKind,
  OrderEvidenceType,
  LedgerAccount,
} from '../types';
import {
  GARZON,
  offsetKm,
  makeUser,
  makeBusiness,
  makeProduct,
  makeDriver,
  makePricingConfig,
  pickUpOrder,
} from './factories';

const DESTINATION = offsetKm(GARZON, 1);

/**
 * Tomar un pedido es una carrera, y hay que tratarla como tal.
 *
 * En la calle, dos domiciliarios ven el mismo pedido disponible en la
 * misma pantalla y pulsan "aceptar" con milisegundos de diferencia. No es
 * un caso raro: es el caso normal cuando hay más repartidores que pedidos.
 *
 * Lo que se prueba aquí no es que uno de los dos reciba un error bonito,
 * sino las tres consecuencias contables de que los dos ganen a la vez:
 *
 *  · el fondo del que pierde queda descontado por un pedido que nunca va a
 *    repartir, y nada se lo devuelve —`onCancelled` solo le devuelve el
 *    fondo a quien figure en `order.driverId`, que ya es el otro—;
 *  · el `Payout` del repartidor tiene índice único `(orderId, beneficiary)`,
 *    así que la fila la crea el primero y apunta a él para siempre: el
 *    pedido dice una cosa y la liquidación paga a otro;
 *  · dos personas se presentan en el mostrador a por el mismo pedido.
 */
describe('Asignación concurrente de domiciliario', () => {
  let client: any;
  let owner: any;
  let business: any;
  let product: any;

  beforeEach(async () => {
    await makePricingConfig({ cashOnDeliveryEnabled: true });
    client = await makeUser({ role: UserRole.CLIENT });
    owner = await makeUser({ role: UserRole.BUSINESS });
    business = await makeBusiness(owner._id);
    product = await makeProduct(business._id, { price: 20000 });
  });

  async function makeOrder(paymentMethod: PaymentMethod) {
    return orderService.create({
      clientId: client._id.toString(),
      businessId: business._id.toString(),
      items: [{ productId: product._id.toString(), quantity: 1 }],
      paymentMethod,
      deliveryAddress: 'Cra 1 #2-3',
      deliveryLongitude: DESTINATION.lng,
      deliveryLatitude: DESTINATION.lat,
    });
  }

  it('solo uno de los dos domiciliarios se queda el pedido', async () => {
    const order = await makeOrder(PaymentMethod.ONLINE);

    const [userA, userB] = await Promise.all([
      makeUser({ role: UserRole.DRIVER }),
      makeUser({ role: UserRole.DRIVER }),
    ]);
    const [driverA, driverB] = await Promise.all([
      makeDriver(userA._id),
      makeDriver(userB._id),
    ]);

    const results = await Promise.allSettled([
      orderService.assignDriver(order._id.toString(), driverA._id.toString()),
      orderService.assignDriver(order._id.toString(), driverB._id.toString()),
    ]);

    const ok = results.filter((r) => r.status === 'fulfilled');
    expect(ok).toHaveLength(1);

    const saved = await Order.findById(order._id);
    const winner = saved!.driverId!.toString();
    expect([driverA._id.toString(), driverB._id.toString()]).toContain(winner);

    // El payout del repartidor tiene que apuntar al que realmente lleva el
    // pedido. Es la comprobación que separa "dos avisos de más" de "le
    // pagamos al que no fue".
    const payout = await Payout.findOne({
      orderId: order._id,
      beneficiary: PayoutBeneficiary.DRIVER,
    });
    expect(payout!.driverId!.toString()).toBe(winner);
  });

  it('el fondo del domiciliario que pierde la carrera no se queda descontado', async () => {
    const order = await makeOrder(PaymentMethod.CASH_ON_DELIVERY);
    const reserved = order.finance.businessPayout;
    expect(reserved).toBeGreaterThan(0);

    const [userA, userB] = await Promise.all([
      makeUser({ role: UserRole.DRIVER }),
      makeUser({ role: UserRole.DRIVER }),
    ]);
    const [driverA, driverB] = await Promise.all([
      makeDriver(userA._id, { currentFund: 50000 }),
      makeDriver(userB._id, { currentFund: 50000 }),
    ]);

    await Promise.allSettled([
      orderService.assignDriver(order._id.toString(), driverA._id.toString()),
      orderService.assignDriver(order._id.toString(), driverB._id.toString()),
    ]);

    const saved = await Order.findById(order._id);
    const winner = saved!.driverId!.toString();

    const [freshA, freshB] = await Promise.all([
      Driver.findById(driverA._id),
      Driver.findById(driverB._id),
    ]);

    for (const driver of [freshA!, freshB!]) {
      const esGanador = driver._id.toString() === winner;
      expect(driver.currentFund).toBe(esGanador ? 50000 - reserved : 50000);
    }
  });

  it('un mismo domiciliario no puede reservar dos veces más fondo del que tiene', async () => {
    // Dos pedidos, un solo domiciliario con fondo para uno. Sin reserva
    // atómica los dos `findById` leen el mismo saldo, los dos pasan la
    // comprobación y el último `save()` deja el fondo como si solo se
    // hubiera cobrado un pedido: el repartidor sale a la calle debiendo
    // dinero que ZIPP cree que tiene.
    const [orderOne, orderTwo] = await Promise.all([
      makeOrder(PaymentMethod.CASH_ON_DELIVERY),
      makeOrder(PaymentMethod.CASH_ON_DELIVERY),
    ]);
    const reserved = orderOne.finance.businessPayout;

    const user = await makeUser({ role: UserRole.DRIVER });
    // Alcanza para uno y se queda a mitad de camino del segundo.
    const driver = await makeDriver(user._id, { currentFund: reserved + 1 });

    const results = await Promise.allSettled([
      orderService.assignDriver(orderOne._id.toString(), driver._id.toString()),
      orderService.assignDriver(orderTwo._id.toString(), driver._id.toString()),
    ]);

    const aceptados = results.filter((r) => r.status === 'fulfilled').length;
    expect(aceptados).toBe(1);

    const fresh = await Driver.findById(driver._id);
    expect(fresh!.currentFund).toBe(1);
    expect(fresh!.currentFund).toBeGreaterThanOrEqual(0);
  });

  /**
   * El doble toque en "entregar".
   *
   * Una red móvil mala y un botón que no se deshabilita bastan para que
   * salgan dos peticiones idénticas. Lo que estaba en juego no era un
   * registro duplicado: `onDelivered` suma a mano las estadísticas y el
   * fondo del domiciliario —leer, sumar, guardar—, así que dos pasadas le
   * abonaban dos veces el dinero que adelantó al comercio. Dinero que ZIPP
   * regala y que ningún asiento explica.
   */
  it('entregar dos veces a la vez no abona el fondo dos veces', async () => {
    const order = await makeOrder(PaymentMethod.CASH_ON_DELIVERY);
    const reserved = order.finance.businessPayout;

    const driverUser = await makeUser({ role: UserRole.DRIVER });
    const driver = await makeDriver(driverUser._id, { currentFund: 200000 });
    await orderService.assignDriver(order._id.toString(), driver._id.toString());

    const id = order._id.toString();

    // El comercio lo acepta, lo prepara y lo deja listo: el domiciliario no
    // puede recoger nada antes de eso.
    for (const estado of [OrderStatus.ACCEPTED, OrderStatus.PREPARING, OrderStatus.READY]) {
      await orderService.updateStatus(id, estado, owner._id.toString(), UserRole.BUSINESS);
    }

    await pickUpOrder(id, driverUser);
    await orderService.updateStatus(id, OrderStatus.ON_WAY, driverUser._id.toString(), UserRole.DRIVER);

    // Se consume el código de entrega, pero sin cambiar el estado: es
    // justo el instante en el que caben las dos peticiones.
    const access = await resolveOrderAccess(id, driverUser);
    await orderSecurityService.markArrival(access, OrderCodeKind.DELIVERY);
    await OrderEvidence.create({
      orderId: order._id,
      type: OrderEvidenceType.DELIVERY,
      storageKey: `test/${id}/delivery`,
      imageUrl: `https://evidencias.test/${id}-delivery.jpg`,
      isPrivate: true,
      uploadedBy: driverUser._id,
      uploadedByRole: UserRole.DRIVER,
      driverId: driver._id,
      businessId: order.businessId,
      customerId: order.clientId,
      orderStatus: OrderStatus.ON_WAY,
      metadata: { bytes: 1024, format: 'jpg', checksum: crypto.randomBytes(32).toString('hex') },
    });
    const security = await OrderSecurity.findOne({ orderId: id });
    await orderSecurityService.verify({
      access,
      kind: OrderCodeKind.DELIVERY,
      code: decrypt(security![OrderCodeKind.DELIVERY].secret),
    });

    const fundBefore = (await Driver.findById(driver._id))!.currentFund;

    const results = await Promise.allSettled([
      orderService.updateStatus(id, OrderStatus.DELIVERED, driverUser._id.toString(), UserRole.DRIVER),
      orderService.updateStatus(id, OrderStatus.DELIVERED, driverUser._id.toString(), UserRole.DRIVER),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);

    const fresh = await Driver.findById(driver._id);
    expect(fresh!.currentFund).toBe(fundBefore + reserved);
    expect(fresh!.totalDeliveries).toBe(1);
    expect(fresh!.totalEarnings).toBe(order.finance.driverPayout);

    // Y el libro mayor tampoco puede haber contado el efectivo dos veces.
    const asientos = await LedgerEntry.find({
      orderId: order._id,
      account: LedgerAccount.CASH_IN_TRANSIT,
    });
    expect(asientos).toHaveLength(1);
  });
});
