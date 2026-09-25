import mongoose from 'mongoose';
import { Order, IOrder, IOrderFinance, Business, Commission, Driver, Product, User, Payout, BusinessDocument } from '../models';
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
  OrderKind,
  CancellationReason,
  CancelledBy,
  DriverStatus,
  PayoutStatus,
  PayoutBeneficiary,
} from '../types';
import { OrderSecurity } from '../security/orderSecurity';
import { emitToUser } from '../sockets/emitter';
import { logSystemAudit, AuditAction, AuditSeverity } from '../security';
import { notificationService } from './notification.service';
import { pricingService, Quote } from './pricing.service';
import { couponService } from './coupon.service';
import { ledgerService } from './ledger.service';
import { payoutService } from './payout.service';
import { cashReconciliationService } from './cashReconciliation.service';
import { pricingConfigService } from './pricingConfig.service';
import { refundService, allocateRefund } from './refund.service';
import { errandService } from './errand.service';
import { orderSecurityService } from './orderSecurity.service';
import { orderTimelineService, TimelineContext } from './orderTimeline.service';
import { isOpenAt } from '../utils/businessHours';
import { ageOn, ADULT_AGE } from '../utils/age';
import { config } from '../config';

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

/** Estados sin salida en `VALID_TRANSITIONS`: el pedido ya no necesita a nadie. */
export const TERMINAL_ORDER_STATUSES: OrderStatus[] = (Object.keys(VALID_TRANSITIONS) as OrderStatus[])
  .filter((s) => VALID_TRANSITIONS[s].length === 0);

/** Estados en los que aún se puede soltar al domiciliario (nunca tras la recogida). */
const UNASSIGNABLE_STATUSES: OrderStatus[] = [OrderStatus.ACCEPTED, OrderStatus.PREPARING, OrderStatus.READY];

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
    selectedExtras?: Array<{ name?: string; quantity?: number; groupId?: string; optionId?: string }>;
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
  /** Para quién es, si no es para quien paga. */
  recipient?: { name: string; phone: string; note?: string };
  /** Cuándo debe llegar, si no es cuanto antes. */
  scheduledFor?: Date | string;
  /** Solo en efectivo: si necesita vuelto y con cuánto paga. */
  cashPayment?: { needsChange: boolean; payingWith?: number };
}

/** Unidades apartadas para un pedido que todavía se está creando. */
interface StockReservation {
  productId: unknown;
  quantity: number;
  /** La reserva dejó el producto en cero y lo apagó. */
  switchedOff: boolean;
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
    proDeliveryDiscount: quote.proDeliveryDiscount,
    proServiceFeeDiscount: quote.proServiceFeeDiscount,
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

/** Quién cancela, según el papel de quien pidió el cambio. */
const CANCELLER_BY_ROLE: Record<string, CancelledBy> = {
  [UserRole.CLIENT]: CancelledBy.CLIENT,
  [UserRole.BUSINESS]: CancelledBy.BUSINESS,
  [UserRole.DRIVER]: CancelledBy.DRIVER,
  [UserRole.ADMIN]: CancelledBy.ADMIN,
};

/**
 * Cuánto hay que avisar para programar un pedido.
 *
 * Media hora es lo que tarda un negocio en organizarse. Menos que eso no es
 * programar, es pedir ahora con una promesa de puntualidad que nadie firmó.
 */
const MIN_SCHEDULE_LEAD_MS = 30 * 60 * 1000;

/** Hasta dónde se puede programar. Más allá, los precios ya no valen. */
const MAX_SCHEDULE_AHEAD_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Hasta dónde mira el barrido de programados.
 *
 * Dos horas cubren de sobra al negocio más lento; buscar más lejos solo
 * traería pedidos que hay que descartar en la misma vuelta.
 */
const MAX_PREP_LOOKAHEAD_MS = 2 * 60 * 60 * 1000;

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

  /**
   * Aparta las unidades del pedido antes de crearlo.
   *
   * La condición viaja dentro de la escritura, igual que en la reserva del
   * fondo del domiciliario: leer el stock, decidir y guardar son tres pasos
   * y entre ellos cabe otro pedido. Dos clientes pidiendo la última unidad
   * a la vez pasarían los dos la comprobación, y el negocio se enteraría al
   * ir a prepararlo.
   *
   * Los productos sin control de inventario (`stock: null`) se saltan: una
   * cocina no cuenta bandejas, y obligarla a hacerlo apagaría su carta.
   */
  private async reserveStock(
    items: Array<{ productId: unknown; quantity: number }>
  ): Promise<StockReservation[]> {
    const reserved: StockReservation[] = [];

    for (const item of items) {
      const claimed = await Product.findOneAndUpdate(
        { _id: item.productId, stock: { $ne: null, $gte: item.quantity } },
        { $inc: { stock: -item.quantity } },
        { new: true }
      );

      if (claimed) {
        // Al llegar a cero deja de ofrecerse solo. Sin esto seguiría en la
        // carta y el siguiente cliente pediría algo que ya no existe.
        const switchedOff = claimed.stock === 0;
        if (switchedOff) {
          await Product.updateOne({ _id: item.productId }, { isAvailable: false });
        }
        reserved.push({ productId: item.productId, quantity: item.quantity, switchedOff });
        continue;
      }

      // O no lleva inventario, o no queda suficiente. Se distinguen
      // mirando el producto: sin esto, un plato sin control de stock
      // parecería agotado.
      const product = await Product.findById(item.productId).select('name stock');
      if (product && product.stock !== null && product.stock !== undefined) {
        await this.undoReservation(reserved);
        throw new AppError(
          `Se agotó "${product.name}" mientras armabas el pedido. Quítalo para continuar.`,
          409,
          'OUT_OF_STOCK'
        );
      }
    }

    return reserved;
  }

  /**
   * Deshace una reserva de un pedido que al final no se creó.
   *
   * Es más que `releaseStock`: si la reserva fue la que dejó el producto en
   * cero, también lo había apagado, y devolver la unidad sin volver a
   * encenderlo dejaría en la carta un "agotado" con existencias. Solo se
   * reenciende lo que apagó esta misma reserva — un producto que el
   * comercio apagó a mano con unidades en la nevera no es asunto de este
   * pedido.
   */
  private async undoReservation(reserved: StockReservation[]): Promise<void> {
    if (!reserved.length) return;
    await this.releaseStock(reserved);

    const switchedOff = reserved.filter((r) => r.switchedOff).map((r) => r.productId);
    if (switchedOff.length) {
      await Product.updateMany(
        { _id: { $in: switchedOff }, stock: { $gt: 0 }, isAvailable: false },
        { $set: { isAvailable: true } }
      );
    }
  }

  /**
   * El pedido que ya existe para esta clave idempotente, si es de quien pide.
   *
   * La clave la genera el teléfono y la búsqueda antes no miraba de quién
   * era el pedido: un segundo cliente que mandara la misma clave recibía el
   * pedido del primero —dirección, teléfono y productos incluidos—. Ahora
   * una clave ajena es un conflicto, y la respuesta no dice nada del pedido
   * que la ocupa.
   *
   * `$locals.replayed` marca la respuesta como réplica sin cambiar la firma
   * de `create`, para que el controlador no vuelva a anunciar en la cocina,
   * a los domiciliarios y al panel un pedido que ya anunció.
   */
  private async findReplay(idempotencyKey: string, clientId: string): Promise<IOrder | null> {
    const existing = await Order.findOne({ idempotencyKey });
    if (!existing) return null;

    if (existing.clientId.toString() !== clientId) {
      throw new AppError(
        'Esta solicitud ya no es válida. Vuelve a abrir el pago para intentarlo de nuevo.',
        409,
        'IDEMPOTENCY_KEY_CONFLICT'
      );
    }

    existing.$locals.replayed = true;
    return existing;
  }

  /** Devuelve al inventario lo que se apartó para un pedido que no salió. */
  private async releaseStock(
    reserved: Array<{ productId: unknown; quantity: number }>
  ): Promise<void> {
    for (const item of reserved) {
      await Product.updateOne(
        { _id: item.productId, stock: { $ne: null } },
        { $inc: { stock: item.quantity } }
      );
    }
  }

  async create(input: CreateOrderInput): Promise<IOrder> {
    if (input.idempotencyKey) {
      const existing = await this.findReplay(input.idempotencyKey, input.clientId);
      if (existing) return existing;
    }

    const business = await Business.findById(input.businessId);
    if (
      !business ||
      !business.isActive ||
      !business.isApproved ||
      business.isArchived ||
      business.isSuspended
    ) {
      throw new AppError('Negocio no encontrado o inactivo', 404);
    }

    // Un comercio con un papel obligatorio vencido no recibe pedidos hasta renovarlo (mismo criterio
    // que el domiciliario con `assertDocumentsCurrent`). Un reenvío pendiente de revisión lo reabre.
    if (await BusinessDocument.exists({ businessId: business._id, status: { $in: ['approved', 'expired'] }, expiresAt: { $lt: new Date() } })) {
      throw new AppError('Negocio no encontrado o inactivo', 404);
    }

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
      // Sin sugerencia: el cliente ya decidió y nadie va a leer la
      // respuesta. Buscarla aquí serían consultas de más justo en el
      // momento en que el pedido tiene que salir rápido.
      suggest: false,
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

    // ── Con qué billete paga, si es en efectivo ──
    //
    // El validador ya exige que venga `cashPayment` en un pedido en
    // efectivo; aquí se comprueba lo único que el validador no puede
    // saber, porque el total todavía no existía en ese punto: que el
    // billete alcance para cubrirlo. Sin este tope, "necesito cambio de
    // $5.000" en un pedido de $40.000 llegaría al domiciliario como una
    // cifra negativa.
    if (isCash && input.cashPayment?.needsChange) {
      const payingWith = input.cashPayment.payingWith ?? 0;
      if (payingWith <= quote.customerTotal) {
        throw new AppError(
          `El billete con el que pagas debe ser mayor al total del pedido ` +
            `($${quote.customerTotal.toLocaleString('es-CO')}).`,
          400
        );
      }
    }

    // ── Programación ──
    //
    // Se valida contra el reloj del servidor, no contra el del teléfono: un
    // dispositivo con la hora mal puesta podría programar un pedido para
    // "dentro de una hora" que en realidad ya pasó, y quedaría esperando
    // un momento que nunca llega.
    const scheduledFor = input.scheduledFor ? new Date(input.scheduledFor) : null;

    if (scheduledFor) {
      const minimum = new Date(Date.now() + MIN_SCHEDULE_LEAD_MS);
      const maximum = new Date(Date.now() + MAX_SCHEDULE_AHEAD_MS);

      if (Number.isNaN(scheduledFor.getTime()) || scheduledFor < minimum) {
        throw new AppError(
          'Programa el pedido con al menos media hora de anticipación.',
          400,
          'SCHEDULE_TOO_SOON'
        );
      }
      if (scheduledFor > maximum) {
        throw new AppError('Solo puedes programar pedidos con una semana de anticipación.', 400);
      }
      // Antes solo se miraba el margen de tiempo, así que se podía programar
      // para el domingo a las 6 de la mañana en un local que abre a las 11:
      // el pedido se activaba solo y nadie lo recibía.
      if (!isOpenAt(business.schedule, scheduledFor, config.settlement.timezone)) {
        throw new AppError(
          'El negocio no atiende a esa hora. Elige otra franja.',
          400,
          'SCHEDULE_CLOSED'
        );
      }
    }

    // ── Productos con restricción de edad ──
    //
    // Dos barreras, no una:
    // - Aquí, la fecha de nacimiento declarada: sin ella no se crea el
    //   pedido, y con ella de un menor de 18 tampoco. Se guarda una sola
    //   vez (ver `authService.updateProfile`), así que no basta con
    //   cambiarla para pasar.
    // - En la puerta, la cédula: lo declarado no prueba nada. El pedido
    //   queda marcado para que el domiciliario la pida, y que conste que
    //   se le avisó.
    const restricted = await Product.exists({
      _id: { $in: quote.items.map((i) => i.productId) },
      requiresAgeVerification: true,
    });
    if (restricted) {
      const client = await User.findById(input.clientId).select('birthDate');
      if (!client?.birthDate) {
        throw new AppError(
          'Tu pedido tiene productos para mayores de 18. Agrega tu fecha de nacimiento para continuar.',
          400,
          'BIRTHDATE_REQUIRED'
        );
      }
      if (ageOn(client.birthDate) < ADULT_AGE) {
        throw new AppError(
          'Tu pedido tiene productos solo para mayores de 18. Quítalos para poder pedir.',
          403,
          'AGE_RESTRICTED'
        );
      }
    }

    // Se aparta el inventario antes de crear el pedido: si algo se agotó
    // mientras el cliente decidía, es mejor decírselo ahora que dejarle
    // pagar por algo que no hay.
    const reservedStock = await this.reserveStock(quote.items);

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
        recipient: input.recipient,
        cashPayment: isCash ? input.cashPayment : undefined,
        scheduledFor: scheduledFor,
        /**
         * La hora que se le prometió al cliente, congelada al crear.
         *
         * El campo existía en el modelo desde siempre y **nunca se
         * escribía**, así que la pregunta "¿cuántos pedidos llegaron a
         * tiempo?" no se podía responder: no había contra qué comparar
         * `deliveredAt`. Es el KPI del que cuelga todo lo demás.
         *
         * Se guarda el extremo alto del rango porque es el que se enseña,
         * y prometer el optimista sería incumplir a propósito. En un
         * pedido programado la cuenta arranca en la hora pedida, no ahora:
         * si no, un pedido para dentro de seis horas nacería tardísimo.
         */
        estimatedDelivery: new Date(
          (scheduledFor ? scheduledFor.getTime() : Date.now()) +
            quote.etaMinutesMax * 60_000
        ),
        requiresAgeVerification: !!restricted,
        deliveryLocation: {
          type: 'Point',
          coordinates: [input.deliveryLongitude, input.deliveryLatitude],
        },
        // Legacy mirrors, kept so existing clients and reports keep working.
        subtotal: quote.productSubtotal,
        deliveryFee: quote.deliveryCustomerFee,
        deliveryDistanceKm: quote.deliveryDistanceKm,
        zoneId: quote.zoneId,
        zoneVersion: quote.zoneVersion,
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
      // Lo apartado vuelve antes de cualquier otra cosa. En la carrera de
      // la misma clave —la red reintenta y las dos peticiones llegan a la
      // vez— las dos pasaron la búsqueda previa y las dos reservaron; la que
      // choca con el índice único devuelve el pedido del gemelo, y sin esta
      // línea se llevaba sus unidades con ella. Con cuatro reintentos
      // simultáneos se perdían tres.
      await this.undoReservation(reservedStock);

      if (error.code === 11000 && input.idempotencyKey) {
        const existing = await this.findReplay(input.idempotencyKey, input.clientId);
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
        await this.undoReservation(reservedStock);
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
      await this.undoReservation(reservedStock);
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
        order._id.toString(),
        order.orderNumber,
        business.name
      ),
      notificationService.notifyBusinessNewOrder(
        business.ownerId.toString(),
        order._id.toString(),
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
    // La cocina necesita ver TODOS los estados activos a la vez, no uno
    // solo: "pending,accepted,preparing,ready" pide una lista. El resto
    // de pantallas (como el historial del comercio) sigue mandando un
    // único estado o ninguno, y ese caso no cambia.
    if (status) {
      filter.status = status.includes(',') ? { $in: status.split(',') } : status;
    }

    // Un pedido programado no aparece en la cocina hasta que toca. Sin
    // esto, el negocio vería mañana a las ocho un pedido que hay que
    // entregar pasado mañana, y lo prepararía.
    filter.$or = [
      { scheduledFor: null },
      { scheduledFor: { $exists: false } },
      { scheduledActivatedAt: { $ne: null } },
    ];

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
    // Techo duro: sin él, un domiciliario podía pedir `?limit=999999999` y
    // forzar a Mongoose a materializar en memoria todo lo que hubiera en
    // estado `READY` sin asignar. Ver A11 de la auditoría.
    const cappedLimit = Math.min(Math.max(1, limit), 50);
    const skip = (page - 1) * cappedLimit;
    // Un mandado sin cobrar no se ofrece. Listarlo solo serviría para que
    // alguien lo tomara y se llevara un 409: no hay nada que pueda hacer
    // para arreglarlo, así que enseñárselo es enseñar un callejón.
    // `$ne` casa también con los pedidos anteriores a que `kind` existiera.
    const filter = {
      status: OrderStatus.READY,
      driverId: null,
      $or: [{ kind: { $ne: OrderKind.ERRAND } }, { paymentStatus: PaymentStatus.PAID }],
    };
    const [orders, total] = await Promise.all([
      Order.find(filter).sort({ createdAt: 1 }).skip(skip).limit(cappedLimit)
        .populate('businessId', 'name logo address phone location')
        // Sin `phone`: antes cualquier domiciliario veía el nombre y el
        // teléfono de clientes con los que no tenía ninguna relación de
        // servicio, incluso pedidos para los que la cascada de reparto ni
        // siquiera lo había ofertado (`dispatch.service.ts#canClaim`). El
        // teléfono se entrega recién en `assignDriver`.
        .populate('clientId', 'name'),
      Order.countDocuments(filter),
    ]);
    return { orders, meta: { page, limit: cappedLimit, total, totalPages: Math.ceil(total / cappedLimit) } };
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
    context: TimelineContext = {},
    cancellationCode?: CancellationReason,
    opts: { canRefund?: boolean } = {}
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

    // ── Un mandado comprado ya no se cancela ──
    //
    // Cancelar significa "esto no ha pasado", y en cuanto el domiciliario
    // declara el gasto ya ha pasado: el mercado está pagado con su dinero y
    // va en la moto. Cancelarlo le devolvería el fondo por unas compras que
    // sigue teniendo encima, o se lo dejaría descontado si no. No hay
    // versión buena, así que esto es un incidente y se resuelve con un
    // reembolso —total o parcial— que sí sabe repartir el coste.
    //
    // Vale también para el administrador. La excepción de soporte aquí no
    // ahorra trabajo: lo esconde.
    if (
      status === OrderStatus.CANCELLED &&
      order.kind === OrderKind.ERRAND &&
      order.errand?.actualCost != null
    ) {
      throw new AppError(
        'Este mandado ya está comprado y pagado por el domiciliario. ' +
          'Resuélvelo con un reembolso, no con una cancelación.',
        409,
        'ERRAND_ALREADY_PURCHASED'
      );
    }

    // ── Cancelar un pedido pagado emite un reembolso completo (D1) ──
    //
    // Con solo `orders:cancel`, Operaciones movería dinero por la pasarela.
    // Desde PREPARING el reembolso lo decide Finanzas (`refunds:create`);
    // en PENDING/ACCEPTED basta cancelar. El reembolso sigue saliendo solo de
    // `onCancelled`: no hay otra vía, así que no hay doble reembolso.
    if (
      userRole === UserRole.ADMIN &&
      status === OrderStatus.CANCELLED &&
      order.paymentStatus === PaymentStatus.PAID &&
      [OrderStatus.PREPARING, OrderStatus.READY, OrderStatus.ON_WAY].includes(order.status) &&
      !opts.canRefund
    ) {
      throw new AppError(
        'Cancelar este pedido pagado reembolsa al cliente y exige el permiso de reembolsos. Pide a Finanzas que lo cancele.',
        403,
        'REFUND_PERMISSION_REQUIRED'
      );
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
        // ── La prueba de recogida de un mandado es el recibo ──
        //
        // El código de recogida lo dicta el comercio, y aquí no hay
        // comercio: ese código no lo tiene nadie, así que exigirlo dejaría
        // al domiciliario atascado en la calle con el mercado en la mano.
        //
        // El recibo hace el mismo trabajo y además uno que el código no
        // hace: demuestra qué se compró y por cuánto. `declareCost` no
        // acepta la declaración sin la foto.
        if (order.kind === OrderKind.ERRAND) {
          if (order.errand?.actualCost == null) {
            throw new AppError(
              'Antes de marcar la recogida, registra lo que gastaste con la foto del recibo',
              409,
              'ERRAND_COST_REQUIRED'
            );
          }
        } else {
          await this.assertCodeConsumed(order._id.toString(), OrderCodeKind.PICKUP);
        }
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
      if (cancellationCode) patch.cancellationCode = cancellationCode;

      // Quién canceló se guarda en el pedido y no solo en el registro de
      // eventos. Es la pregunta que hace soporte en cada reclamo, y hasta
      // ahora había que reconstruirla leyendo la bitácora.
      patch.cancelledBy = CANCELLER_BY_ROLE[userRole] ?? CancelledBy.SYSTEM;
      patch.cancelledByUserId = userId;
    }

    const claimed = await Order.findOneAndUpdate(
      // `paymentStatus` viaja en el filtro: no puede cambiar entre la
      // comprobación de arriba y la escritura.
      { _id: order._id, status: previousStatus, paymentStatus: order.paymentStatus },
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

    // Listo para recoger: es el momento en que el pedido necesita a alguien
    // que lo lleve, y por tanto cuando arranca la oferta automática. No se
    // espera —calcular rutas contra Mapbox tarda— porque quien marca el
    // pedido listo es el comercio y no puede quedarse mirando una rueda.
    if (status === OrderStatus.READY && !claimed.driverId) {
      import('./dispatch.service')
        .then(({ startDispatch }) => startDispatch(claimed._id.toString()))
        .catch((err) => console.error('[Order] No se pudo iniciar el reparto:', err));
    }

    if (status === OrderStatus.DELIVERED) {
      // La invitación se paga cuando el invitado compra de verdad, no al
      // registrarse: pagar por un registro convierte el programa en una
      // máquina de crear cuentas vacías.
      import('./referral.service')
        .then(({ referralService }) => referralService.rewardIfFirstOrder(claimed))
        .catch((err) => console.error('[Referral] No se pudo pagar la invitación:', err));

      // Delivery no longer decides payment. A digital order is PAID only
      // when the gateway says so; a cash order becomes a reconciliation
      // obligation the driver has to remit and someone else has to verify.
      await this.onDelivered(claimed);
    }

    if (status === OrderStatus.CANCELLED) {
      // Un pedido cancelado deja de buscar domiciliario. Sin esto, el
      // barrido seguiría ofreciéndolo hasta que alguien lo aceptara. Va
      // ANTES de la contabilidad: el cambio de estado ya es un hecho y un
      // fallo del reembolso no puede dejar el pedido en oferta ni con
      // códigos vivos.
      const { stopDispatch } = await import('./dispatch.service');
      await stopDispatch(claimed._id.toString());
      // Un código sigue sirviendo hasta que algo lo invalida: sin esto, un
      // pedido cancelado podría cerrarse como entregado un rato después.
      await orderSecurityService.voidCodes(claimed._id.toString());

      // La cancelación ya está confirmada: un fallo aquí no se propaga como
      // si el estado no hubiera cambiado. Queda auditado y, si fue el
      // reembolso, con su fila `Refund` FAILED/PENDING (alerta `refund_failed`)
      // para que Finanzas lo reintente desde el panel.
      try {
        await this.onCancelled(claimed);
      } catch (err) {
        (claimed.$locals as Record<string, unknown>).cancelSideEffectsFailed = true;
        console.error('[Order] Falló un efecto de la cancelación:', err);
        await logSystemAudit({
          userId,
          role: userRole,
          action: AuditAction.SUSPICIOUS_ACTIVITY,
          entity: 'order',
          entityId: claimed._id.toString(),
          severity: AuditSeverity.HIGH,
          description: `Pedido ${claimed.orderNumber} cancelado, pero falló la reversión (reembolso/stock/fondo): ${(err as Error).message}`,
          metadata: { orderId: claimed._id.toString(), paymentStatus: claimed.paymentStatus },
        });
      }
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
   * Enseña al negocio los pedidos programados cuya hora se acerca.
   *
   * Un pedido programado existe desde que se paga, pero aparecer en la
   * cocina doce horas antes solo consigue que lo preparen doce horas antes.
   * Se libera con el margen que el propio negocio declara que tarda, más un
   * colchón para el viaje.
   */
  async activateScheduledOrders(): Promise<number> {
    const pending = await Order.find({
      scheduledFor: { $ne: null, $lte: new Date(Date.now() + MAX_PREP_LOOKAHEAD_MS) },
      scheduledActivatedAt: null,
      status: OrderStatus.PENDING,
    })
      .select('_id scheduledFor businessId clientId orderNumber')
      .limit(50)
      .populate('businessId', 'ownerId deliveryTime');

    let activated = 0;

    for (const order of pending) {
      const business = order.businessId as unknown as {
        _id: unknown;
        ownerId: unknown;
        deliveryTime?: number;
      };

      // El margen sale del tiempo que el propio negocio declara, no de un
      // número fijo: una pizzería y una droguería no necesitan lo mismo.
      const leadMs = ((business?.deliveryTime ?? 30) + 15) * 60 * 1000;
      if (order.scheduledFor!.getTime() - Date.now() > leadMs) continue;

      const claimed = await Order.findOneAndUpdate(
        { _id: order._id, scheduledActivatedAt: null },
        { $set: { scheduledActivatedAt: new Date() } },
        { new: true }
      );

      if (!claimed) continue;
      activated++;

      // Se avisa igual que a un pedido nuevo: para el negocio, a partir de
      // este momento es exactamente eso.
      if (business?.ownerId) {
        emitToUser(business.ownerId.toString(), 'order:incoming', {
          orderId: order._id.toString(),
          orderNumber: order.orderNumber,
          scheduledFor: order.scheduledFor,
        });
      }
    }

    return activated;
  }

  /**
   * Quita el pedido a un domiciliario que aceptó y no apareció.
   *
   * Aceptar y no ir es el fallo más caro de esta operación: el pedido deja
   * de ofrecerse a nadie más, el negocio tiene la comida hecha y el cliente
   * no ve avanzar nada. Sin esto, un teléfono que se queda sin batería
   * congela un pedido hasta que alguien lo mira a mano.
   *
   * Devuelve el fondo retenido por la misma razón y de la misma forma que
   * `onCancelled`: es dinero de una persona, apartado por un pedido que ya
   * no va a repartir.
   */
  async unassignDriver(
    orderId: string,
    reason: string,
    actor: { userId: string; role: string } = { userId: 'system', role: 'system' }
  ): Promise<IOrder | null> {
    const order = await Order.findById(orderId);
    if (!order?.driverId) return null;

    // Solo antes de recoger (D6). Después el pedido ya está en la moto y
    // quitárselo sería inventar un problema peor.
    if (!UNASSIGNABLE_STATUSES.includes(order.status)) return null;

    // Un mandado con el gasto declarado ya está comprado con dinero del
    // domiciliario: soltarlo le devolvería el tope por unas compras que sigue
    // teniendo encima.
    if (order.errand?.actualCost != null) {
      throw new AppError(
        'Este mandado ya está comprado por el domiciliario. Resuélvelo con un reembolso.',
        409,
        'ERRAND_ALREADY_PURCHASED'
      );
    }

    // Lo que `assignDriver` le descontó: el tope del mandado y/o el pago al
    // comercio en efectivo.
    const hold =
      errandService.reservationFor(order) +
      (order.paymentMethod === PaymentMethod.CASH_ON_DELIVERY
        ? order.finance?.businessPayout ?? order.businessPayout ?? 0
        : 0);

    // ── El devengo del domiciliario anterior ──
    //
    // Se elimina ANTES del reclamo para que, si no se puede, no se toque
    // nada. Un payout de pedido en línea nace PAYABLE y `settle()` lo reclama
    // sin mirar el estado del pedido, así que puede estar ya liquidado, o con
    // reversiones: en ese caso soltar al domiciliario le dejaría cobrando un
    // viaje que no hizo (`accrueForOrder` reutiliza el payout existente y el
    // nuevo se quedaría sin ninguno). No se reasigna en sitio porque no se
    // sabe todavía quién será el nuevo; se borra y `accrueForOrder` lo crea.
    const payoutFilter = {
      orderId: order._id,
      beneficiary: PayoutBeneficiary.DRIVER,
      driverId: order.driverId,
    };
    const removed = await Payout.deleteOne({
      ...payoutFilter,
      settlementId: null,
      reversedAmount: 0,
      status: { $in: [PayoutStatus.ACCRUED, PayoutStatus.PAYABLE] },
    });
    if (removed.deletedCount === 0 && (await Payout.exists(payoutFilter))) {
      throw new AppError(
        'No se puede soltar al domiciliario: su pago de este pedido ya está en una liquidación, tiene reversiones o no es eliminable.',
        409,
        'DRIVER_PAYOUT_LOCKED'
      );
    }

    // La condición va dentro del filtro: dos desasignaciones simultáneas →
    // solo una la aplica (y solo una devuelve el fondo). La devolución
    // pendiente viaja en la MISMA escritura: si el proceso cae antes del
    // `$inc`, un barrido la termina (`retryPendingFundReleases`).
    const token = new mongoose.Types.ObjectId().toString();
    const released = await Order.findOneAndUpdate(
      {
        _id: order._id,
        driverId: order.driverId,
        status: { $in: UNASSIGNABLE_STATUSES },
        'errand.actualCost': null,
      },
      {
        $set: {
          driverId: null,
          assignedAt: null,
          fundHoldReleasePending: hold > 0 ? { driverId: order.driverId, amount: hold, token } : null,
        },
      },
      { new: true }
    );

    if (!released) {
      // Perdió la carrera: el devengo borrado se recrea si el pedido sigue
      // teniendo domiciliario (idempotente).
      if (removed.deletedCount) {
        const fresh = await Order.findById(order._id);
        if (fresh?.driverId) await payoutService.accrueForOrder(fresh);
      }
      return null;
    }

    if (hold > 0) await this.applyFundHoldRelease(released._id, order.driverId, hold, token);

    // Vuelve a la cascada: el pedido que lo tenía ocupado ya no es suyo.
    await Driver.updateOne({ _id: order.driverId }, { $set: { status: DriverStatus.AVAILABLE } });

    // Avisarle, por los dos caminos que lo sueltan (soporte y el barrido de
    // "no recogió a tiempo"). Antes solo lo hacía el de soporte y solo por
    // socket, que la app ni escuchaba: seguía yendo al local por un pedido
    // que ya no era suyo. La push cubre la app en segundo plano.
    const releasedDriver = await Driver.findById(order.driverId).select('userId').lean();
    if (releasedDriver?.userId) {
      const driverUserId = String(releasedDriver.userId);
      emitToUser(driverUserId, 'order:driver:unassigned', {
        orderId: order._id.toString(),
        orderNumber: order.orderNumber,
        reason,
      });
      import('./push.service')
        .then(({ pushService }) =>
          pushService.sendToUser(driverUserId, {
            title: `Ya no tienes el pedido #${order.orderNumber}`,
            body: `${reason}. No vayas a recogerlo.`,
            data: { type: 'order_unassigned', orderId: order._id.toString() },
          })
        )
        .catch(console.error);
    }

    const isSystem = actor.role === 'system';
    await logSystemAudit({
      userId: actor.userId,
      role: actor.role,
      action: isSystem ? AuditAction.SUSPICIOUS_ACTIVITY : AuditAction.ORDER_DRIVER_UNASSIGNED,
      entity: 'order',
      entityId: order._id.toString(),
      severity: AuditSeverity.MEDIUM,
      description: `Domiciliario liberado del pedido ${order.orderNumber}: ${reason}`,
      metadata: { driverId: order.driverId.toString(), reason, previousStatus: order.status, refundedHold: hold },
    });

    orderTimelineService
      .record(order._id.toString(), OrderTimelineAction.DRIVER_UNASSIGNED, {
        userId: actor.userId,
        role: actor.role,
      })
      .catch(console.error);

    return released;
  }

  /**
   * Devuelve al fondo lo retenido, una sola vez.
   *
   * El token viaja dentro de la misma escritura que el `$inc` (y el filtro
   * exige que no esté ya): si el proceso cae después del `$inc` y antes de
   * limpiar la marca del pedido, el reintento del barrido no acredita dos
   * veces.
   */
  private async applyFundHoldRelease(
    orderId: unknown,
    driverId: unknown,
    amount: number,
    token: string
  ): Promise<void> {
    await Driver.updateOne(
      { _id: driverId, fundReleaseTokens: { $ne: token } },
      { $inc: { currentFund: amount }, $push: { fundReleaseTokens: { $each: [token], $slice: -100 } } }
    );
    await Order.updateOne(
      { _id: orderId, 'fundHoldReleasePending.token': token },
      { $set: { fundHoldReleasePending: null } }
    );
  }

  /** Barrido: termina las devoluciones de fondo que un caído dejó a medias. */
  async retryPendingFundReleases(limit = 20): Promise<number> {
    const pending = await Order.find({ fundHoldReleasePending: { $ne: null } })
      .select('+fundHoldReleasePending')
      .limit(limit)
      .lean();
    let done = 0;
    for (const o of pending) {
      const p = o.fundHoldReleasePending;
      if (!p?.driverId || !p.token) continue;
      try {
        await this.applyFundHoldRelease(o._id, p.driverId, p.amount, p.token);
        done++;
      } catch (err) {
        console.error('[Order] Falló el reintento de devolución de fondo:', err);
      }
    }
    return done;
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

    // ── Liquidación del mandado ──
    //
    // El domiciliario puso dinero suyo en la calle y aquí se le devuelve.
    // No espera a la liquidación del viernes a propósito: el cliente ya
    // pagó en línea —por eso los mandados no admiten efectivo— y hacerle
    // esperar por un dinero que ZIPP ya tiene es la forma más rápida de
    // que deje de aceptarlos.
    //
    // Se le repone el TOPE completo, no lo gastado: la parte que no gastó
    // nunca salió de su bolsillo y la que gastó se le reembolsa ahora, así
    // que el fondo vuelve exactamente a donde estaba. Su tarifa por el
    // viaje va aparte, por el camino normal del `Payout`.
    if (order.kind === OrderKind.ERRAND && order.errand && order.driverId) {
      // Si nunca declaró el gasto, se asume el estimado: es lo que el
      // cliente pagó, y dejar el pasivo abierto por falta de un formulario
      // convertiría un descuido en un descuadre permanente.
      const spent = order.errand.actualCost ?? order.errand.estimatedCost;

      await ledgerService.recordErrandAdvanceReimbursed({
        orderId: order._id,
        amount: spent,
        pricingConfigVersion: finance.pricingConfigVersion,
        driverId: order.driverId,
        currency: finance.currency,
      });
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
      // Un mandado repone el tope que se retuvo al aceptarlo. Va en el
      // mismo `$inc` que el resto por lo mismo que ellos: dos entregas
      // seguidas del mismo domiciliario no pueden pisarse.
      if (order.kind === OrderKind.ERRAND && order.errand) {
        increments.currentFund = order.errand.maxCost;
      }
      // Vuelve a estar disponible para la cascada. `$set` y no un segundo
      // `updateOne`: la misma escritura que abona el fondo lo libera, así
      // que no hay un instante en el que el fondo ya se acreditó pero el
      // domiciliario sigue marcado ocupado.
      await Driver.updateOne(
        { _id: order.driverId },
        { $inc: increments, $set: { status: DriverStatus.AVAILABLE } }
      );
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

    // El inventario apartado vuelve a la carta. Sin esto, cada cancelación
    // se comería unidades que nunca se vendieron y el negocio acabaría con
    // media carta apagada sin entender por qué.
    await this.releaseStock(
      order.items.map((item) => ({ productId: item.productId, quantity: item.quantity }))
    );

    // Un producto que había llegado a cero vuelve a ofrecerse si el
    // inventario devuelto lo dejó por encima.
    await Product.updateMany(
      { _id: { $in: order.items.map((i) => i.productId) }, stock: { $gt: 0 }, isAvailable: false },
      { $set: { isAvailable: true } }
    );

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
      //
      // Se devuelve exactamente lo que se retuvo al asignar, con la misma
      // fórmula. Antes era `businessPayout || subtotal`: con un pago al
      // comercio de 0 (pedido cubierto entero por un descuento) no se había
      // retenido nada y se le acreditaba el subtotal completo.
      const held = order.finance?.businessPayout ?? order.businessPayout ?? 0;
      if (held > 0) {
        await Driver.updateOne({ _id: order.driverId }, { $inc: { currentFund: held } });
      }
    }

    // Lo mismo para el mandado: se le retuvo el tope al aceptarlo y aquí se
    // le devuelve entero. Solo se llega hasta aquí sin haber comprado nada
    // —un mandado con el gasto ya declarado no se puede cancelar—, así que
    // devolver el tope completo le deja el fondo exactamente como estaba.
    if (order.driverId && order.kind === OrderKind.ERRAND && order.errand) {
      await Driver.updateOne(
        { _id: order.driverId },
        { $inc: { currentFund: order.errand.maxCost } }
      );
    }

    // Una cancelación también lo libera, tenga o no fondo que devolver
    // (un pedido en línea cancelado no movió su fondo, pero igual lo tenía
    // ocupado desde que lo aceptó).
    if (order.driverId) {
      await Driver.updateOne({ _id: order.driverId }, { $set: { status: DriverStatus.AVAILABLE } });
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
      notificationService.notifyOrderStatusChanged(order.clientId.toString(), order._id.toString(), order.orderNumber, status),
    ];

    if (order.driverId) {
      const driverUser = await Driver.findById(order.driverId).select('userId');
      if (driverUser) {
        notifyTargets.push(
          notificationService.notifyOrderStatusChanged(driverUser.userId.toString(), order._id.toString(), order.orderNumber, status)
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
                order._id.toString(),
                order.orderNumber,
                order.cancellationReason
              )
            : notificationService.notifyBusinessOrderDelivered(ownerId, order._id.toString(), order.orderNumber)
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

    // ── Turno de la cascada ──
    //
    // Mientras el reparto automático está en sus rondas estrechas, el
    // pedido es de quien lo tiene ofrecido. Sin esta puerta la cascada
    // sería decorativa: cualquiera podría adelantarse desde la lista de
    // disponibles y el orden por cercanía no decidiría nada.
    //
    // Un administrador pasa por encima. Asignar a mano es precisamente lo
    // que se hace cuando el reparto automático no está resolviendo, y
    // someterlo a la cola convertiría la herramienta de rescate en parte
    // del problema.
    if (actor?.role !== UserRole.ADMIN) {
      const { canClaim } = await import('./dispatch.service');
      if (!canClaim(order, driverId)) {
        throw new AppError(
          'Este pedido está ofrecido a otro domiciliario. Si nadie lo toma, te llegará a ti.',
          409,
          'OFFER_NOT_YOURS'
        );
      }
    }

    const driver = await Driver.findById(driverId).populate('userId', 'name');
    if (!driver) throw new AppError('Domiciliario no encontrado', 404);
    if (!driver.isApproved || !driver.isActive) throw new AppError('Domiciliario no disponible', 400);
    const { driverService } = await import('./driver.service');
    await driverService.assertDocumentsCurrent(driver._id.toString());
    // Misma puerta que para ponerse disponible: quien debe una verificación
    // vencida no recibe pedidos, aunque haya llegado hasta aquí con el
    // estado en verde de antes de que se la pidieran.
    await driverService.assertVerificationsCurrent(driver._id.toString());

    // Lo que se retiene del fondo del domiciliario. Vive fuera del bloque
    // porque, si el pedido se lo lleva otro, hay que devolverlo.
    let reserved = 0;

    // ── Adelanto de un mandado ──
    //
    // El domiciliario pone de su bolsillo lo que va a comprar, así que se
    // le retiene del fondo igual que en un pedido en efectivo — y por la
    // misma razón: es dinero suyo comprometido en un encargo concreto.
    //
    // Se reserva el TOPE y no el estimado: si el mercado sale más caro de
    // lo previsto, tiene que poder pagarlo sin quedarse a medias en la caja
    // delante de todo el mundo.
    if (order.kind === OrderKind.ERRAND && order.errand) {
      // Nadie sale a poner su dinero por un pedido que no está cobrado.
      // El equivalente al comercio que no cocina hasta que la pasarela
      // confirma, salvo que aquí quien arriesga es una persona y no un
      // restaurante — así que la puerta vale para todos, admin incluido.
      if (order.paymentStatus !== PaymentStatus.PAID) {
        throw new AppError(
          'Este mandado todavía no está pagado. En cuanto se confirme el cobro te lo ofrecemos.',
          409,
          'ERRAND_NOT_PAID'
        );
      }

      const cfg = await pricingConfigService.getCurrent();
      if (cfg.maxDriverCashDebt > 0) {
        const outstanding = await cashReconciliationService.outstandingFor(driver._id);
        if (outstanding + order.errand.maxCost > cfg.maxDriverCashDebt) {
          throw new AppError(
            'Este mandado supera tu límite de dinero comprometido. Liquida antes de tomarlo.',
            409,
            'CASH_DEBT_LIMIT'
          );
        }
      }

      reserved = order.errand.maxCost;

      const funded = await Driver.findOneAndUpdate(
        { _id: driver._id, currentFund: { $gte: reserved } },
        { $inc: { currentFund: -reserved } },
        { new: true }
      );

      if (!funded) {
        throw new AppError(
          `Fondo insuficiente: este mandado autoriza gastar hasta ` +
            `$${reserved.toLocaleString('es-CO')} y no tienes tanto disponible`,
          400,
          'ERRAND_FUND_INSUFFICIENT'
        );
      }
    }


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
      { $set: { driverId: driver._id, assignedAt: new Date() } },
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

    // El pedido ya tiene dueño: se acabó la búsqueda. Va antes que el
    // devengo porque lo urgente es que el barrido deje de ofrecerlo.
    //
    // Se pasa quién se lo quedó para que el libro de ofertas registre una
    // aceptación y no un vencimiento — y para que a los demás candidatos
    // les conste que lo perdieron, no que lo ignoraron.
    const { stopDispatch } = await import('./dispatch.service');
    await stopDispatch(claimed._id.toString(), driver._id.toString());

    // Deja de ofrecérsele nuevos pedidos mientras reparte este. Sin esto,
    // nada le impedía a la cascada seguir tocando la puerta de alguien que
    // ya está en camino a otra dirección.
    await Driver.updateOne({ _id: driver._id }, { $set: { status: DriverStatus.BUSY } });

    await payoutService.accrueForOrder(claimed);

    const driverUser = driver.userId as any;
    const driverName = driverUser?.name || 'El domiciliario';

    // El comercio también tiene que enterarse. Es quien va a tener a esa
    // persona en el mostrador pidiéndole el código de recogida, y hasta
    // ahora era el único de los tres que no recibía el aviso.
    const business = await Business.findById(order.businessId).select('ownerId');

    Promise.allSettled([
      notificationService.notifyDriverAssigned(order.clientId.toString(), order._id.toString(), driverName, order.orderNumber),
      notificationService.notifyDriverNewOrder(driverUser?._id?.toString() || driverId, order._id.toString(), order.orderNumber),
      business
        ? notificationService.notifyBusinessDriverAssigned(
            business.ownerId.toString(),
            order._id.toString(),
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

    const nextPaymentStatus =
      next === PaymentMethod.CASH_ON_DELIVERY
        ? PaymentStatus.PENDING_CASH
        : PaymentStatus.PENDING;

    // ── Cambio atómico del método ──
    //
    // El pedido se leyó al principio de esta función y desde entonces han
    // pasado varias comprobaciones y la invalidación de los intentos
    // abiertos. En ese hueco cabe el webhook que aprueba el pago en línea
    // que se está abandonando, y `order.save()` lo reescribía todo desde la
    // copia vieja: el pedido quedaba en "pendiente de efectivo" con el
    // dinero ya cobrado en Wompi, y el cliente lo pagaba otra vez en la
    // puerta. Las condiciones que hicieron válido el cambio viajan dentro
    // de la escritura, así que si algo se movió, no se aplica.
    const applied = await Order.findOneAndUpdate(
      {
        _id: order._id,
        status: OrderStatus.PENDING,
        paymentMethod: previousMethod,
        paymentStatus: { $nin: [PaymentStatus.PAID, PaymentStatus.REFUNDED] },
      },
      { $set: { paymentMethod: next, paymentStatus: nextPaymentStatus } },
      { new: true }
    );

    if (!applied) {
      throw new AppError(
        'El pedido cambió mientras procesábamos tu solicitud. Vuelve a consultarlo antes de reintentar.',
        409
      );
    }

    if (next === PaymentMethod.CASH_ON_DELIVERY) {
      await paymentService.openCashPayment(applied);
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

    return applied;
  }

}

export const orderService = new OrderService();
