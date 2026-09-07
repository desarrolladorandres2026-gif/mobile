import { Order, IOrder, IOrderFinance, Business, Commission, Driver } from '../models';
import { AppError } from '../middlewares';
import {
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
  UserRole,
  RefundKind,
  CommissionStatus,
  OrderCodeKind,
  OrderCodeStatus,
  OrderTimelineAction,
} from '../types';
import { OrderSecurity } from '../security/orderSecurity';
import { logSystemAudit, AuditAction, AuditSeverity } from '../security';
import { notificationService } from './notification.service';
import { pricingService, Quote } from './pricing.service';
import { couponService } from './coupon.service';
import { ledgerService } from './ledger.service';
import { payoutService } from './payout.service';
import { cashReconciliationService } from './cashReconciliation.service';
import { pricingConfigService } from './pricingConfig.service';
import { refundService, allocateRefund } from './refund.service';
import { orderSecurityService } from './orderSecurity.service';
import { orderTimelineService, TimelineContext } from './orderTimeline.service';

// Estado → transiciones válidas
const VALID_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  [OrderStatus.PENDING]:   [OrderStatus.ACCEPTED, OrderStatus.CANCELLED],
  [OrderStatus.ACCEPTED]:  [OrderStatus.PREPARING, OrderStatus.CANCELLED],
  [OrderStatus.PREPARING]: [OrderStatus.READY, OrderStatus.CANCELLED],
  [OrderStatus.READY]:     [OrderStatus.PICKED_UP, OrderStatus.CANCELLED],
  [OrderStatus.PICKED_UP]: [OrderStatus.ON_WAY],
  [OrderStatus.ON_WAY]:    [OrderStatus.DELIVERED, OrderStatus.CANCELLED],
  [OrderStatus.DELIVERED]: [],
  [OrderStatus.CANCELLED]: [],
};

// Rol → estados que puede establecer
const ROLE_ALLOWED_STATUSES: Record<string, OrderStatus[]> = {
  [UserRole.CLIENT]:   [OrderStatus.CANCELLED],
  [UserRole.BUSINESS]: [OrderStatus.ACCEPTED, OrderStatus.PREPARING, OrderStatus.READY, OrderStatus.CANCELLED],
  [UserRole.DRIVER]:   [OrderStatus.PICKED_UP, OrderStatus.ON_WAY, OrderStatus.DELIVERED],
  [UserRole.ADMIN]:    Object.values(OrderStatus).filter(s => s !== OrderStatus.PENDING),
};

interface CreateOrderInput {
  clientId: string;
  businessId: string;
  items: Array<{
    productId: string;
    quantity: number;
    /** Only the extra's name and count; prices come from the database. */
    selectedExtras?: Array<{ name: string; quantity?: number }>;
    notes?: string;
  }>;
  paymentMethod: string;
  deliveryAddress: string;
  deliveryDetails?: string;
  deliveryLongitude: number;
  deliveryLatitude: number;
  notes?: string;
  couponCode?: string;
  tip?: number;
  idempotencyKey?: string;
}

/** Maps a quote onto the immutable snapshot persisted with the order. */
function toFinanceSnapshot(quote: Quote): IOrderFinance {
  return {
    productSubtotal: quote.productSubtotal,
    merchantCommission: quote.merchantCommission,
    customerServiceFee: quote.customerServiceFee,
    deliveryCustomerFee: quote.deliveryCustomerFee,
    driverDeliveryPayout: quote.driverDeliveryPayout,
    deliveryMargin: quote.deliveryMargin,
    tip: quote.tip,
    merchantFundedDiscount: quote.merchantFundedDiscount,
    platformFundedDiscount: quote.platformFundedDiscount,
    taxPayable: quote.taxPayable,
    businessPayout: quote.businessPayout,
    driverPayout: quote.driverPayout,
    platformGrossRevenue: quote.platformGrossRevenue,
    platformPromotionExpense: quote.platformPromotionExpense,
    platformNetRevenueBeforeOperatingCosts: quote.platformNetRevenueBeforeOperatingCosts,
    customerTotal: quote.customerTotal,
    currency: quote.currency,
    pricingConfigVersion: quote.pricingConfigVersion,
    appliedCommissionBps: quote.appliedCommissionBps,
  };
}

export class OrderService {
  /**
   * Prices a cart without creating anything. Checkout calls this to render
   * its breakdown, so the customer only ever sees server-computed money.
   */
  async quote(input: {
    clientId: string;
    businessId: string;
    items: CreateOrderInput['items'];
    paymentMethod: string;
    deliveryLongitude: number;
    deliveryLatitude: number;
    couponCode?: string;
    tip?: number;
  }): Promise<Quote> {
    return pricingService.quote({
      userId: input.clientId,
      businessId: input.businessId,
      items: input.items,
      deliveryLatitude: input.deliveryLatitude,
      deliveryLongitude: input.deliveryLongitude,
      paymentMethod: input.paymentMethod as PaymentMethod,
      couponCode: input.couponCode,
      tip: input.tip,
    });
  }

  async create(input: CreateOrderInput): Promise<IOrder> {
    if (input.idempotencyKey) {
      const existing = await Order.findOne({ idempotencyKey: input.idempotencyKey });
      if (existing) return existing;
    }

    const business = await Business.findById(input.businessId);
    if (!business || !business.isActive) throw new AppError('Negocio no encontrado o inactivo', 404);

    // Re-price server-side. The client's numbers are never trusted, and any
    // coupon it claims is re-validated here — this is the only place the
    // amounts that get charged are decided.
    const quote = await pricingService.quote({
      userId: input.clientId,
      businessId: input.businessId,
      items: input.items,
      deliveryLatitude: input.deliveryLatitude,
      deliveryLongitude: input.deliveryLongitude,
      paymentMethod: input.paymentMethod as PaymentMethod,
      couponCode: input.couponCode,
      tip: input.tip,
    });

    const finance = toFinanceSnapshot(quote);

    // Un pedido en efectivo nace en su propio estado, no en el genérico
    // "pendiente". `PENDING` significa "el cliente no ha pagado y el
    // pedido está bloqueado"; un pedido en efectivo no está bloqueado por
    // nada — se cobra en la puerta y ese es su curso normal. Confundirlos
    // era lo que hacía que un informe de impagos contara como morosos a
    // todos los pedidos contra entrega en curso.
    const isCash = input.paymentMethod === PaymentMethod.CASH_ON_DELIVERY;
    const initialPaymentStatus = isCash
      ? PaymentStatus.PENDING_CASH
      : PaymentStatus.PENDING;

    let order: IOrder;
    try {
      order = await Order.create({
        clientId: input.clientId,
        businessId: input.businessId,
        items: quote.items,
        paymentMethod: input.paymentMethod,
        paymentStatus: initialPaymentStatus,
        deliveryAddress: input.deliveryAddress,
        deliveryDetails: input.deliveryDetails,
        deliveryLocation: {
          type: 'Point',
          coordinates: [input.deliveryLongitude, input.deliveryLatitude],
        },
        // Legacy mirrors, kept so existing clients and reports keep working.
        subtotal: quote.productSubtotal,
        deliveryFee: quote.deliveryCustomerFee,
        deliveryDistanceKm: quote.deliveryDistanceKm,
        zoneId: quote.zoneId,
        discount: quote.discount,
        couponId: quote.coupon?.couponId ?? null,
        couponCode: quote.coupon?.code ?? null,
        tip: quote.tip,
        tax: quote.taxPayable,
        platformCommission: quote.merchantCommission,
        businessPayout: quote.businessPayout,
        driverPayout: quote.driverPayout,
        total: quote.customerTotal,
        // Authoritative snapshot.
        finance,
        pricingConfigVersion: quote.pricingConfigVersion,
        notes: input.notes,
        city: business.city,
        idempotencyKey: input.idempotencyKey,
      });
    } catch (error: any) {
      if (error.code === 11000 && input.idempotencyKey) {
        const existing = await Order.findOne({ idempotencyKey: input.idempotencyKey });
        if (existing) return existing;
      }
      throw error;
    }

    // Consume the coupon now that a real order exists. If it was exhausted
    // between quoting and creating, the order is rolled back rather than
    // silently granting a discount that is no longer available.
    if (quote.coupon) {
      const redeemed = await couponService.redeem(
        quote.coupon.couponId,
        input.clientId,
        order._id.toString(),
        quote.coupon.totalDiscount,
        quote.coupon.platformFunded
      );

      if (!redeemed) {
        await Order.deleteOne({ _id: order._id });
        throw new AppError('El cupón se agotó mientras confirmabas el pedido', 409);
      }
    }

    // Recognise the order in the books straight away. Revenue and payables
    // are booked against a receivable, so a later capture only converts the
    // receivable to cash rather than recognising anything twice.
    try {
      await ledgerService.recordOrderPlaced({
        orderId: order._id,
        finance,
        businessId: order.businessId,
      });
      await payoutService.accrueForOrder(order);

      // El cobro en efectivo se abre junto con los libros, no al entregar:
      // así el pedido tiene desde el primer momento una fila de pago que
      // dice cuánto se va a cobrar y en qué estado va, igual que la tiene
      // uno en línea. Va dentro de este `try` a propósito — un pedido con
      // asientos pero sin cobro sería tan inconsistente como al revés.
      if (isCash) {
        const { paymentService } = await import('./payments');
        await paymentService.openCashPayment(order);
      }
    } catch (error) {
      // Never leave an order without its books. Roll back and surface it.
      if (quote.coupon) await couponService.release(order._id.toString());
      const { Payment } = await import('../models');
      await Payment.deleteMany({ orderId: order._id });
      await Order.deleteOne({ _id: order._id });
      throw error;
    }

    // El primer hito de la línea de tiempo. Sin él, un pedido cancelado
    // antes de que el comercio lo mirara no tendría historia ninguna: solo
    // un `createdAt` que nadie relaciona con el cliente que lo hizo.
    orderTimelineService
      .record(order._id.toString(), OrderTimelineAction.CREATED, {
        userId: input.clientId,
        role: UserRole.CLIENT,
      })
      .catch(console.error);

    // Crear notificaciones en background (no bloquea la respuesta)
    this.triggerOrderCreatedNotifications(order, business).catch(console.error);

    return order;
  }

  private async triggerOrderCreatedNotifications(order: IOrder, business: any) {
    await Promise.allSettled([
      notificationService.notifyOrderCreated(
        order.clientId.toString(),
        order.orderNumber,
        business.name
      ),
      notificationService.notifyBusinessNewOrder(
        business.ownerId.toString(),
        order.orderNumber
      ),
    ]);
  }

  async getById(id: string): Promise<IOrder> {
    const order = await Order.findById(id)
      .populate('clientId', 'name phone avatar')
      // `location` va incluido: la pantalla de recogida del domiciliario
      // necesita coordenadas exactas para el botón "Navegar", igual que ya
      // tiene `getAvailableOrders`. Sin esto caía a buscar por dirección de
      // texto, que Maps no siempre resuelve al punto correcto.
      .populate('businessId', 'name logo address phone location')
      .populate({
        path: 'driverId',
        populate: { path: 'userId', select: 'name phone avatar' },
      });
    if (!order) throw new AppError('Pedido no encontrado', 404);
    return order;
  }

  async getByClient(clientId: string, page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    const [orders, total] = await Promise.all([
      Order.find({ clientId }).sort({ createdAt: -1 }).skip(skip).limit(limit)
        .populate('businessId', 'name logo'),
      Order.countDocuments({ clientId }),
    ]);
    return { orders, meta: { page, limit, total, totalPages: Math.ceil(total / limit) } };
  }

  async getByBusiness(businessId: string, status?: string, page = 1, limit = 20) {
    const filter: Record<string, unknown> = { businessId };
    if (status) filter.status = status;
    const skip = (page - 1) * limit;
    const [orders, total] = await Promise.all([
      Order.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit)
        .populate('clientId', 'name phone')
        // El comercio tiene delante a esta persona pidiendole el codigo de
        // recogida: necesita reconocerla. Sin avatar ni estado, el panel
        // solo podia ensenar un nombre, que no identifica a nadie en un
        // mostrador con tres domiciliarios esperando.
        .populate({
          path: 'driverId',
          select: 'vehicleType licensePlate status currentLocation lastLocationAt rating',
          populate: { path: 'userId', select: 'name phone avatar' },
        }),
      Order.countDocuments(filter),
    ]);
    return { orders, meta: { page, limit, total, totalPages: Math.ceil(total / limit) } };
  }

  async getAvailableOrders(page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    const filter = { status: OrderStatus.READY, driverId: null };
    const [orders, total] = await Promise.all([
      Order.find(filter).sort({ createdAt: 1 }).skip(skip).limit(limit)
        .populate('businessId', 'name logo address phone location')
        .populate('clientId', 'name phone'),
      Order.countDocuments(filter),
    ]);
    return { orders, meta: { page, limit, total, totalPages: Math.ceil(total / limit) } };
  }

  async getDriverOrders(driverId: string, page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    const filter = { driverId };
    const [orders, total] = await Promise.all([
      Order.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit)
        .populate('businessId', 'name logo address phone location')
        .populate('clientId', 'name phone'),
      Order.countDocuments(filter),
    ]);
    return { orders, meta: { page, limit, total, totalPages: Math.ceil(total / limit) } };
  }

  async updateStatus(
    orderId: string,
    status: OrderStatus,
    userId: string,
    userRole: string,
    cancellationReason?: string,
    context: TimelineContext = {}
  ): Promise<IOrder> {
    const order = await Order.findById(orderId);
    if (!order) throw new AppError('Pedido no encontrado', 404);

    // Validate ownership based on role
    if (userRole === UserRole.CLIENT && order.clientId.toString() !== userId) {
      throw new AppError('No autorizado para modificar este pedido', 403);
    }
    if (userRole === UserRole.BUSINESS) {
      const business = await Business.findById(order.businessId);
      if (!business || business.ownerId.toString() !== userId) {
        throw new AppError('No autorizado para modificar este pedido', 403);
      }
    }
    // Un domiciliario solo manda sobre el pedido que tiene asignado.
    //
    // Faltaba: bastaba con tener rol `driver` para mover el pedido de
    // cualquiera a "recogido", "en camino" o "entregado" —incluido
    // marcarlo entregado sin haberlo tocado nunca—. La comprobación va
    // del pedido hacia el usuario (`_id: order.driverId, userId`), que es
    // la única dirección que prueba la asignación.
    if (userRole === UserRole.DRIVER) {
      if (!order.driverId) {
        throw new AppError('Este pedido no tiene domiciliario asignado', 403);
      }
      const assigned = await Driver.findOne({ _id: order.driverId, userId }).select('_id');
      if (!assigned) {
        throw new AppError('No autorizado para modificar este pedido', 403);
      }
    }

    const allowedNext = VALID_TRANSITIONS[order.status];
    if (!allowedNext.includes(status)) {
      throw new AppError(`Transición inválida: ${order.status} → ${status}`, 400);
    }

    const roleAllowed = ROLE_ALLOWED_STATUSES[userRole] ?? [];
    if (!roleAllowed.includes(status)) {
      throw new AppError(`Tu rol no puede establecer el estado "${status}"`, 403);
    }

    // An online order is not a real order until the gateway says the money
    // arrived. Without this gate a business could accept and start cooking
    // for a checkout the customer abandoned, or one that was declined
    // minutes later — the platform absorbing the cost either way. Only
    // PaymentService.applyGatewayStatus can set paymentStatus to PAID, and
    // only from something Wompi actually told us, so this reads a fact the
    // client has no way to forge.
    //
    // Cancellation stays open: an unpaid online order must always be
    // cancellable, and that is the normal way an abandoned checkout ends.
    if (
      status === OrderStatus.ACCEPTED &&
      order.paymentMethod === PaymentMethod.ONLINE &&
      order.paymentStatus !== PaymentStatus.PAID
    ) {
      throw new AppError(
        'Este pedido es de pago en línea y aún no está pagado. ' +
          'Podrás aceptarlo en cuanto se confirme el pago.',
        409
      );
    }

    // ── Puertas de seguridad del traspaso físico ──
    //
    // Recoger y entregar son los dos momentos en los que el pedido cambia
    // de manos, y los únicos que un domiciliario podría declarar en falso
    // desde el sofá. Cada uno exige que su código ya se haya consumido,
    // así que la app no puede "pasar a entregado" por su cuenta: el estado
    // es consecuencia de la validación, nunca al revés.
    //
    // El administrador puede saltárselas —soporte tiene que poder cerrar
    // un pedido con el teléfono del cliente descargado— pero eso queda en
    // la auditoría como una acción administrativa, no como una entrega
    // verificada.
    if (userRole !== UserRole.ADMIN) {
      if (status === OrderStatus.PICKED_UP) {
        await this.assertCodeConsumed(order._id.toString(), OrderCodeKind.PICKUP);
      }
      if (status === OrderStatus.DELIVERED) {
        await this.assertCodeConsumed(order._id.toString(), OrderCodeKind.DELIVERY);
      }
    } else if (status === OrderStatus.PICKED_UP || status === OrderStatus.DELIVERED) {
      // El propio administrador puede pasar por encima del código —
      // soporte tiene que poder cerrar un pedido con el teléfono del
      // cliente descargado. Pero que pueda no significa que quede en
      // silencio: sin este registro, un bypass administrativo se vería
      // exactamente igual que una entrega verificada de verdad en
      // cualquier reporte, que es justo el hueco que la auditoría no
      // puede permitirse.
      const kind = status === OrderStatus.PICKED_UP ? OrderCodeKind.PICKUP : OrderCodeKind.DELIVERY;
      const security = await OrderSecurity.findOne({ orderId: order._id.toString() }).select(`${kind}.status`);
      if (!security || security[kind].status !== OrderCodeStatus.USED) {
        logSystemAudit({
          userId,
          role: userRole,
          action: AuditAction.SUSPICIOUS_ACTIVITY,
          entity: 'order',
          entityId: order._id.toString(),
          severity: AuditSeverity.HIGH,
          description: `Un administrador forzó "${status}" sin que el código de ${kind} estuviera validado`,
          metadata: { orderId: order._id.toString(), status, kind },
        }).catch(console.error);
      }
    }

    const now = new Date();
    const previousStatus = order.status;

    // ── Reclamo atómico de la transición ──
    //
    // El estado de partida viaja dentro de la condición de la escritura,
    // así que solo una de dos peticiones simultáneas la aplica. Antes la
    // comprobación de arriba y este `save` estaban separados por media
    // docena de `await` —códigos, evidencias, contabilidad—, y un doble
    // toque en "entregar" (una red móvil mala basta) pasaba el filtro dos
    // veces: `onDelivered` suma a mano el fondo y las estadísticas del
    // domiciliario, así que le abonaba dos veces el dinero que adelantó al
    // comercio.
    //
    // Los efectos van *después* del reclamo, no antes, y eso también es
    // deliberado: al revés, un fallo entre la contabilidad y el `save`
    // dejaba los asientos escritos con el pedido sin avanzar, y el
    // reintento los volvía a escribir. Reclamando primero, un fallo
    // posterior deja el trabajo a medias —visible y reparable— en vez de
    // duplicado y silencioso.
    const patch: Record<string, unknown> = { status };
    if (status === OrderStatus.ACCEPTED) patch.acceptedAt = now;
    if (status === OrderStatus.PREPARING) patch.preparedAt = now;
    if (status === OrderStatus.PICKED_UP) patch.pickedUpAt = now;
    if (status === OrderStatus.DELIVERED) patch.deliveredAt = now;
    if (status === OrderStatus.CANCELLED) {
      patch.cancelledAt = now;
      if (cancellationReason) patch.cancellationReason = cancellationReason;
    }

    const claimed = await Order.findOneAndUpdate(
      { _id: order._id, status: previousStatus },
      { $set: patch },
      { new: true }
    );

    if (!claimed) {
      throw new AppError(
        'El pedido cambió de estado mientras se procesaba tu solicitud. Vuelve a intentarlo.',
        409
      );
    }

    // Aceptar es el primer instante en que el pedido va a existir de
    // verdad: es cuando tiene sentido emitir los dos secretos. Antes se
    // gastarían en pedidos que el comercio rechaza.
    if (status === OrderStatus.ACCEPTED) {
      await orderSecurityService.ensureIssued(claimed._id.toString());
    }

    if (status === OrderStatus.DELIVERED) {
      // Delivery no longer decides payment. A digital order is PAID only
      // when the gateway says so; a cash order becomes a reconciliation
      // obligation the driver has to remit and someone else has to verify.
      await this.onDelivered(claimed);
    }

    if (status === OrderStatus.CANCELLED) {
      await this.onCancelled(claimed);
      // Un código sigue sirviendo hasta que algo lo invalida: sin esto, un
      // pedido cancelado podría cerrarse como entregado un rato después.
      await orderSecurityService.voidCodes(claimed._id.toString());
    }

    // La bitácora se escribe *después* de que el cambio sea un hecho en la
    // base. Escribirla antes produciría el peor de los registros posibles:
    // uno que afirma cosas que no llegaron a pasar porque el `save` falló.
    orderTimelineService
      .recordStatusChange(claimed._id.toString(), previousStatus, status, { userId, role: userRole }, {
        ...context,
        newValue: cancellationReason ? { cancellationReason } : undefined,
      })
      .catch(console.error);

    this.triggerStatusChangeNotifications(claimed, status).catch(console.error);

    return claimed;
  }

  /**
   * Settles the physical side of a delivery.
   *
   * For cash, the driver has collected the customer's money: the receivable
   * becomes cash in their hands, they keep their guaranteed payout, and the
   * platform's share opens as a reconciliation record. Their reserved fund
   * is released here — they paid the merchant out of it and are now square.
   */
  private async onDelivered(order: IOrder): Promise<void> {
    const finance = order.finance;

    await Commission.findOneAndUpdate(
      { orderId: order._id },
      {
        orderId: order._id,
        businessId: order.businessId,
        driverId: order.driverId,
        platformAmount: finance.platformGrossRevenue,
        businessAmount: finance.businessPayout,
        driverAmount: finance.driverPayout,
        status: CommissionStatus.PENDING,
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    // A driver may only have been attached to this order after creation, so
    // their payout is accrued (idempotently) here rather than at placement.
    await payoutService.accrueForOrder(order);

    // A cash order with no courier has nobody holding the money, so there is
    // nothing to book or reconcile. It should not be reachable — only a
    // driver can mark an order delivered — but the ledger must never be
    // handed a null counterparty, so this fails loudly instead of writing a
    // malformed record.
    if (order.paymentMethod === PaymentMethod.CASH_ON_DELIVERY && !order.driverId) {
      console.error(
        '[ORDERS] Pedido contra entrega marcado como entregado sin domiciliario',
        { orderId: String(order._id), orderNumber: order.orderNumber }
      );
      return;
    }

    if (order.paymentMethod === PaymentMethod.CASH_ON_DELIVERY) {
      const cashToRemit =
        finance.customerTotal - finance.businessPayout - finance.driverPayout;

      await ledgerService.recordCashCollected({
        orderId: order._id,
        customerTotal: finance.customerTotal,
        businessPayout: finance.businessPayout,
        driverPayout: finance.driverPayout,
        cashToRemit,
        pricingConfigVersion: finance.pricingConfigVersion,
        driverId: order.driverId!,
        businessId: order.businessId,
        currency: finance.currency,
      });

      await cashReconciliationService.open(order);

      // Both payouts were discharged at the door: the driver paid the
      // merchant from their fund and kept their own fee, so neither is
      // owed by ZIPP any more.
      await payoutService.dischargeInCash(order._id);
    }

    if (order.driverId) {
      // `$inc` y no leer-sumar-guardar: un domiciliario puede cerrar dos
      // entregas casi a la vez, y entonces los dos `findById` leen el mismo
      // documento y el segundo `save()` pisa la suma del primero. Se perdía
      // una entrega del contador y, en efectivo, el fondo que adelantó en
      // uno de los dos pedidos. Mongo aplica `$inc` sobre el valor que hay
      // en la base, no sobre el que leyó este proceso.
      const increments: Record<string, number> = {
        totalDeliveries: 1,
        totalEarnings: finance.driverPayout,
      };
      if (order.paymentMethod === PaymentMethod.CASH_ON_DELIVERY) {
        increments.currentFund = finance.businessPayout;
      }
      await Driver.updateOne({ _id: order.driverId }, { $inc: increments });
    }
  }

  /**
   * Unwinds every financial consequence of a cancelled order.
   *
   * The old flow released the coupon and nothing else, which stranded the
   * driver's reserved fund permanently and left revenue recognised for an
   * order that never happened.
   */
  private async onCancelled(order: IOrder): Promise<void> {
    const finance = order.finance;

    // Ningún intento de cobro sobrevive a la cancelación: ni el checkout
    // de Wompi que el cliente todavía podría abrir desde el historial de
    // su navegador, ni la fila del cobro en efectivo. Hasta ahora un
    // pedido cancelado dejaba vivo su enlace de pago, y pagarlo cobraba
    // un pedido cuyas cuentas ya se habían deshecho.
    const { paymentService } = await import('./payments');
    await paymentService.voidOpenPayments(
      order._id.toString(),
      order.cancellationReason || 'Pedido cancelado'
    );

    // Give the driver's working capital back. This was the bug that quietly
    // froze a courier's funds on every late cancellation.
    if (order.driverId && order.paymentMethod === PaymentMethod.CASH_ON_DELIVERY) {
      // Atómico por la misma razón que en `onDelivered`: es dinero de una
      // persona y no puede depender de qué proceso guarde el último.
      await Driver.updateOne(
        { _id: order.driverId },
        { $inc: { currentFund: finance.businessPayout || order.subtotal } }
      );
    }

    if (!finance?.customerTotal) {
      // Legacy order with no snapshot: only the coupon can be unwound.
      if (order.couponId) await couponService.release(order._id.toString());
      return;
    }

    const captured = order.paymentStatus === PaymentStatus.PAID;

    if (captured) {
      // Money was taken, so this is a real refund through the gateway.
      await refundService.issue({
        orderId: order._id.toString(),
        reason: order.cancellationReason || 'Pedido cancelado',
        kind: RefundKind.FULL,
        idempotencyKey: `cancel:${order._id}`,
      });
      return;
    }

    // Nothing was collected: reverse the recognition against the receivable.
    const allocation = allocateRefund(finance, finance.customerTotal, RefundKind.FULL);
    await refundService.applyReversal(
      order,
      allocation,
      finance.customerTotal,
      RefundKind.FULL,
      false,
      `cancel:${order._id}`
    );

    // Se persiste aquí y no se deja para el llamador: desde que la
    // transición se reclama de forma atómica, el documento del pedido ya
    // está guardado cuando esto corre, y confiar en un `save()` posterior
    // que ya no existe dejaría el cobro marcado como pendiente para siempre.
    order.paymentStatus = PaymentStatus.FAILED;
    await order.save();
  }

  /**
   * Exige que el código de esa etapa ya se haya consumido.
   *
   * Consulta el modelo directamente y no `orderSecurityService` para no
   * cerrar un ciclo de importaciones: el servicio de códigos necesita
   * llamar a `updateStatus` después de validar, así que la dependencia
   * tiene que ir en un solo sentido.
   */
  private async assertCodeConsumed(orderId: string, kind: OrderCodeKind): Promise<void> {
    const security = await OrderSecurity.findOne({ orderId }).select(`${kind}.status`);

    if (!security || security[kind].status !== OrderCodeStatus.USED) {
      throw new AppError(
        kind === OrderCodeKind.PICKUP
          ? 'Valida el código de recogida en el comercio antes de continuar'
          : 'Valida el código de entrega del cliente antes de completar el pedido',
        409,
        'CODE_REQUIRED'
      );
    }
  }

  private async triggerStatusChangeNotifications(order: IOrder, status: OrderStatus) {
    const notifyTargets: Promise<any>[] = [
      notificationService.notifyOrderStatusChanged(order.clientId.toString(), order.orderNumber, status),
    ];

    if (order.driverId) {
      const driverUser = await Driver.findById(order.driverId).select('userId');
      if (driverUser) {
        notifyTargets.push(
          notificationService.notifyOrderStatusChanged(driverUser.userId.toString(), order.orderNumber, status)
        );
      }
    }

    // Al comercio solo los dos estados que no provoca él mismo. Avisar a
    // alguien de su propia acción —"aceptaste el pedido"— es ruido, y el
    // ruido es lo que hace que se dejen de mirar las notificaciones que sí
    // importan. Faltaba justo la que más importa: hasta ahora, un cliente
    // que cancelaba dejaba a la cocina trabajando en un pedido muerto.
    if (status === OrderStatus.CANCELLED || status === OrderStatus.DELIVERED) {
      const business = await Business.findById(order.businessId).select('ownerId');
      if (business) {
        const ownerId = business.ownerId.toString();
        notifyTargets.push(
          status === OrderStatus.CANCELLED
            ? notificationService.notifyBusinessOrderCancelled(
                ownerId,
                order.orderNumber,
                order.cancellationReason
              )
            : notificationService.notifyBusinessOrderDelivered(ownerId, order.orderNumber)
        );
      }
    }

    await Promise.allSettled(notifyTargets);
  }

  /**
   * Attaches a driver to an order.
   *
   * On cash orders the driver fronts the merchant's payout out of their own
   * fund — and only that. The old code reserved the full subtotal, which
   * charged the driver for the platform's commission as well.
   */
  async assignDriver(
    orderId: string,
    driverId: string,
    actor?: { userId: string; role: string }
  ): Promise<IOrder> {
    const order = await Order.findById(orderId);
    if (!order) throw new AppError('Pedido no encontrado', 404);
    if (order.driverId) throw new AppError('Este pedido ya tiene domiciliario asignado', 400);

    const driver = await Driver.findById(driverId).populate('userId', 'name');
    if (!driver) throw new AppError('Domiciliario no encontrado', 404);
    if (!driver.isApproved || !driver.isActive) throw new AppError('Domiciliario no disponible', 400);
    const { driverService } = await import('./driver.service');
    await driverService.assertDocumentsCurrent(driver._id.toString());

    // Lo que se retiene del fondo del domiciliario. Vive fuera del bloque
    // porque, si el pedido se lo lleva otro, hay que devolverlo.
    let reserved = 0;

    if (order.paymentMethod === PaymentMethod.CASH_ON_DELIVERY) {
      // ── Techo de efectivo sin rendir ──
      //
      // `cashOnDeliveryMaxAmount` limita *un* pedido; esto limita la
      // acumulación, que es el riesgo de verdad: diez pedidos por debajo
      // del tope dejan en la calle lo mismo que uno enorme, y hasta ahora
      // nada lo miraba. Va antes que la comprobación de fondo porque es la
      // razón más importante para no dar el pedido, y así el mensaje que
      // recibe el domiciliario es el que explica qué tiene que hacer.
      //
      // Se aplica también cuando asigna un administrador: si el saldo está
      // por encima del techo, el riesgo es el mismo lo pida quien lo pida.
      const cfg = await pricingConfigService.getCurrent();
      if (cfg.maxDriverCashDebt > 0) {
        const outstanding = await cashReconciliationService.outstandingFor(driver._id);
        if (outstanding >= cfg.maxDriverCashDebt) {
          // Se espera, al contrario que el resto de auditorías de este
          // archivo. La diferencia no es capricho: las demás acompañan a
          // una acción que sí ocurre, y hacerlas esperar solo frenaría el
          // camino bueno. Esta *es* la única prueba de que se denegó algo,
          // y una prueba que puede no haberse escrito no es una prueba.
          // `logSystemAudit` se traga sus propios errores, así que
          // esperarla no puede cambiar lo que recibe quien llamó.
          await logSystemAudit({
            userId: actor?.userId ?? driverId,
            role: actor?.role ?? UserRole.DRIVER,
            action: AuditAction.CASH_DEBT_LIMIT_BLOCKED,
            entity: 'order',
            entityId: order._id.toString(),
            severity: AuditSeverity.MEDIUM,
            description:
              `Asignación en efectivo bloqueada: saldo sin rendir ` +
              `$${outstanding.toLocaleString('es-CO')} sobre un techo de ` +
              `$${cfg.maxDriverCashDebt.toLocaleString('es-CO')}`,
            metadata: {
              orderNumber: order.orderNumber,
              driverId: driver._id.toString(),
              outstanding,
              limit: cfg.maxDriverCashDebt,
            },
          });

          throw new AppError(
            'Has alcanzado el límite de efectivo pendiente. Debes realizar una ' +
              'liquidación antes de aceptar nuevos pedidos en efectivo.',
            409,
            'CASH_DEBT_LIMIT'
          );
        }
      }

      reserved = order.finance?.businessPayout ?? order.businessPayout;

      // ── Reserva atómica del fondo ──
      //
      // La condición viaja *dentro* de la escritura. Leer el saldo, decidir
      // y guardar son tres pasos, y entre ellos cabe otra asignación del
      // mismo domiciliario: los dos leían el mismo saldo, los dos pasaban
      // la comprobación y el último `save()` dejaba el fondo como si solo
      // se hubiera reservado un pedido. El repartidor salía a la calle
      // debiendo un dinero que ZIPP creía que seguía teniendo.
      const funded = await Driver.findOneAndUpdate(
        { _id: driver._id, currentFund: { $gte: reserved } },
        { $inc: { currentFund: -reserved } },
        { new: true }
      );

      if (!funded) {
        throw new AppError(
          `Fondo insuficiente: necesitas $${reserved.toLocaleString('es-CO')} para este pedido`,
          400
        );
      }
    }

    // ── Reclamo atómico del pedido ──
    //
    // Tomar un pedido es una carrera real: dos domiciliarios ven el mismo
    // pedido disponible y pulsan "aceptar" con milisegundos de diferencia.
    // Comprobar `order.driverId` arriba y guardar aquí deja entre medias
    // media docena de `await` —documentos, techo de efectivo, fondo—, y en
    // ese hueco los dos pasaban el filtro. El segundo `save()` pisaba al
    // primero, y las consecuencias no eran cosméticas: el fondo del que
    // perdía quedaba descontado por un pedido que nunca iba a repartir
    // (nada se lo devuelve — `onCancelled` solo le devuelve el fondo a
    // quien figure en `order.driverId`), y el `Payout` del repartidor, con
    // su índice único por pedido, se quedaba apuntando al primero: el
    // pedido decía una cosa y la liquidación pagaba a otro.
    //
    // `driverId: null` casa también con el campo ausente, así que los
    // pedidos anteriores al `default: null` del esquema se reclaman igual.
    const claimed = await Order.findOneAndUpdate(
      { _id: order._id, driverId: null },
      { $set: { driverId: driver._id } },
      { new: true }
    );

    if (!claimed) {
      // Perdió la carrera. Devolver el fondo es obligatorio: es dinero de
      // una persona, retenido por un pedido que se lleva otra.
      if (reserved > 0) {
        await Driver.updateOne({ _id: driver._id }, { $inc: { currentFund: reserved } });
      }
      throw new AppError('Este pedido ya tiene domiciliario asignado', 409);
    }

    await payoutService.accrueForOrder(claimed);

    const driverUser = driver.userId as any;
    const driverName = driverUser?.name || 'El domiciliario';

    // El comercio también tiene que enterarse. Es quien va a tener a esa
    // persona en el mostrador pidiéndole el código de recogida, y hasta
    // ahora era el único de los tres que no recibía el aviso.
    const business = await Business.findById(order.businessId).select('ownerId');

    Promise.allSettled([
      notificationService.notifyDriverAssigned(order.clientId.toString(), driverName, order.orderNumber),
      notificationService.notifyDriverNewOrder(driverUser?._id?.toString() || driverId, order.orderNumber),
      business
        ? notificationService.notifyBusinessDriverAssigned(
            business.ownerId.toString(),
            order.orderNumber,
            driverName
          )
        : Promise.resolve(),
    ]).catch(console.error);

    orderTimelineService
      .record(
        order._id.toString(),
        OrderTimelineAction.DRIVER_ASSIGNED,
        // Un domiciliario que toma un pedido disponible es su propio
        // actor; una asignación desde el panel la firma el administrador.
        actor ?? { userId: driverUser?._id?.toString() || driverId, role: UserRole.DRIVER },
        { newValue: { driverId: driver._id.toString(), driverName } }
      )
      .catch(console.error);

    return claimed;
  }

  /**
   * Cambia el método de pago de un pedido ya creado.
   *
   * Existe porque el callejón sin salida era real: un cliente que elegía
   * pago en línea y no completaba el checkout —se le cayó la app, no tenía
   * saldo, se arrepintió— solo podía cancelar y volver a montar el carrito
   * entero. Ahora puede cambiar a efectivo, y al revés.
   *
   * Las tres reglas que lo hacen seguro:
   *
   *  1. **Solo antes de que el comercio acepte.** Después hay una cocina
   *     trabajando contra unas condiciones que ya no serían las mismas.
   *  2. **Un pago aprobado no se cambia.** Eso no es cambiar de método:
   *     es pedir un reembolso, y tiene su propio camino.
   *  3. **El intento anterior se invalida antes de abrir el nuevo.** Es la
   *     regla que evita el doble cobro — sin ella, el enlace de Wompi que
   *     el cliente ya tiene abierto seguiría siendo pagadero mientras el
   *     domiciliario le cobra en efectivo en la puerta.
   *
   * El precio no se recalcula, y no es un olvido: el método de pago no
   * entra en ninguna cifra del presupuesto —solo decide si el pedido es
   * admisible en efectivo—, así que el `finance` inmutable sigue siendo
   * exacto. Lo que sí se vuelve a comprobar son los límites del efectivo,
   * que sí dependen del total.
   */
  async changePaymentMethod(input: {
    orderId: string;
    clientId: string;
    paymentMethod: string;
    context?: TimelineContext;
  }): Promise<IOrder> {
    const order = await Order.findById(input.orderId);
    if (!order) throw new AppError('Pedido no encontrado', 404);

    if (order.clientId.toString() !== input.clientId) {
      throw new AppError('No autorizado para modificar este pedido', 403);
    }

    const next = input.paymentMethod as PaymentMethod;
    if (!Object.values(PaymentMethod).includes(next)) {
      throw new AppError('Método de pago no válido', 400);
    }

    if (order.status === OrderStatus.CANCELLED) {
      throw new AppError('Este pedido fue cancelado', 409);
    }

    if (order.status !== OrderStatus.PENDING) {
      throw new AppError(
        'El comercio ya aceptó tu pedido y el método de pago no puede cambiarse.',
        409
      );
    }

    if (
      order.paymentStatus === PaymentStatus.PAID ||
      order.paymentStatus === PaymentStatus.REFUNDED
    ) {
      throw new AppError(
        'Este pedido ya fue pagado. Si necesitas otro método, solicita la ' +
          'cancelación y el reembolso.',
        409
      );
    }

    const previousMethod = order.paymentMethod;
    if (previousMethod === next) return order;

    // Que el método nuevo sea *ofrecible* se comprueba antes de tocar
    // nada: cambiar a efectivo un pedido que supera el tope, o a línea
    // con la pasarela caída, dejaría el pedido peor de lo que estaba.
    if (next === PaymentMethod.CASH_ON_DELIVERY) {
      const f = order.finance;
      await pricingService.assertCashEligible({
        customerTotal: f?.customerTotal ?? order.total,
        businessPayout: f?.businessPayout ?? order.businessPayout,
        driverPayout: f?.driverPayout ?? order.driverPayout,
      });
    } else {
      const { isOnlinePaymentAvailable } = await import('./payments');
      if (!isOnlinePaymentAvailable()) {
        throw new AppError('El pago en línea no está disponible por el momento.', 422);
      }
    }

    // Primero se cierra lo viejo, después se abre lo nuevo. En este orden
    // nunca existen dos cobros vivos para el mismo pedido, ni siquiera
    // durante el instante que separa las dos escrituras.
    const { paymentService } = await import('./payments');
    await paymentService.voidOpenPayments(
      order._id.toString(),
      `Cambio de método de pago: ${previousMethod} → ${next}`
    );

    order.paymentMethod = next;
    order.paymentStatus =
      next === PaymentMethod.CASH_ON_DELIVERY
        ? PaymentStatus.PENDING_CASH
        : PaymentStatus.PENDING;
    await order.save();

    if (next === PaymentMethod.CASH_ON_DELIVERY) {
      await paymentService.openCashPayment(order);
    }

    logSystemAudit({
      userId: input.clientId,
      role: UserRole.CLIENT,
      action: AuditAction.PAYMENT_METHOD_CHANGED,
      entity: 'order',
      entityId: order._id.toString(),
      severity: AuditSeverity.MEDIUM,
      description: `Método de pago cambiado de "${previousMethod}" a "${next}"`,
      metadata: {
        orderNumber: order.orderNumber,
        previousMethod,
        newMethod: next,
        amount: order.finance?.customerTotal ?? order.total,
        ...input.context,
      },
    }).catch(console.error);

    return order;
  }

}

export const orderService = new OrderService();
