import { Types } from 'mongoose';
import {
  CashPaymentIncident,
  ICashPaymentIncident,
  CASH_INCIDENT_TRANSITIONS,
  CashReconciliation,
  Order,
  IOrder,
  IPayment,
  User,
} from '../models';
import { AppError } from '../middlewares';
import {
  CashIncidentType,
  CashIncidentStatus,
  CashIncidentResolution,
  LedgerAccount,
  PaymentStatus,
  UserRole,
} from '../types';
import { AuditAction, AuditSeverity, logSystemAudit } from '../security';
import { cashReconciliationService } from './cashReconciliation.service';
import { notificationService } from './notification.service';

/**
 * Expediente de los faltantes de efectivo.
 *
 * Cuando un domiciliario declara que el cliente no le pagó, pasan dos cosas
 * que conviene no confundir: la **obligación** sigue exactamente donde
 * estaba —en la `CashReconciliation` del pedido, intacta— y se abre una
 * **discusión** sobre ella, que es lo que gestiona este servicio.
 *
 * La separación es deliberada. Si declarar el faltante moviera el saldo, el
 * botón "no recibí" sería la forma más barata de no pagarle a ZIPP. Aquí
 * solo una persona con permisos de finanzas puede decidir que la deuda
 * desaparece, y esa decisión queda firmada.
 */
export class CashIncidentService {
  private assertTransition(current: CashIncidentStatus, next: CashIncidentStatus): void {
    const allowed = CASH_INCIDENT_TRANSITIONS[current] ?? [];
    if (!allowed.includes(next)) {
      throw new AppError(
        `Esta incidencia ya está ${current === CashIncidentStatus.RESOLVED ? 'resuelta' : 'cerrada'} ` +
          'y no admite más cambios.',
        409
      );
    }
  }

  /**
   * Abre la incidencia del faltante.
   *
   * Idempotente por el índice único `(orderId, type)`: dos declaraciones
   * simultáneas del mismo faltante chocan en la base y la segunda recupera
   * la primera, en vez de crear dos expedientes del mismo caso.
   *
   * No toca el libro mayor ni la conciliación. Ese es el punto entero.
   */
  async open(input: {
    order: IOrder;
    payment: IPayment;
    driverId: string | Types.ObjectId;
    note?: string;
  }): Promise<ICashPaymentIncident> {
    const { order, payment } = input;

    const existing = await CashPaymentIncident.findOne({
      orderId: order._id,
      type: CashIncidentType.CASH_NOT_RECEIVED,
    });
    if (existing) return existing;

    // El vínculo con el saldo que ya existe. Es opcional solo porque un
    // pedido sin domiciliario no llega a abrir conciliación — un caso que
    // `confirmCashCollection` ya rechaza antes de llegar aquí.
    const reconciliation = await CashReconciliation.findOne({ orderId: order._id }).select('_id');

    let incident: ICashPaymentIncident;
    try {
      incident = await CashPaymentIncident.create({
        orderId: order._id,
        paymentId: payment._id,
        driverId: input.driverId,
        reconciliationId: reconciliation?._id ?? null,
        // Del pedido, nunca de la petición del domiciliario.
        amount: order.finance?.customerTotal ?? order.total,
        currency: order.finance?.currency ?? payment.currency,
        type: CashIncidentType.CASH_NOT_RECEIVED,
        status: CashIncidentStatus.OPEN,
        driverNote: input.note?.slice(0, 500) ?? '',
      });
    } catch (error: any) {
      if (error?.code === 11000) {
        const raced = await CashPaymentIncident.findOne({
          orderId: order._id,
          type: CashIncidentType.CASH_NOT_RECEIVED,
        });
        if (raced) return raced;
      }
      throw error;
    }

    // Aviso a quien puede resolverlo. Sin esto la incidencia existiría
    // pero nadie se enteraría hasta abrir el panel por su cuenta, que es
    // lo mismo que no tener escalado.
    this.notifyFinanceAdmins(order, incident).catch(console.error);

    return incident;
  }

  /** Avisa a los administradores de finanzas de un faltante nuevo. */
  private async notifyFinanceAdmins(
    order: IOrder,
    incident: ICashPaymentIncident
  ): Promise<void> {
    const admins = await User.find({
      role: UserRole.ADMIN,
      isFinanceAdmin: true,
      isActive: true,
    }).select('_id');

    await Promise.allSettled(
      admins.map((admin) =>
        notificationService.notifySystem(
          admin._id.toString(),
          'Efectivo no recibido',
          `El domiciliario del pedido #${order.orderNumber} declaró que no recibió ` +
            `$${incident.amount.toLocaleString('es-CO')} en efectivo.`,
          {
            orderId: order._id.toString(),
            orderNumber: order.orderNumber,
            incidentId: incident._id.toString(),
            event: 'cash_incident_opened',
          }
        )
      )
    );
  }

  /**
   * Finanzas toma el caso.
   *
   * Idempotente: volver a marcarlo en revisión devuelve el mismo registro
   * sin escribir nada. No cambia dinero — solo dice que alguien lo está
   * mirando, que es información útil cuando hay varias personas en el panel.
   */
  async review(incidentId: string, adminUserId: string): Promise<ICashPaymentIncident> {
    const incident = await this.findOr404(incidentId);

    if (incident.status === CashIncidentStatus.UNDER_REVIEW) return incident;

    this.assertTransition(incident.status, CashIncidentStatus.UNDER_REVIEW);
    incident.status = CashIncidentStatus.UNDER_REVIEW;
    await incident.save();

    logSystemAudit({
      userId: adminUserId,
      role: UserRole.ADMIN,
      action: AuditAction.CASH_INCIDENT_REVIEWED,
      entity: 'cash_incident',
      entityId: incident._id.toString(),
      severity: AuditSeverity.LOW,
      description: `Incidencia de efectivo tomada para revisión`,
      metadata: {
        orderId: incident.orderId.toString(),
        driverId: incident.driverId.toString(),
        amount: incident.amount,
      },
    }).catch(console.error);

    return incident;
  }

  /**
   * Finanzas decide, y la decisión es lo único que puede mover el saldo.
   *
   * Las tres salidas son deliberadamente distintas en sus consecuencias:
   *
   *  · `DRIVER_FAVOR` — se le cree. Pasan tres cosas, y las tres hacen
   *    falta para que el pedido quede cerrado de verdad: se da de baja el
   *    efectivo en tránsito contra una cuenta de gasto por faltantes, se
   *    anula la conciliación con el mismo `void()` que ya usan las
   *    cancelaciones, y el cobro queda como fallido. Sin la primera, ZIPP
   *    dejaba de reclamar el dinero pero el balance seguía diciendo que
   *    había efectivo en la calle que nadie iba a traer nunca.
   *  · `DEBT_CONFIRMED` — responde por el efectivo. La conciliación sigue
   *    viva y el cobro pasa a pagado, porque frente al cliente el pedido
   *    se pagó: lo que queda es una deuda del domiciliario con ZIPP.
   *  · `CLOSED` — cierre administrativo. No mueve nada; es para lo que se
   *    arregló fuera del sistema y solo hace falta dejar constancia.
   *
   * Idempotente: repetir la misma resolución devuelve el mismo registro.
   * Intentar una *distinta* sobre algo ya resuelto se rechaza — reabrir una
   * decisión sobre dinero es una decisión nueva y merece su propio rastro.
   */
  async resolve(input: {
    incidentId: string;
    adminUserId: string;
    resolution: CashIncidentResolution;
    adminNote?: string;
    reject?: boolean;
  }): Promise<ICashPaymentIncident> {
    const incident = await this.findOr404(input.incidentId);

    const nextStatus = input.reject
      ? CashIncidentStatus.REJECTED
      : CashIncidentStatus.RESOLVED;

    if (incident.status === nextStatus && incident.resolution === input.resolution) {
      return incident;
    }

    this.assertTransition(incident.status, nextStatus);

    const previousStatus = incident.status;

    // El dinero se mueve antes de cerrar el expediente: si algo falla a
    // mitad, la incidencia sigue abierta y alguien puede reintentarlo. Al
    // revés quedaría cerrada sin haber hecho su efecto, que es la peor de
    // las dos inconsistencias posibles.
    if (input.resolution === CashIncidentResolution.DRIVER_FAVOR) {
      const writtenOff = await this.writeOffShortage(incident);
      await cashReconciliationService.void(incident.orderId);
      await this.settlePayment(incident, PaymentStatus.FAILED);
      incident.writtenOffAmount = writtenOff;
    } else if (input.resolution === CashIncidentResolution.DEBT_CONFIRMED) {
      await this.settlePayment(incident, PaymentStatus.PAID);
    }

    incident.status = nextStatus;
    incident.resolution = input.resolution;
    incident.adminNote = input.adminNote?.slice(0, 500) ?? incident.adminNote;
    incident.resolvedAt = new Date();
    incident.resolvedBy = new Types.ObjectId(input.adminUserId);
    await incident.save();

    logSystemAudit({
      userId: input.adminUserId,
      role: UserRole.ADMIN,
      action: AuditAction.CASH_INCIDENT_RESOLVED,
      entity: 'cash_incident',
      entityId: incident._id.toString(),
      // Alta siempre: las tres salidas deciden sobre dinero de alguien.
      severity: AuditSeverity.HIGH,
      description:
        `Incidencia de efectivo cerrada como "${input.resolution}" ` +
        `(${previousStatus} → ${nextStatus})`,
      metadata: {
        orderId: incident.orderId.toString(),
        driverId: incident.driverId.toString(),
        amount: incident.amount,
        previousStatus,
        newStatus: nextStatus,
        resolution: input.resolution,
        // Lo que le costó la decisión a ZIPP. Sin esta cifra, la auditoría
        // diría que alguien perdonó un faltante pero no cuánto.
        writtenOffAmount: incident.writtenOffAmount ?? 0,
        adminNote: input.adminNote?.slice(0, 200),
      },
    }).catch(console.error);

    this.notifyDriver(incident).catch(console.error);

    return incident;
  }

  /**
   * Cierra contablemente el faltante que ZIPP asume.
   *
   * El importe **se lee del propio libro mayor**, no se recalcula desde el
   * pedido ni se copia de la conciliación. Es deliberado: lo que hay que
   * dar de baja es exactamente lo que quedó vivo en `CASH_IN_TRANSIT`, y
   * cualquier fórmula paralela puede divergir de ese saldo —basta un
   * margen de reparto negativo, que la conciliación recorta a cero y el
   * asiento no—. Leyéndolo, la cuenta queda en cero por construcción en
   * vez de por coincidencia.
   *
   * Devuelve lo dado de baja, o 0 si no quedaba nada (un pedido ya
   * liquidado, o una resolución que se reintenta).
   */
  private async writeOffShortage(incident: ICashPaymentIncident): Promise<number> {
    const { ledgerService } = await import('./ledger.service');

    const enTransito = await ledgerService.accountBalance(LedgerAccount.CASH_IN_TRANSIT, {
      orderId: incident.orderId,
    });

    if (enTransito.balance <= 0) return incident.writtenOffAmount ?? 0;

    const order = await Order.findById(incident.orderId).select('finance');

    // La referencia sale del expediente, así que el índice único del libro
    // convierte el reintento en un no-op: reintentar la resolución no
    // vuelve a castigar la cuenta de gasto.
    await ledgerService.recordCashShortage({
      orderId: incident.orderId,
      amount: enTransito.balance,
      pricingConfigVersion: order?.finance?.pricingConfigVersion ?? 0,
      driverId: incident.driverId,
      reference: `incident:${incident._id.toString()}`,
      currency: order?.finance?.currency ?? incident.currency,
    });

    return enTransito.balance;
  }

  /**
   * Lleva el cobro del pedido a su estado final tras la decisión.
   *
   * Reutiliza la tabla de transiciones de `Payment`: `CASH_NOT_RECEIVED`
   * solo admite ir a `CASH_RECEIVED` (y de ahí a pagado) o a `FAILED`, así
   * que ninguna resolución puede dejar el cobro en un estado imposible.
   */
  private async settlePayment(
    incident: ICashPaymentIncident,
    target: PaymentStatus.PAID | PaymentStatus.FAILED
  ): Promise<void> {
    const { Payment } = await import('../models');
    const payment = await Payment.findById(incident.paymentId);
    if (!payment) return;
    if (payment.status === target) return;

    const now = new Date();

    if (target === PaymentStatus.PAID) {
      payment.statusHistory.push({
        status: PaymentStatus.CASH_RECEIVED,
        source: 'admin',
        message: 'Finanzas confirmó la deuda del domiciliario',
        at: now,
      });
      payment.processedAt = now;
      payment.statusMessage = 'Deuda de efectivo confirmada por finanzas';
    } else {
      payment.statusMessage = 'Efectivo no recibido, resuelto a favor del domiciliario';
    }

    payment.statusHistory.push({
      status: target,
      source: 'admin',
      message: payment.statusMessage,
      at: now,
    });
    payment.status = target;
    await payment.save();

    await Order.updateOne({ _id: incident.orderId }, { $set: { paymentStatus: target } });
  }

  /** El domiciliario tiene que enterarse de en qué quedó su caso. */
  private async notifyDriver(incident: ICashPaymentIncident): Promise<void> {
    const { Driver } = await import('../models');
    const driver = await Driver.findById(incident.driverId).select('userId');
    if (!driver) return;

    const order = await Order.findById(incident.orderId).select('orderNumber');
    const resuelto =
      incident.resolution === CashIncidentResolution.DRIVER_FAVOR
        ? 'Se resolvió a tu favor: ese saldo ya no está pendiente.'
        : incident.resolution === CashIncidentResolution.DEBT_CONFIRMED
        ? 'El saldo de ese pedido sigue pendiente de liquidación.'
        : 'El caso quedó cerrado.';

    await notificationService.notifySystem(
      driver.userId.toString(),
      'Revisamos tu reporte de efectivo',
      `Pedido #${order?.orderNumber ?? ''}: ${resuelto}`,
      {
        orderId: incident.orderId.toString(),
        incidentId: incident._id.toString(),
        event: 'cash_incident_resolved',
      }
    );
  }

  private async findOr404(incidentId: string): Promise<ICashPaymentIncident> {
    if (!Types.ObjectId.isValid(incidentId)) {
      throw new AppError('Incidencia no encontrada', 404);
    }
    const incident = await CashPaymentIncident.findById(incidentId);
    if (!incident) throw new AppError('Incidencia no encontrada', 404);
    return incident;
  }

  async list(status?: string, page = 1, limit = 20) {
    const filter: Record<string, unknown> = {};
    if (status) filter.status = status;

    const skip = (page - 1) * limit;
    const [incidents, total] = await Promise.all([
      CashPaymentIncident.find(filter)
        .sort({ status: 1, createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate({ path: 'driverId', populate: { path: 'userId', select: 'name phone' } })
        .populate({
          path: 'orderId',
          select: 'orderNumber total createdAt clientId',
          populate: { path: 'clientId', select: 'name phone' },
        })
        .populate('resolvedBy', 'name'),
      CashPaymentIncident.countDocuments(filter),
    ]);

    return { incidents, meta: { page, limit, total, totalPages: Math.ceil(total / limit) } };
  }

  forOrder(orderId: string | Types.ObjectId) {
    return CashPaymentIncident.findOne({ orderId });
  }
}

export const cashIncidentService = new CashIncidentService();
