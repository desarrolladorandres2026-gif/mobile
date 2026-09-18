import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../app';
import {
  Order,
  Commission,
  CashReconciliation,
  Driver,
  CouponRedemption,
  Payout,
} from '../models';
import {
  CouponType,
  CouponFundedBy,
  OrderStatus,
  UserRole,
  PaymentStatus,
  PayoutStatus,
  CashReconciliationStatus,
} from '../types';
import {
  GARZON, offsetKm, makeUser, makeBusiness, makeProduct, makeDriver, makeCoupon,
  makePricingConfig, authHeader,
  pickUpOrder,
  deliverToCustomer,
} from './factories';
import { ledgerService } from '../services/ledger.service';
import { paymentService, setPaymentProvider, SandboxPaymentProvider } from '../services/payments';

/**
 * Cinco pedidos completos, de punta a punta, contra la API real.
 *
 * No prueban una función suelta sino el modelo de negocio entero: que el
 * total cotizado sea exactamente el cobrado, que la comisión salga de la base
 * correcta, que el repartidor cobre su tarifa garantizada pase lo que pase, y
 * que un pedido cancelado no mueva un peso.
 *
 * Cada uno recorre la máquina de estados con el rol que corresponde: el
 * negocio acepta y prepara, el repartidor recoge y entrega. Si un rol
 * pudiera saltarse un paso, estas pruebas lo verían.
 *
 * Además, después de cada pedido el libro mayor tiene que cuadrar. Esa es la
 * red de seguridad: cualquier peso que se pierda o se duplique aparece ahí
 * antes que en una conciliación bancaria.
 */

const DESTINO = offsetKm(GARZON, 2);
const COMISION_BPS = 1000; // 10%

/** Con radio incluido de 1 km y 900/km, 2 km salen a 4.000 + 900. */
const TARIFA_REPARTIDOR = 4900;

async function montarEscenario(opciones: {
  precioProducto?: number;
  fondoDomiciliario?: number;
  config?: Record<string, unknown>;
} = {}) {
  await makePricingConfig({
    driverBaseFee: 4000,
    driverPerKm: 900,
    driverMinFee: 3000,
    freeRadiusMeters: 1000,
    ...opciones.config,
  });

  const cliente = await makeUser({ role: UserRole.CLIENT });
  const dueno = await makeUser({ role: UserRole.BUSINESS });
  const negocio = await makeBusiness(dueno._id, { commissionRateBps: COMISION_BPS });
  const producto = await makeProduct(negocio._id, { price: opciones.precioProducto ?? 20000 });

  const usuarioDomiciliario = await makeUser({ role: UserRole.DRIVER });
  const domiciliario = await makeDriver(usuarioDomiciliario._id, {
    currentFund: opciones.fondoDomiciliario ?? 50000,
  });

  return { cliente, dueno, negocio, producto, usuarioDomiciliario, domiciliario };
}

function cuerpoPedido(negocio: any, producto: any, extra: Record<string, unknown> = {}) {
  return {
    businessId: negocio._id.toString(),
    items: [{ productId: producto._id.toString(), quantity: 2 }],
    paymentMethod: 'online',
    deliveryAddress: 'Calle 5 # 3-21, Garzón',
    deliveryDetails: 'Portón negro',
    deliveryLatitude: DESTINO.lat,
    deliveryLongitude: DESTINO.lng,
    ...extra,
  };
}

/** Pide la cotización y crea el pedido con exactamente el mismo cuerpo. */
async function cotizarYCrear(cliente: any, cuerpo: Record<string, unknown>) {
  const cotizacion = await request(app)
    .post('/api/v1/orders/quote')
    .set(await authHeader(cliente))
    .send(cuerpo)
    .expect(200);

  const creado = await request(app)
    .post('/api/v1/orders')
    .set(await authHeader(cliente))
    .send({ ...cuerpo, idempotencyKey: `test-${Date.now()}-${Math.random()}` })
    .expect(201);

  return { cotizacion: cotizacion.body.data, pedido: creado.body.data };
}

/**
 * Cobra el pedido por la pasarela.
 *
 * Sin este paso el pedido nunca queda PAID: entregarlo ya no lo marca
 * cobrado, y ese es justamente el agujero que este rediseño cierra.
 */
async function cobrarEnLinea(pedidoId: string, cliente: any) {
  setPaymentProvider(new SandboxPaymentProvider());
  const pedido = await Order.findById(pedidoId);
  await paymentService.initiate({
    orderId: pedidoId,
    userId: cliente._id.toString(),
    amount: pedido!.finance.customerTotal,
    description: `Pedido ${pedido!.orderNumber}`,
    customer: { name: cliente.name, phone: cliente.phone },
  });
}

const cambiarEstado = async (pedidoId: string, actor: any, status: string, extra = {}) =>
  request(app)
    .patch(`/api/v1/orders/${pedidoId}/status`)
    .set(await authHeader(actor))
    .send({ status, ...extra });

/** El negocio lleva el pedido hasta "listo para recoger". */
async function prepararEnLocal(pedidoId: string, dueno: any) {
  expect((await cambiarEstado(pedidoId, dueno, OrderStatus.ACCEPTED)).status).toBe(200);
  expect((await cambiarEstado(pedidoId, dueno, OrderStatus.PREPARING)).status).toBe(200);
  expect((await cambiarEstado(pedidoId, dueno, OrderStatus.READY)).status).toBe(200);
}

/** El repartidor lo toma y lo entrega. */
async function recogerYEntregar(pedidoId: string, usuarioDomiciliario: any, domiciliario: any) {
  await request(app)
    .patch(`/api/v1/orders/${pedidoId}/assign-driver`)
    .set(await authHeader(usuarioDomiciliario))
    .send({ driverId: domiciliario._id.toString() })
    .expect(200);

  // Recoger y entregar pasan por evidencia + código; el resto del camino
  // sigue yendo por la API tal cual.
  await pickUpOrder(pedidoId, usuarioDomiciliario);
  expect((await cambiarEstado(pedidoId, usuarioDomiciliario, OrderStatus.ON_WAY)).status).toBe(200);
  await deliverToCustomer(pedidoId, usuarioDomiciliario);
}

describe('Modelo de negocio · 5 pedidos de punta a punta', () => {

  // ────────────────────────────────────────────────────────────
  it('Pedido 1 · digital: la plataforma cobra comisión y fee, y liquida al confirmar la pasarela', async () => {
    const { cliente, dueno, negocio, producto, usuarioDomiciliario, domiciliario } =
      await montarEscenario({ config: { serviceFeeFixed: 1500, deliveryMarginFixed: 600 } });

    const { cotizacion, pedido } = await cotizarYCrear(
      cliente,
      cuerpoPedido(negocio, producto, { tip: 4000 })
    );

    // Lo cotizado es lo cobrado. Es la propiedad que sostiene todo lo demás.
    expect(pedido.total).toBe(cotizacion.total);
    expect(cotizacion.subtotal).toBe(40000);
    expect(cotizacion.tip).toBe(4000);
    expect(cotizacion.customerServiceFee).toBe(1500);
    expect(cotizacion.total).toBe(
      cotizacion.subtotal +
        cotizacion.deliveryFee +
        cotizacion.customerServiceFee +
        cotizacion.tax +
        cotizacion.tip -
        cotizacion.discount
    );

    // El cliente paga 4.900 + 600 de margen; al repartidor le corresponden
    // los 4.900, y los 600 son de ZIPP.
    expect(cotizacion.driverDeliveryPayout).toBe(TARIFA_REPARTIDOR);
    expect(cotizacion.deliveryFee).toBe(TARIFA_REPARTIDOR + 600);
    expect(cotizacion.deliveryMargin).toBe(600);

    // Recién creado no hay nada pagadero: se devengó, pero nadie ha pagado.
    const antesDeCobrar = await Payout.find({ orderId: pedido._id });
    expect(antesDeCobrar.every((p) => p.status === PayoutStatus.ACCRUED)).toBe(true);

    // El cobro va primero. Un pedido en línea sin confirmar ya no puede
    // siquiera aceptarse en el local, así que nadie cocina sin dinero
    // confirmado — ese es el orden que impone OrderService.updateStatus.
    await cobrarEnLinea(pedido._id, cliente);

    await prepararEnLocal(pedido._id, dueno);
    await recogerYEntregar(pedido._id, usuarioDomiciliario, domiciliario);

    const entregado = await Order.findById(pedido._id);
    expect(entregado!.status).toBe(OrderStatus.DELIVERED);

    const cobrado = await Order.findById(pedido._id);
    expect(cobrado!.paymentStatus).toBe(PaymentStatus.PAID);

    // Comisión del 10% sobre 40.000; el negocio recibe el resto.
    expect(cobrado!.finance.merchantCommission).toBe(4000);
    expect(cobrado!.finance.businessPayout).toBe(36000);
    // El repartidor: tarifa garantizada + propina íntegra.
    expect(cobrado!.finance.driverPayout).toBe(TARIFA_REPARTIDOR + 4000);
    // ZIPP: comisión + fee de servicio + margen de domicilio.
    expect(cobrado!.finance.platformGrossRevenue).toBe(4000 + 1500 + 600);

    const comision = await Commission.findOne({ orderId: pedido._id });
    expect(comision!.platformAmount).toBe(6100);
    expect(comision!.businessAmount).toBe(36000);

    // En digital el repartidor nunca toca efectivo: ni adelanta ni debe.
    expect(await CashReconciliation.countDocuments({ orderId: pedido._id })).toBe(0);

    const tras = await Driver.findById(domiciliario._id);
    expect(tras!.currentFund).toBe(50000);
    expect(tras!.totalDeliveries).toBe(1);
    expect(tras!.totalEarnings).toBe(cobrado!.finance.driverPayout);

    // Confirmado el cobro, lo que ZIPP debe pasa a ser pagadero.
    const despues = await Payout.find({ orderId: pedido._id });
    expect(despues.every((p) => p.status === PayoutStatus.PAYABLE)).toBe(true);

    expect(await ledgerService.isBalanced({ orderId: pedido._id })).toBe(true);
  });

  // ────────────────────────────────────────────────────────────
  it('Pedido 2 · contra entrega: el repartidor adelanta solo lo del negocio y rinde la parte de ZIPP', async () => {
    const { cliente, dueno, negocio, producto, usuarioDomiciliario, domiciliario } =
      await montarEscenario({
        precioProducto: 15000,
        config: { cashOnDeliveryEnabled: true, cashOnDeliveryMaxAmount: 200000 },
      });

    const { cotizacion, pedido } = await cotizarYCrear(
      cliente,
      cuerpoPedido(negocio, producto, {
        paymentMethod: 'cash_on_delivery',
        cashPayment: { needsChange: false },
      })
    );

    expect(cotizacion.subtotal).toBe(30000);
    expect(pedido.total).toBe(cotizacion.total);

    await prepararEnLocal(pedido._id, dueno);

    await request(app)
      .patch(`/api/v1/orders/${pedido._id}/assign-driver`)
      .set(await authHeader(usuarioDomiciliario))
      .send({ driverId: domiciliario._id.toString() })
      .expect(200);

    // Adelanta 27.000: lo que se le debe al negocio. Antes se le descontaba el
    // subtotal completo, o sea que financiaba también la comisión de ZIPP.
    const conPedidoTomado = await Driver.findById(domiciliario._id);
    expect(conPedidoTomado!.currentFund).toBe(50000 - 27000);

    await pickUpOrder(pedido._id, usuarioDomiciliario);
    expect((await cambiarEstado(pedido._id, usuarioDomiciliario, OrderStatus.ON_WAY)).status).toBe(200);
    await deliverToCustomer(pedido._id, usuarioDomiciliario);

    const entregado = await Order.findById(pedido._id);

    expect(entregado!.finance.merchantCommission).toBe(3000);
    expect(entregado!.finance.businessPayout).toBe(27000);
    // La tarifa del repartidor no se toca por ser efectivo.
    expect(entregado!.finance.driverPayout).toBe(TARIFA_REPARTIDOR);

    // Lo que debe rendir es solo la parte de ZIPP, no su propia tarifa.
    const conciliacion = await CashReconciliation.findOne({ orderId: pedido._id });
    expect(conciliacion!.amount).toBe(3000);
    expect(conciliacion!.status).toBe(CashReconciliationStatus.PENDING);

    // Al cobrarle al cliente recupera lo que había adelantado.
    const alCerrar = await Driver.findById(domiciliario._id);
    expect(alCerrar!.currentFund).toBe(50000);
    expect(alCerrar!.totalEarnings).toBe(entregado!.finance.driverPayout);

    expect(await ledgerService.isBalanced({ orderId: pedido._id })).toBe(true);
  });

  // ────────────────────────────────────────────────────────────
  it('Pedido 3 · cupón del negocio: el descuento lo asume el negocio, no la plataforma', async () => {
    const { cliente, dueno, negocio, producto, usuarioDomiciliario, domiciliario } =
      await montarEscenario();

    // Financiado explícitamente por el negocio, no inferido de su businessId.
    await makeCoupon({
      code: 'SOLOAQUI',
      type: CouponType.PERCENTAGE,
      value: 25,
      businessId: negocio._id,
      fundedBy: CouponFundedBy.BUSINESS,
    });

    const { cotizacion, pedido } = await cotizarYCrear(
      cliente,
      cuerpoPedido(negocio, producto, { couponCode: 'SOLOAQUI' })
    );

    expect(cotizacion.subtotal).toBe(40000);
    expect(cotizacion.coupon.productDiscount).toBe(10000);
    expect(cotizacion.merchantFundedDiscount).toBe(10000);
    expect(cotizacion.platformFundedDiscount).toBe(0);
    expect(pedido.total).toBe(cotizacion.total);

    await cobrarEnLinea(pedido._id, cliente);
    await prepararEnLocal(pedido._id, dueno);
    await recogerYEntregar(pedido._id, usuarioDomiciliario, domiciliario);

    const entregado = await Order.findById(pedido._id);

    // La base de la comisión baja al subtotal ya descontado: la plataforma
    // cobra sobre 30.000, no sobre 40.000. El negocio absorbe su promoción.
    expect(entregado!.finance.merchantCommission).toBe(3000);
    expect(entregado!.finance.businessPayout).toBe(27000);
    // Y no le cuesta un peso a ZIPP.
    expect(entregado!.finance.platformPromotionExpense).toBe(0);

    // El envío no se toca, así que el repartidor cobra igual que siempre.
    expect(entregado!.finance.driverPayout).toBe(TARIFA_REPARTIDOR);

    expect(await ledgerService.isBalanced({ orderId: pedido._id })).toBe(true);
  });

  // ────────────────────────────────────────────────────────────
  it('Pedido 4 · envío gratis de plataforma: el negocio y el repartidor cobran completo', async () => {
    const { cliente, dueno, negocio, producto, usuarioDomiciliario, domiciliario } =
      await montarEscenario();

    await makeCoupon({
      code: 'ENVIOGRATIS',
      type: CouponType.FREE_DELIVERY,
      businessId: null,
      fundedBy: CouponFundedBy.PLATFORM,
    });

    const { cotizacion, pedido } = await cotizarYCrear(
      cliente,
      cuerpoPedido(negocio, producto, { couponCode: 'ENVIOGRATIS' })
    );

    // El cliente no paga envío.
    expect(cotizacion.coupon.deliveryDiscount).toBe(cotizacion.deliveryFee);
    expect(cotizacion.total).toBe(cotizacion.subtotal + cotizacion.tax);
    expect(pedido.total).toBe(cotizacion.total);

    await cobrarEnLinea(pedido._id, cliente);
    await prepararEnLocal(pedido._id, dueno);
    await recogerYEntregar(pedido._id, usuarioDomiciliario, domiciliario);

    const entregado = await Order.findById(pedido._id);

    // La plataforma se come el costo: el negocio cobra sobre el subtotal
    // completo y el repartidor recibe su envío íntegro aunque el cliente
    // no lo haya pagado. Regalar el envío no puede salir del bolsillo de
    // quien pedalea.
    expect(entregado!.finance.merchantCommission).toBe(4000);
    expect(entregado!.finance.businessPayout).toBe(36000);
    expect(entregado!.finance.driverPayout).toBe(TARIFA_REPARTIDOR);

    // Y queda registrado como gasto promocional de ZIPP, no como un cobro
    // que nadie hizo.
    expect(entregado!.finance.platformPromotionExpense).toBe(TARIFA_REPARTIDOR);
    expect(entregado!.finance.platformNetRevenueBeforeOperatingCosts).toBe(
      4000 - TARIFA_REPARTIDOR
    );

    expect(await ledgerService.isBalanced({ orderId: pedido._id })).toBe(true);
  });

  // ────────────────────────────────────────────────────────────
  it('Pedido 5 · cancelado: no mueve dinero y devuelve el uso del cupón', async () => {
    const { cliente, dueno, negocio, producto } = await montarEscenario();

    await makeCoupon({
      code: 'DEVUELTO',
      type: CouponType.FIXED,
      value: 5000,
      perUserLimit: 1,
      fundedBy: CouponFundedBy.PLATFORM,
    });

    const { pedido } = await cotizarYCrear(
      cliente,
      cuerpoPedido(negocio, producto, { couponCode: 'DEVUELTO' })
    );

    expect(await CouponRedemption.countDocuments({ orderId: pedido._id })).toBe(1);

    await cobrarEnLinea(pedido._id, cliente);
    expect((await cambiarEstado(pedido._id, dueno, OrderStatus.ACCEPTED)).status).toBe(200);
    expect((await cambiarEstado(pedido._id, dueno, OrderStatus.CANCELLED, {
      cancellationReason: 'Se acabó el producto',
    })).status).toBe(200);

    const cancelado = await Order.findById(pedido._id);
    expect(cancelado!.status).toBe(OrderStatus.CANCELLED);
    expect(cancelado!.cancellationReason).toBe('Se acabó el producto');

    // Un pedido que no ocurrió no genera comisión ni efectivo por rendir.
    expect(await Commission.countDocuments({ orderId: pedido._id })).toBe(0);
    expect(await CashReconciliation.countDocuments({ orderId: pedido._id })).toBe(0);

    // Nadie queda debiendo ni cobrando nada.
    const payouts = await Payout.find({ orderId: pedido._id });
    expect(payouts.every((p) => p.status === PayoutStatus.REVERSED)).toBe(true);

    // Y el cliente no pierde el cupón por algo que no fue culpa suya.
    expect(await CouponRedemption.findOne({ orderId: pedido._id })).toBeNull();

    // El libro queda plano: cada reconocimiento tiene su contrapartida.
    expect(await ledgerService.isBalanced({ orderId: pedido._id })).toBe(true);

    // Cancelado es un estado terminal.
    expect((await cambiarEstado(pedido._id, dueno, OrderStatus.PREPARING)).status).toBe(400);
  });

  // ────────────────────────────────────────────────────────────
  it('la máquina de estados no deja saltarse pasos ni cruzar roles', async () => {
    const { cliente, dueno, negocio, producto, usuarioDomiciliario } = await montarEscenario();
    const { pedido } = await cotizarYCrear(cliente, cuerpoPedido(negocio, producto));

    // De "recibido" no se salta a "entregado".
    expect((await cambiarEstado(pedido._id, dueno, OrderStatus.DELIVERED)).status).toBe(400);

    // El negocio no marca "en camino": eso le toca a quien lo lleva.
    // (Se cobra antes: un pedido en línea impago no puede aceptarse.)
    await cobrarEnLinea(pedido._id, cliente);
    expect((await cambiarEstado(pedido._id, dueno, OrderStatus.ACCEPTED)).status).toBe(200);
    expect((await cambiarEstado(pedido._id, dueno, OrderStatus.ON_WAY)).status).toBe(400);

    // El repartidor tampoco acepta pedidos por el local.
    expect((await cambiarEstado(pedido._id, usuarioDomiciliario, OrderStatus.PREPARING)).status).toBe(403);

    // Y un negocio ajeno no toca este pedido.
    const otroDueno = await makeUser({ role: UserRole.BUSINESS });
    await makeBusiness(otroDueno._id);
    expect((await cambiarEstado(pedido._id, otroDueno, OrderStatus.PREPARING)).status).toBe(403);
  });
});
