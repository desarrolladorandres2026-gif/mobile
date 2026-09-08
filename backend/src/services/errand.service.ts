import { Order, IOrder, IOrderFinance, Driver } from '../models';
import { OrderKind, OrderStatus, PaymentMethod, PaymentStatus } from '../types';
import { AppError } from '../middlewares/errorHandler';
import { pricingService } from './pricing.service';
import { pricingConfigService } from './pricingConfig.service';
import { ledgerService } from './ledger.service';
import { logSystemAudit, AuditAction, AuditSeverity } from '../security';

/**
 * Mandados.
 *
 * Un mandado es un pedido sin comercio de origen: recoger algo de un sitio
 * cualquiera y llevarlo a otro. Reutiliza todo lo caro que ya existe —el
 * reparto en cascada, el seguimiento, los códigos de entrega, la evidencia
 * fotográfica— y solo añade lo que de verdad es distinto: qué hay que
 * comprar, dónde, y cuánto se puede gastar.
 *
 * ── Cómo se mueve el dinero ──
 *
 * El domiciliario adelanta la compra de su fondo rotatorio y ZIPP se lo
 * reembolsa al entregar. Es mejor experiencia para el cliente —paga el
 * total exacto y no un tope inflado— y por eso se eligió, pero pone dinero
 * de una persona en la calle. De ahí las tres defensas:
 *
 * 1. Se reserva el **tope**, no el estimado: el fondo tiene que cubrir el
 *    peor caso autorizado, o el domiciliario se queda a medias en la caja.
 * 2. El techo de exposición (`maxDriverCashDebt`) que ya limita el efectivo
 *    sin rendir cuenta también aquí. Un mandado grande es exactamente el
 *    mismo riesgo que un pedido en efectivo grande.
 * 3. Gastar por encima del tope se rechaza. El cliente autorizó una cifra
 *    y nadie puede subirla por él desde la calle.
 */

export interface CreateErrandInput {
  clientId: string;
  description: string;
  pickupAddress: string;
  pickupLatitude: number;
  pickupLongitude: number;
  deliveryAddress: string;
  deliveryLatitude: number;
  deliveryLongitude: number;
  estimatedCost: number;
  maxCost: number;
  notes?: string;
  recipient?: { name: string; phone: string; note?: string };
}

export class ErrandService {
  /**
   * Crea el mandado y le pone precio al viaje.
   *
   * La tarifa sale de la misma fórmula que un domicilio normal: el trabajo
   * del domiciliario es recorrer una distancia, y que en un extremo haya un
   * restaurante afiliado o la casa de la abuela no cambia el esfuerzo.
   */
  async create(input: CreateErrandInput): Promise<IOrder> {
    if (input.maxCost < input.estimatedCost) {
      throw new AppError(
        'El tope de gasto no puede ser menor que lo que calculas que costará',
        400
      );
    }

    const cfg = await pricingConfigService.getCurrent();

    const delivery = await pricingService.priceRoute(
      { lat: input.pickupLatitude, lng: input.pickupLongitude },
      { lat: input.deliveryLatitude, lng: input.deliveryLongitude },
      // La ciudad decide qué zona tarifaria aplica. Un mandado no tiene
      // comercio del que heredarla, así que se usa la de operación.
      'Garzón',
      cfg
    );

    // El cliente ve el estimado; el cobro final se ajusta al gasto real.
    const customerTotal = input.estimatedCost + delivery.customerFee;

    // ── La foto financiera ──
    //
    // Un mandado necesita `finance` por la misma razón que cualquier otro
    // pedido: reembolsos, liquidaciones y extractos leen esta foto y no los
    // campos sueltos, precisamente para que un cambio de tarifas de mañana
    // no reescriba lo que se cobró ayer. Sin ella, un mandado cancelado
    // caía por la rama de "pedido antiguo sin snapshot" y no devolvía nada.
    const finance: IOrderFinance = {
      productSubtotal: input.estimatedCost,
      merchantCommission: 0,
      customerServiceFee: 0,
      deliveryCustomerFee: delivery.customerFee,
      driverDeliveryPayout: delivery.driverPayout,
      deliveryMargin: delivery.customerFee - delivery.driverPayout,
      tip: 0,
      merchantFundedDiscount: 0,
      platformFundedDiscount: 0,
      taxPayable: 0,
      businessPayout: 0,
      driverPayout: delivery.driverPayout,
      platformGrossRevenue: delivery.customerFee - delivery.driverPayout,
      platformPromotionExpense: 0,
      platformNetRevenueBeforeOperatingCosts: delivery.customerFee - delivery.driverPayout,
      customerTotal,
      currency: 'COP',
      pricingConfigVersion: cfg.version,
      appliedCommissionBps: 0,
    };

    const order = await Order.create({
      kind: OrderKind.ERRAND,
      clientId: input.clientId,
      // Sin comercio: es la diferencia que define un mandado.
      businessId: undefined,
      items: [],
      // Nace listo para recoger. Los estados intermedios —aceptado, en
      // preparación— existen porque hay una cocina detrás decidiendo y
      // cocinando; en un mandado no hay nada que preparar ni nadie que
      // acepte. Dejarlo en PENDING sería esperar a un actor que no existe.
      status: OrderStatus.READY,
      // Siempre en línea: el efectivo aquí significaría que el cliente le
      // paga al domiciliario lo que el domiciliario ya adelantó, y nadie
      // podría comprobar cuánto costó de verdad.
      paymentMethod: PaymentMethod.ONLINE,
      paymentStatus: PaymentStatus.PENDING,

      errand: {
        description: input.description,
        pickupAddress: input.pickupAddress,
        pickupLocation: {
          type: 'Point',
          coordinates: [input.pickupLongitude, input.pickupLatitude],
        },
        estimatedCost: input.estimatedCost,
        maxCost: input.maxCost,
      },

      deliveryAddress: input.deliveryAddress,
      deliveryLocation: {
        type: 'Point',
        coordinates: [input.deliveryLongitude, input.deliveryLatitude],
      },
      recipient: input.recipient,
      notes: input.notes,

      subtotal: input.estimatedCost,
      deliveryFee: delivery.customerFee,
      deliveryDistanceKm: delivery.distanceKm,
      zoneId: delivery.zoneId,
      discount: 0,
      tip: 0,
      tax: 0,
      // Sin comercio no hay comisión de venta: ZIPP gana el margen del
      // viaje y nada más. Cobrar comisión sobre lo que el cliente compró en
      // una tienda ajena sería cobrar por algo que ZIPP no vendió.
      platformCommission: 0,
      businessPayout: 0,
      driverPayout: delivery.driverPayout,
      total: customerTotal,
      pricingConfigVersion: cfg.version,
      finance,
    });

    // Reconocerlo en los libros ahora, no al entregar. Un mandado sin
    // asiento es un cobro al cliente que la contabilidad no ve venir, y el
    // día que se cancele no habrá nada que revertir.
    try {
      await ledgerService.recordErrandPlaced({
        orderId: order._id,
        estimatedCost: input.estimatedCost,
        customerFee: delivery.customerFee,
        driverPayout: delivery.driverPayout,
        pricingConfigVersion: cfg.version,
      });
    } catch (error) {
      // Igual que en `orderService.create`: nunca dejar un pedido sin sus
      // libros. Antes de deshacerlo no hay nada más que limpiar —todavía no
      // hay domiciliario, ni cupón, ni cobro abierto.
      await Order.deleteOne({ _id: order._id });
      throw error;
    }

    return order;
  }

  /**
   * El domiciliario declara lo que gastó de verdad.
   *
   * Sin evidencia esto sería un campo donde escribir cualquier número, así
   * que se exige la referencia de la foto del recibo. El tope es un límite
   * duro: el cliente autorizó una cifra y nadie puede subirla por él desde
   * la calle.
   */
  async declareCost(
    orderId: string,
    driverUserId: string,
    actualCost: number,
    receiptUrl: string
  ): Promise<IOrder> {
    const order = await Order.findById(orderId);
    if (!order || order.kind !== OrderKind.ERRAND) {
      throw new AppError('Mandado no encontrado', 404);
    }

    const driver = await Driver.findOne({ userId: driverUserId }).select('_id');
    if (!driver || order.driverId?.toString() !== driver._id.toString()) {
      throw new AppError('Este mandado no es tuyo', 403);
    }

    if (actualCost > order.errand!.maxCost) {
      throw new AppError(
        `Gastaste $${actualCost.toLocaleString('es-CO')} y el cliente autorizó hasta ` +
          `$${order.errand!.maxCost.toLocaleString('es-CO')}. Habla con soporte antes de continuar.`,
        422,
        'ERRAND_OVER_BUDGET'
      );
    }

    // Entregado significa cobrado. Cambiar la cifra después movería un
    // total que el cliente ya pagó, y eso es un reembolso —con su propio
    // expediente y su propia devolución—, no una corrección.
    if (order.status === OrderStatus.DELIVERED || order.status === OrderStatus.CANCELLED) {
      throw new AppError('Este mandado ya se cerró: el ajuste va por soporte', 409);
    }

    // Lo que estaba reconocido hasta ahora. La primera declaración corrige
    // el estimado; una segunda corrige a la primera.
    const previousCost = order.errand!.actualCost ?? order.errand!.estimatedCost;

    order.errand!.actualCost = actualCost;

    // El total del cliente se recalcula con el gasto real: paga lo que
    // costó más el viaje, ni un peso más.
    order.subtotal = actualCost;
    order.total = actualCost + order.deliveryFee;

    // La foto financiera se mueve con él: es la que leen el reembolso y la
    // liquidación, y dejarla con el estimado devolvería la cifra que nadie
    // llegó a pagar.
    order.finance.productSubtotal = actualCost;
    order.finance.customerTotal = order.total;

    await order.save();

    await ledgerService.recordErrandCostAdjusted({
      orderId: order._id,
      previousCost,
      actualCost,
      pricingConfigVersion: order.finance.pricingConfigVersion,
      driverId: order.driverId,
    });

    await logSystemAudit({
      userId: driverUserId,
      role: 'driver',
      action: AuditAction.SUSPICIOUS_ACTIVITY,
      entity: 'order',
      entityId: order._id.toString(),
      severity: AuditSeverity.LOW,
      description: `Mandado ${order.orderNumber}: gasto declarado de $${actualCost.toLocaleString('es-CO')}`,
      metadata: {
        actualCost,
        estimatedCost: order.errand!.estimatedCost,
        maxCost: order.errand!.maxCost,
        receiptUrl,
      },
    });

    return order;
  }

  /**
   * Lo que hay que retener del fondo del domiciliario al aceptar.
   *
   * Se reserva el **tope**, no el estimado: si el mercado sale más caro de
   * lo previsto, el domiciliario tiene que poder pagarlo sin quedarse a
   * medias en la caja delante de todo el mundo.
   */
  reservationFor(order: Pick<IOrder, 'kind' | 'errand'>): number {
    if (order.kind !== OrderKind.ERRAND || !order.errand) return 0;
    return order.errand.maxCost;
  }
}

export const errandService = new ErrandService();
