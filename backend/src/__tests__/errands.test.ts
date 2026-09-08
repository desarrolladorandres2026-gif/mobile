import { describe, it, expect, beforeEach } from 'vitest';
import { Order, Driver, Payout, LedgerEntry } from '../models';
import {
  OrderKind, OrderStatus, PaymentStatus, UserRole, LedgerAccount, LedgerDirection,
} from '../types';
import { errandService } from '../services/errand.service';
import { orderService } from '../services/order.service';
import { ledgerService } from '../services/ledger.service';
import { pricingConfigService } from '../services/pricingConfig.service';
import { makeUser, makeDriver, makePricingConfig, GARZON, offsetKm, runDelivery } from './factories';

/**
 * Mandados.
 *
 * Un pedido sin comercio de origen: recoger algo de un sitio cualquiera y
 * llevarlo a otro. Reutiliza todo lo caro que ya existía —reparto en
 * cascada, seguimiento, códigos, evidencia— y solo añade lo que de verdad
 * es distinto: qué comprar, dónde y cuánto se puede gastar.
 *
 * El domiciliario adelanta la compra de su fondo, así que la mitad de estas
 * pruebas cubre el dinero: que se reserve el tope y no el estimado, que el
 * techo de exposición aplique, y que nadie pueda gastar por encima de lo
 * que el cliente autorizó.
 */
describe('Mandados', () => {
  let client: any;
  let driverUser: any;
  let driver: any;

  const pickup = offsetKm(GARZON, 1);

  const createErrand = (overrides: Record<string, unknown> = {}) =>
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
      ...overrides,
    } as never);

  beforeEach(async () => {
    await makePricingConfig({ maxDriverCashDebt: 200000 });
    pricingConfigService.invalidate();

    client = await makeUser({ role: UserRole.CLIENT });
    driverUser = await makeUser({ role: UserRole.DRIVER });
    driver = await makeDriver(driverUser._id, { isApproved: true, isActive: true });
    await Driver.updateOne({ _id: driver._id }, { baseFund: 150000, currentFund: 150000 });
  });

  it('crea un pedido sin comercio detrás', async () => {
    const order = await createErrand();

    expect(order.kind).toBe(OrderKind.ERRAND);
    expect(order.businessId).toBeUndefined();
    expect(order.errand!.description).toContain('mercado');
  });

  it('cobra tarifa de viaje, calculada como cualquier domicilio', async () => {
    const order = await createErrand();

    // El trabajo del domiciliario es recorrer una distancia: que en un
    // extremo haya un restaurante afiliado o una tienda cualquiera no
    // cambia el esfuerzo ni el combustible.
    expect(order.deliveryFee).toBeGreaterThan(0);
    expect(order.driverPayout).toBeGreaterThan(0);
  });

  it('no cobra comisión de venta: ZIPP no vendió nada', async () => {
    const order = await createErrand();

    expect(order.platformCommission).toBe(0);
    expect(order.businessPayout).toBe(0);
  });

  it('el total inicial es el estimado más el viaje', async () => {
    const order = await createErrand({ estimatedCost: 40000 });
    expect(order.total).toBe(40000 + order.deliveryFee);
  });

  it('rechaza un tope menor que el estimado', async () => {
    await expect(
      createErrand({ estimatedCost: 50000, maxCost: 30000 })
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  // ── El dinero del domiciliario ──

  it('al aceptarlo se le retiene el TOPE, no el estimado', async () => {
    const order = await createErrand({ estimatedCost: 40000, maxCost: 50000 });
    await Order.updateOne({ _id: order._id }, { status: OrderStatus.READY, paymentStatus: PaymentStatus.PAID });

    const before = await Driver.findById(driver._id);
    await orderService.assignDriver(order._id.toString(), driver._id.toString());
    const after = await Driver.findById(driver._id);

    // Si el mercado sale más caro de lo previsto, tiene que poder pagarlo
    // sin quedarse a medias en la caja.
    expect(before!.currentFund - after!.currentFund).toBe(50000);
  });

  it('nace listo: no hay cocina que lo acepte ni que lo prepare', async () => {
    const order = await createErrand();
    expect(order.status).toBe(OrderStatus.READY);
  });

  it('nadie sale a poner su dinero por un mandado sin pagar', async () => {
    const order = await createErrand({ maxCost: 50000 });

    // Es la puerta equivalente a la del comercio que no cocina hasta que la
    // pasarela confirma, salvo que aquí quien arriesga es una persona.
    await expect(
      orderService.assignDriver(order._id.toString(), driver._id.toString())
    ).rejects.toMatchObject({ statusCode: 409 });

    const after = await Driver.findById(driver._id);
    expect(after!.currentFund).toBe(150000);
  });

  it('un mandado sin pagar no aparece en la lista de disponibles', async () => {
    await createErrand();

    // Listarlo solo serviría para que alguien lo tomara y se llevara un
    // 409 que no puede arreglar. Un callejón silencioso.
    const { orders } = await orderService.getAvailableOrders();
    expect(orders).toHaveLength(0);
  });

  it('en cuanto se paga, sí aparece', async () => {
    const order = await createErrand();
    await Order.updateOne({ _id: order._id }, { paymentStatus: PaymentStatus.PAID });

    const { orders } = await orderService.getAvailableOrders();
    expect(orders).toHaveLength(1);
  });

  it('sin fondo suficiente no puede tomarlo', async () => {
    await Driver.updateOne({ _id: driver._id }, { currentFund: 10000 });

    const order = await createErrand({ maxCost: 50000 });
    await Order.updateOne({ _id: order._id }, { status: OrderStatus.READY, paymentStatus: PaymentStatus.PAID });

    await expect(
      orderService.assignDriver(order._id.toString(), driver._id.toString())
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('respeta el techo de dinero comprometido', async () => {
    await makePricingConfig({ maxDriverCashDebt: 30000 });
    pricingConfigService.invalidate();

    const order = await createErrand({ estimatedCost: 40000, maxCost: 50000 });
    await Order.updateOne({ _id: order._id }, { status: OrderStatus.READY, paymentStatus: PaymentStatus.PAID });

    // Un mandado grande es exactamente el mismo riesgo que un pedido en
    // efectivo grande.
    await expect(
      orderService.assignDriver(order._id.toString(), driver._id.toString())
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('si pierde la carrera por el pedido, se le devuelve lo retenido', async () => {
    const order = await createErrand({ maxCost: 50000 });
    await Order.updateOne({ _id: order._id }, { status: OrderStatus.READY, paymentStatus: PaymentStatus.PAID });

    const otroUser = await makeUser({ role: UserRole.DRIVER });
    const otro = await makeDriver(otroUser._id, { isApproved: true, isActive: true });
    await Driver.updateOne({ _id: otro._id }, { baseFund: 150000, currentFund: 150000 });

    const beforeA = await Driver.findById(driver._id);
    const beforeB = await Driver.findById(otro._id);

    // La carrera de verdad es simultánea: en secuencia salta la
    // comprobación temprana y el segundo ni siquiera llega a reservar.
    // Aquí los dos retienen fondo y solo uno se queda el mandado.
    const results = await Promise.allSettled([
      orderService.assignDriver(order._id.toString(), driver._id.toString()),
      orderService.assignDriver(order._id.toString(), otro._id.toString()),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);

    const saved = await Order.findById(order._id);
    const winnerId = saved!.driverId!.toString();

    // Al que perdió se le devuelve todo: es dinero de una persona,
    // retenido por un mandado que se lleva otra.
    const loserId = winnerId === driver._id.toString() ? otro._id : driver._id;
    const loserBefore = winnerId === driver._id.toString() ? beforeB : beforeA;
    const loserAfter = await Driver.findById(loserId);

    expect(loserAfter!.currentFund).toBe(loserBefore!.currentFund);
  });

  // ── Declarar el gasto ──

  it('el domiciliario declara lo que gastó y el total se ajusta', async () => {
    const order = await createErrand({ estimatedCost: 40000, maxCost: 50000 });
    await Order.updateOne({ _id: order._id }, { status: OrderStatus.READY, paymentStatus: PaymentStatus.PAID });
    await orderService.assignDriver(order._id.toString(), driver._id.toString());

    const updated = await errandService.declareCost(
      order._id.toString(),
      driverUser._id.toString(),
      38500,
      'https://cdn.example.com/recibo.jpg'
    );

    // El cliente paga lo que costó más el viaje, ni un peso más.
    expect(updated.errand!.actualCost).toBe(38500);
    expect(updated.total).toBe(38500 + order.deliveryFee);
  });

  it('no deja gastar por encima de lo autorizado', async () => {
    const order = await createErrand({ estimatedCost: 40000, maxCost: 50000 });
    await Order.updateOne({ _id: order._id }, { status: OrderStatus.READY, paymentStatus: PaymentStatus.PAID });
    await orderService.assignDriver(order._id.toString(), driver._id.toString());

    // El cliente autorizó una cifra y nadie puede subirla por él desde la
    // calle.
    await expect(
      errandService.declareCost(
        order._id.toString(),
        driverUser._id.toString(),
        60000,
        'https://cdn.example.com/recibo.jpg'
      )
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it('otro domiciliario no puede declarar el gasto de un mandado ajeno', async () => {
    const order = await createErrand();
    await Order.updateOne({ _id: order._id }, { status: OrderStatus.READY, paymentStatus: PaymentStatus.PAID });
    await orderService.assignDriver(order._id.toString(), driver._id.toString());

    const intrusoUser = await makeUser({ role: UserRole.DRIVER });
    await makeDriver(intrusoUser._id);

    await expect(
      errandService.declareCost(
        order._id.toString(),
        intrusoUser._id.toString(),
        30000,
        'https://cdn.example.com/recibo.jpg'
      )
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('gastar exactamente el tope se acepta', async () => {
    const order = await createErrand({ estimatedCost: 40000, maxCost: 50000 });
    await Order.updateOne({ _id: order._id }, { status: OrderStatus.READY, paymentStatus: PaymentStatus.PAID });
    await orderService.assignDriver(order._id.toString(), driver._id.toString());

    const updated = await errandService.declareCost(
      order._id.toString(),
      driverUser._id.toString(),
      50000,
      'https://cdn.example.com/recibo.jpg'
    );

    expect(updated.errand!.actualCost).toBe(50000);
  });

  it('un pedido normal no se puede declarar como mandado', async () => {
    await expect(
      errandService.declareCost(
        '507f1f77bcf86cd799439011',
        driverUser._id.toString(),
        1000,
        'https://cdn.example.com/recibo.jpg'
      )
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('sin recibo no se puede marcar recogido', async () => {
    const order = await createErrand();
    await Order.updateOne({ _id: order._id }, { status: OrderStatus.READY, paymentStatus: PaymentStatus.PAID });
    await orderService.assignDriver(order._id.toString(), driver._id.toString());

    // El código de recogida lo dicta el comercio, y aquí no hay comercio:
    // ese código no lo tiene nadie. El recibo hace su trabajo y además
    // demuestra qué se compró y por cuánto.
    await expect(
      orderService.updateStatus(
        order._id.toString(),
        OrderStatus.PICKED_UP,
        driverUser._id.toString(),
        UserRole.DRIVER
      )
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  // ── El libro mayor ──

  /** Saldo neto de una cuenta para un pedido concreto: débitos − créditos. */
  const balanceOf = async (orderId: any, account: LedgerAccount) => {
    const entries = await LedgerEntry.find({ orderId, account });
    return entries.reduce(
      (sum, e) => sum + (e.direction === LedgerDirection.DEBIT ? e.amount : -e.amount),
      0
    );
  };

  it('reconocer el mandado deja el libro cuadrado', async () => {
    const order = await createErrand();

    // No se comprueba la fórmula, se comprueba el invariante: si el asiento
    // no cuadrara, `post` habría lanzado antes de llegar aquí.
    expect(await ledgerService.isBalanced({ orderId: order._id })).toBe(true);
  });

  it('la compra nace como un pasivo con nombre propio', async () => {
    const order = await createErrand({ estimatedCost: 40000 });

    // El dinero del mercado no es ingreso de ZIPP ni es de ningún comercio:
    // es una deuda con quien acabe poniéndolo. Mezclarlo con las tarifas de
    // reparto escondería la única cifra que dice cuánta exposición tiene
    // el producto de mandados en la calle.
    expect(await balanceOf(order._id, LedgerAccount.ERRAND_ADVANCE_PAYABLE)).toBe(-40000);
  });

  it('declarar un gasto menor baja el pasivo y lo que debe el cliente', async () => {
    const order = await createErrand({ estimatedCost: 40000, maxCost: 50000 });
    await Order.updateOne({ _id: order._id }, { status: OrderStatus.READY, paymentStatus: PaymentStatus.PAID });
    await orderService.assignDriver(order._id.toString(), driver._id.toString());

    await errandService.declareCost(
      order._id.toString(),
      driverUser._id.toString(),
      38500,
      'https://cdn.example.com/recibo.jpg'
    );

    expect(await balanceOf(order._id, LedgerAccount.ERRAND_ADVANCE_PAYABLE)).toBe(-38500);
    expect(await ledgerService.isBalanced({ orderId: order._id })).toBe(true);
  });

  it('declarar dos veces la misma cifra no mueve nada', async () => {
    const order = await createErrand({ estimatedCost: 40000, maxCost: 50000 });
    await Order.updateOne({ _id: order._id }, { status: OrderStatus.READY, paymentStatus: PaymentStatus.PAID });
    await orderService.assignDriver(order._id.toString(), driver._id.toString());

    const declare = () =>
      errandService.declareCost(
        order._id.toString(),
        driverUser._id.toString(),
        38500,
        'https://cdn.example.com/recibo.jpg'
      );

    await declare();
    await declare();

    // Un reintento por mala cobertura no puede cobrarle el mercado dos
    // veces al cliente.
    expect(await balanceOf(order._id, LedgerAccount.ERRAND_ADVANCE_PAYABLE)).toBe(-38500);
  });

  it('un mandado no crea un pago al comercio que no existe', async () => {
    const order = await createErrand();
    await Order.updateOne({ _id: order._id }, { status: OrderStatus.READY, paymentStatus: PaymentStatus.PAID });
    await orderService.assignDriver(order._id.toString(), driver._id.toString());

    const payouts = await Payout.find({ orderId: order._id });
    expect(payouts).toHaveLength(1);
    expect(payouts[0].beneficiary).toBe('driver');
  });

  // ── Entregar y cobrar ──

  it('al entregar se le repone al domiciliario todo lo que retuvo', async () => {
    const order = await createErrand({ estimatedCost: 40000, maxCost: 50000 });
    await Order.updateOne({ _id: order._id }, { status: OrderStatus.READY, paymentStatus: PaymentStatus.PAID });

    const before = await Driver.findById(driver._id);
    await orderService.assignDriver(order._id.toString(), driver._id.toString());
    await errandService.declareCost(
      order._id.toString(),
      driverUser._id.toString(),
      38500,
      'https://cdn.example.com/recibo.jpg'
    );
    await runDelivery(order._id.toString(), driverUser);

    // Lo que no gastó nunca salió de su bolsillo y lo que gastó se le
    // devuelve ahora: el fondo vuelve exactamente a donde estaba. Hacerle
    // esperar a la liquidación del viernes por un dinero que ZIPP ya cobró
    // es la forma más rápida de que deje de aceptar mandados.
    const after = await Driver.findById(driver._id);
    expect(after!.currentFund).toBe(before!.currentFund);
  });

  it('lo que gana por el viaje no se confunde con lo que se le devuelve', async () => {
    const order = await createErrand({ estimatedCost: 40000, maxCost: 50000 });
    await Order.updateOne({ _id: order._id }, { status: OrderStatus.READY, paymentStatus: PaymentStatus.PAID });
    await orderService.assignDriver(order._id.toString(), driver._id.toString());
    await errandService.declareCost(
      order._id.toString(),
      driverUser._id.toString(),
      38500,
      'https://cdn.example.com/recibo.jpg'
    );
    await runDelivery(order._id.toString(), driverUser);

    // Un mandado de $38.500 no son unas ganancias de $38.500.
    const after = await Driver.findById(driver._id);
    expect(after!.totalEarnings).toBe(order.driverPayout);
  });

  it('entregar extingue el pasivo de la compra', async () => {
    const order = await createErrand({ estimatedCost: 40000, maxCost: 50000 });
    await Order.updateOne({ _id: order._id }, { status: OrderStatus.READY, paymentStatus: PaymentStatus.PAID });
    await orderService.assignDriver(order._id.toString(), driver._id.toString());
    await errandService.declareCost(
      order._id.toString(),
      driverUser._id.toString(),
      38500,
      'https://cdn.example.com/recibo.jpg'
    );
    await runDelivery(order._id.toString(), driverUser);

    // Si esto no llegara a cero, el balance diría para siempre que ZIPP
    // debe un mercado que ya pagó.
    expect(await balanceOf(order._id, LedgerAccount.ERRAND_ADVANCE_PAYABLE)).toBe(0);
    expect(await ledgerService.isBalanced({ orderId: order._id })).toBe(true);
  });

  it('si soporte lo cierra sin recibo, se liquida por el estimado', async () => {
    const admin = await makeUser({ role: UserRole.ADMIN });

    const order = await createErrand({ estimatedCost: 40000, maxCost: 50000 });
    await Order.updateOne({ _id: order._id }, { status: OrderStatus.READY, paymentStatus: PaymentStatus.PAID });
    await orderService.assignDriver(order._id.toString(), driver._id.toString());

    // Por el camino normal esto no puede pasar: sin recibo no se marca
    // recogido. Pero soporte sí puede forzar el cierre —para eso está— y
    // entonces alguien tiene que decidir por cuánto se liquida. Dejar el
    // pasivo abierto sería un descuadre permanente que nadie sabría de
    // dónde salió tres meses después.
    for (const status of [OrderStatus.PICKED_UP, OrderStatus.ON_WAY, OrderStatus.DELIVERED]) {
      await orderService.updateStatus(
        order._id.toString(),
        status,
        admin._id.toString(),
        UserRole.ADMIN
      );
    }

    expect(await balanceOf(order._id, LedgerAccount.ERRAND_ADVANCE_PAYABLE)).toBe(0);
  });

  // ── Cancelar ──

  it('cancelar antes de comprar devuelve el fondo entero', async () => {
    const order = await createErrand({ maxCost: 50000 });
    await Order.updateOne({ _id: order._id }, { status: OrderStatus.READY, paymentStatus: PaymentStatus.PAID });

    const before = await Driver.findById(driver._id);
    await orderService.assignDriver(order._id.toString(), driver._id.toString());
    await orderService.updateStatus(
      order._id.toString(),
      OrderStatus.CANCELLED,
      client._id.toString(),
      UserRole.CLIENT,
      'Ya no lo necesito'
    );

    const after = await Driver.findById(driver._id);
    expect(after!.currentFund).toBe(before!.currentFund);
    expect(await ledgerService.isBalanced({ orderId: order._id })).toBe(true);
    expect(await balanceOf(order._id, LedgerAccount.ERRAND_ADVANCE_PAYABLE)).toBe(0);
  });

  it('un mandado ya comprado no se puede cancelar', async () => {
    const order = await createErrand({ estimatedCost: 40000, maxCost: 50000 });
    await Order.updateOne({ _id: order._id }, { status: OrderStatus.READY, paymentStatus: PaymentStatus.PAID });
    await orderService.assignDriver(order._id.toString(), driver._id.toString());
    await errandService.declareCost(
      order._id.toString(),
      driverUser._id.toString(),
      38500,
      'https://cdn.example.com/recibo.jpg'
    );

    // Cancelar significa "esto no ha pasado", y el mercado ya está pagado
    // con dinero del domiciliario y va en la moto. Devolverle el fondo le
    // dejaría unas compras encima; no devolvérselo, un agujero. Esto es un
    // reembolso, que sí sabe repartir el coste.
    await expect(
      orderService.updateStatus(
        order._id.toString(),
        OrderStatus.CANCELLED,
        client._id.toString(),
        UserRole.CLIENT,
        'Me arrepentí'
      )
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('tampoco lo cancela un administrador', async () => {
    const admin = await makeUser({ role: UserRole.ADMIN });

    const order = await createErrand({ estimatedCost: 40000, maxCost: 50000 });
    await Order.updateOne({ _id: order._id }, { status: OrderStatus.READY, paymentStatus: PaymentStatus.PAID });
    await orderService.assignDriver(order._id.toString(), driver._id.toString());
    await errandService.declareCost(
      order._id.toString(),
      driverUser._id.toString(),
      38500,
      'https://cdn.example.com/recibo.jpg'
    );

    // La excepción de soporte aquí no ahorra trabajo: lo esconde.
    await expect(
      orderService.updateStatus(
        order._id.toString(),
        OrderStatus.CANCELLED,
        admin._id.toString(),
        UserRole.ADMIN,
        'Soporte'
      )
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('un pedido normal sigue exigiendo comercio', async () => {
    // La validación condicional del esquema es lo único que impide que un
    // pedido de catálogo exista sin negocio detrás.
    await expect(
      Order.create({
        clientId: client._id,
        items: [],
        paymentMethod: 'online',
        deliveryAddress: 'x',
        deliveryLocation: { type: 'Point', coordinates: [GARZON.lng, GARZON.lat] },
        subtotal: 0,
        deliveryFee: 0,
        discount: 0,
        tip: 0,
        tax: 0,
        platformCommission: 0,
        businessPayout: 0,
        driverPayout: 0,
        total: 0,
      })
    ).rejects.toBeDefined();
  });
});
