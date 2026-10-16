import mongoose from 'mongoose';
import { Order, IOrder, IItemShortage, Business, Coupon, Driver, Product } from '../models';
import { shortagePublicView } from '../models/Order';
import { AppError } from '../middlewares';
import {
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
  OrderKind,
  UserRole,
  CancellationReason,
  CancelledBy,
  CouponScope,
  CouponType,
  ItemShortageStatus,
  ItemShortageReason,
  OrderTimelineAction,
  RefundStatus,
} from '../types';
import { AuditAction, AuditSeverity, logSystemAudit } from '../security';
import { emitToAdmin, emitToUser, getIO } from '../sockets/emitter';
import { orderEventPayload } from '../utils/merchantVisibility';
import { repriceShortage } from './pricing.service';
import { pricingConfigService } from './pricingConfig.service';
import { refundService } from './refund.service';
import { notificationService } from './notification.service';
import { orderTimelineService } from './orderTimeline.service';
import { orderService, ITEM_SHORTAGE_WINDOW_MS } from './order.service';
import { announceShortage } from './itemShortageEvents';

/** Estados en los que el comercio puede avisar de un producto que falta. */
const REPORTABLE_STATUSES: OrderStatus[] = [OrderStatus.ACCEPTED, OrderStatus.PREPARING];

/** Cuántas veces reintenta el barrido ejecutar una aceptación antes de rendirse a lo manual. */
const MAX_APPLY_ATTEMPTS = 20;

export interface ReportShortageInput {
  reason: ItemShortageReason;
  note?: string;
  items: Array<{ itemId: string; missingQty: number }>;
}

const lineId = (line: unknown): string => String((line as { _id: unknown })._id);

/**
 * Producto que falta con aprobación del cliente (v1: solo efectivo).
 *
 * El comercio avisa, el cliente decide en `ITEM_SHORTAGE_WINDOW_MS` y:
 *  · ACEPTA → un `Refund` PARTIAL con el reparto ya calculado (`repriceShortage`)
 *    descuenta lo que falta; el pedido sigue y el efectivo a cobrar es el neto.
 *  · RECHAZA o NO RESPONDE → el pedido se cancela por el camino normal con
 *    `BUSINESS_OUT_OF_STOCK` y `cancelledBy: BUSINESS`, aunque lo pulse el
 *    cliente: la causa es del comercio y así lo cuentan las analíticas.
 *
 * No añade estados al pedido (`VALID_TRANSITIONS` sigue siendo la única
 * fuente): solo frena PREPARING → READY mientras esté sin resolver. Cada paso
 * es una escritura condicionada (nunca leer → validar → guardar), así que dos
 * respuestas simultáneas, o una respuesta contra el vencimiento, tienen una sola
 * ganadora.
 */
export class ItemShortageService {
  // ── Aviso del comercio ───────────────────────────────────────────────

  async report(
    orderId: string,
    actor: { userId: string; role: string },
    body: ReportShortageInput
  ): Promise<ReturnType<typeof shortagePublicView>> {
    if (!mongoose.isValidObjectId(orderId)) throw new AppError('Pedido no encontrado', 404);
    const order = await Order.findById(orderId);
    if (!order) throw new AppError('Pedido no encontrado', 404);

    if (order.kind === OrderKind.ERRAND || !order.businessId) {
      throw new AppError('Un mandado no tiene comercio que reporte faltantes', 409, 'SHORTAGE_NOT_APPLICABLE');
    }
    if (order.paymentMethod !== PaymentMethod.CASH_ON_DELIVERY) {
      throw new AppError(
        'Por ahora el producto faltante solo se descuenta en pedidos en efectivo. En un pedido pagado en línea, cancela y se le devuelve el dinero.',
        422,
        'SHORTAGE_CASH_ONLY'
      );
    }
    if (!REPORTABLE_STATUSES.includes(order.status)) {
      throw new AppError(
        'Solo puedes avisar de un producto que falta mientras aceptas o preparas el pedido, antes de marcarlo listo.',
        409,
        'SHORTAGE_BAD_STATUS'
      );
    }
    if (order.scheduledFor && !order.scheduledActivatedAt) {
      throw new AppError('Este pedido programado todavía no se activa', 409, 'SHORTAGE_BAD_STATUS');
    }
    if (order.paymentStatus !== PaymentStatus.PENDING_CASH) {
      throw new AppError('El efectivo de este pedido ya no está pendiente', 409, 'SHORTAGE_BAD_STATUS');
    }
    if (order.itemShortage) {
      throw new AppError(
        'Este pedido ya tuvo una consulta por un producto que falta. Solo se permite una por pedido.',
        409,
        'SHORTAGE_ALREADY_REPORTED'
      );
    }

    // ── Las líneas: existen, sin duplicados, cantidades dentro de lo pedido ──
    const missing: Array<{ index: number; missingQty: number }> = [];
    const seen = new Set<string>();
    for (const entry of body.items) {
      if (seen.has(entry.itemId)) {
        throw new AppError('Una línea del pedido está repetida', 422, 'SHORTAGE_BAD_ITEMS');
      }
      seen.add(entry.itemId);
      const index = order.items.findIndex((line) => lineId(line) === entry.itemId);
      if (index < 0) throw new AppError('Una de las líneas no pertenece a este pedido', 422, 'SHORTAGE_BAD_ITEMS');
      const line = order.items[index];
      if (!Number.isInteger(entry.missingQty) || entry.missingQty < 1 || entry.missingQty > line.quantity) {
        throw new AppError(
          `La cantidad que falta de "${line.productName}" debe estar entre 1 y ${line.quantity}`,
          422,
          'SHORTAGE_BAD_ITEMS'
        );
      }
      missing.push({ index, missingQty: entry.missingQty });
    }

    // ── Recálculo con la versión de precios del pedido, nunca la vigente ──
    const finance = order.finance;
    const cfg = await pricingConfigService.getByVersion(finance.pricingConfigVersion);
    if (!cfg) {
      throw new AppError(
        'No se encontró la configuración de precios de este pedido. Cancela el pedido.',
        422,
        'ITEM_SHORTAGE_NOT_ALLOWED'
      );
    }

    // Sobre qué línea descontaba el cupón de plataforma: `finance` solo guarda el total.
    let platformCouponScope: CouponScope | null = null;
    if (order.couponId) {
      const coupon = await Coupon.findById(order.couponId).select('scope type');
      if (coupon) {
        platformCouponScope = coupon.type === CouponType.FREE_DELIVERY ? CouponScope.DELIVERY : coupon.scope;
      }
    }

    const [prior, refunded, inFlight] = await Promise.all([
      refundService.allocatedSoFar(order._id),
      refundService.refundedTotal(order._id),
      refundService.hasInFlight(order._id),
    ]);
    if (refunded > 0 || inFlight) {
      throw new AppError(
        'Este pedido tiene un reembolso aplicado o en curso: el faltante no se puede calcular encima.',
        409,
        'ITEM_SHORTAGE_PRIOR_REFUND'
      );
    }

    const repriced = repriceShortage({
      finance,
      items: order.items.map((line) => ({ totalPrice: line.totalPrice, quantity: line.quantity })),
      missing,
      cfg,
      platformCouponScope,
      prior,
    });

    const now = new Date();
    const shortage = {
      _id: new mongoose.Types.ObjectId(),
      status: ItemShortageStatus.PENDING_CLIENT,
      reason: body.reason,
      ...(body.note ? { note: body.note } : {}),
      items: missing.map(({ index, missingQty }) => ({
        itemId: lineId(order.items[index]),
        productName: order.items[index].productName,
        quantity: order.items[index].quantity,
        missingQty,
      })),
      requestedAt: now,
      expiresAt: new Date(now.getTime() + ITEM_SHORTAGE_WINDOW_MS),
      respondedAt: null,
      refundAmount: repriced.refundAmount,
      allocation: repriced.allocation,
      after: repriced.after,
      appliedAt: null,
      applyAttempts: 0,
      lastApplyError: null,
      requestedBy: new mongoose.Types.ObjectId(actor.userId),
      respondedBy: null,
    };

    // Una sola ronda por pedido, decidida DENTRO de la escritura: dos avisos
    // simultáneos (dos pantallas del mismo comercio) tienen una sola ganadora.
    const claimed = await Order.findOneAndUpdate(
      {
        _id: order._id,
        status: { $in: REPORTABLE_STATUSES },
        paymentMethod: PaymentMethod.CASH_ON_DELIVERY,
        paymentStatus: PaymentStatus.PENDING_CASH,
        kind: { $ne: OrderKind.ERRAND },
        itemShortage: { $exists: false },
      },
      { $set: { itemShortage: shortage } },
      { new: true }
    );
    if (!claimed || !claimed.itemShortage) {
      throw new AppError(
        'El pedido cambió o ya tiene una consulta por un producto que falta. Actualiza e inténtalo de nuevo.',
        409,
        'SHORTAGE_ALREADY_REPORTED'
      );
    }

    // El comercio declaró que no lo tiene: se agota en la carta. Si el cliente
    // acepta se queda así; si cancela, `onCancelled` no lo vuelve a encender.
    await this.markOutOfStock(claimed, claimed.itemShortage);

    orderTimelineService
      .record(claimed._id.toString(), OrderTimelineAction.ITEM_SHORTAGE_REPORTED, actor, {
        newValue: { shortageId: String(shortage._id), reason: body.reason, items: shortage.items },
      })
      .catch(console.error);

    announceShortage(claimed);
    notificationService
      .notifyItemShortageAsked(claimed.clientId.toString(), claimed._id.toString(), claimed.orderNumber, String(shortage._id))
      .catch(console.error);

    return shortagePublicView(null, claimed.itemShortage);
  }

  /**
   * Deja agotados los productos que el comercio declaró faltantes: sin
   * inventario (`stock: 0`) si lo llevaba, y sin disponibilidad en cualquier
   * caso. Misma semántica que «agotado» del panel (`productService.update`).
   * Mejor esfuerzo: el aviso ya quedó escrito y lo que falle aquí no lo deshace.
   */
  private async markOutOfStock(order: IOrder, shortage: IItemShortage): Promise<void> {
    const productIds = new Set<string>();
    for (const entry of shortage.items) {
      const line = order.items.find((l) => lineId(l) === entry.itemId);
      if (line) productIds.add(String(line.productId));
    }
    for (const id of productIds) {
      try {
        await Product.updateOne(
          { _id: id, stock: { $ne: null } },
          { $set: { stock: 0, isAvailable: false, unavailableUntil: null } }
        );
        await Product.updateOne({ _id: id, stock: null }, { $set: { isAvailable: false, unavailableUntil: null } });
      } catch (error) {
        console.error('[ItemShortage] No se pudo agotar el producto', id, error);
      }
    }
  }

  // ── Respuesta del cliente ────────────────────────────────────────────

  async respond(
    orderId: string,
    clientId: string,
    accept: boolean,
    actorContext: { ip?: string; userAgent?: string } = {}
  ): Promise<ReturnType<typeof shortagePublicView>> {
    if (!mongoose.isValidObjectId(orderId)) throw new AppError('Pedido no encontrado', 404);
    const now = new Date();

    // UNA escritura con todas las condiciones: solo el cliente del pedido, solo
    // mientras la consulta sigue sin responder y dentro del plazo. La segunda
    // respuesta concurrente, o la tardía, no cumple el filtro y recibe 409.
    const claimed = await Order.findOneAndUpdate(
      {
        _id: orderId,
        clientId,
        status: { $in: REPORTABLE_STATUSES },
        'itemShortage.status': ItemShortageStatus.PENDING_CLIENT,
        'itemShortage.expiresAt': { $gt: now },
      },
      {
        $set: {
          'itemShortage.status': accept ? ItemShortageStatus.ACCEPTED : ItemShortageStatus.REJECTED,
          'itemShortage.respondedAt': now,
          'itemShortage.respondedBy': new mongoose.Types.ObjectId(clientId),
        },
      },
      { new: true }
    );

    if (!claimed || !claimed.itemShortage) {
      const current = await Order.findOne({ _id: orderId, clientId }).select('status itemShortage');
      if (!current?.itemShortage) {
        throw new AppError('Este pedido no tiene ninguna consulta pendiente', 404, 'SHORTAGE_NOT_FOUND');
      }
      if (
        current.itemShortage.status === ItemShortageStatus.PENDING_CLIENT &&
        current.itemShortage.expiresAt.getTime() <= now.getTime()
      ) {
        throw new AppError('El tiempo para responder se acabó: el pedido se está cancelando.', 409, 'SHORTAGE_EXPIRED');
      }
      throw new AppError('Esta consulta ya fue resuelta.', 409, 'SHORTAGE_ALREADY_ANSWERED');
    }

    orderTimelineService
      .record(
        claimed._id.toString(),
        accept ? OrderTimelineAction.ITEM_SHORTAGE_ACCEPTED : OrderTimelineAction.ITEM_SHORTAGE_REJECTED,
        { userId: clientId, role: UserRole.CLIENT },
        { ip: actorContext.ip, userAgent: actorContext.userAgent, newValue: { shortageId: String(claimed.itemShortage._id) } }
      )
      .catch(console.error);

    announceShortage(claimed);
    const ownerId = await this.ownerOf(claimed);

    if (accept) {
      // Si algo falla a mitad la aceptación queda persistida (`accepted` con
      // `appliedAt: null`), el pedido sigue frenado en «preparando» y el
      // barrido reintenta con la misma clave. No se propaga: el cliente ya
      // decidió y esa decisión no se pierde por un fallo contable transitorio.
      await this.applyAccepted(claimed._id.toString());
      if (ownerId) {
        notificationService
          .notifyItemShortageResult(ownerId, claimed._id.toString(), claimed.orderNumber, 'accepted')
          .catch(console.error);
      }
    } else {
      await this.cancelForShortage(claimed._id.toString(), 'rejected');
      if (ownerId) {
        notificationService
          .notifyItemShortageResult(ownerId, claimed._id.toString(), claimed.orderNumber, 'rejected')
          .catch(console.error);
      }
    }

    const fresh = await Order.findById(claimed._id).select('itemShortage');
    return shortagePublicView(null, (fresh?.itemShortage ?? claimed.itemShortage) as IItemShortage);
  }

  // ── Ejecución del descuento (saga) ───────────────────────────────────

  /**
   * Ejecuta el descuento de una consulta `accepted` y deja `appliedAt`.
   * Idempotente: el `Refund` lleva la clave `shortage:<pedido>:<consulta>`, así
   * que reintentar nunca descuenta dos veces. Devuelve si quedó aplicado.
   */
  async applyAccepted(orderId: string): Promise<boolean> {
    const order = await Order.findById(orderId);
    const shortage = order?.itemShortage;
    if (!order || !shortage || shortage.status !== ItemShortageStatus.ACCEPTED) return false;
    if (shortage.appliedAt) return true;
    if (!REPORTABLE_STATUSES.includes(order.status)) return false;

    try {
      const refund = await refundService.issueItemShortage({
        orderId,
        shortageId: String(shortage._id),
        acceptedBy: shortage.respondedBy ? String(shortage.respondedBy) : undefined,
      });
      if (refund.status !== RefundStatus.COMPLETED) {
        throw new AppError('El descuento por el producto que falta no se completó', 409, 'SHORTAGE_NOT_COMPLETED');
      }
    } catch (error) {
      await this.recordApplyFailure(order, error);
      return false;
    }

    const marked = await Order.findOneAndUpdate(
      {
        _id: order._id,
        'itemShortage._id': shortage._id,
        'itemShortage.status': ItemShortageStatus.ACCEPTED,
        'itemShortage.appliedAt': null,
      },
      { $set: { 'itemShortage.appliedAt': new Date(), 'itemShortage.lastApplyError': null } },
      { new: true }
    );

    if (marked) await this.notifyDriverOfNewAmount(marked);
    return true;
  }

  private async recordApplyFailure(order: IOrder, error: unknown): Promise<void> {
    const message = (error as Error)?.message ?? String(error);
    console.error('[ItemShortage] No se pudo ejecutar el descuento', order._id.toString(), error);
    const updated = await Order.findOneAndUpdate(
      { _id: order._id, 'itemShortage.status': ItemShortageStatus.ACCEPTED, 'itemShortage.appliedAt': null },
      { $inc: { 'itemShortage.applyAttempts': 1 }, $set: { 'itemShortage.lastApplyError': message.slice(0, 300) } },
      { new: true }
    );
    const attempts = updated?.itemShortage?.applyAttempts ?? 0;
    // Una vez, al cruzar el umbral: de aquí en adelante lo resuelve una persona.
    if (attempts === MAX_APPLY_ATTEMPTS) {
      logSystemAudit({
        userId: 'system',
        role: 'system',
        action: AuditAction.SUSPICIOUS_ACTIVITY,
        entity: 'order',
        entityId: order._id.toString(),
        severity: AuditSeverity.HIGH,
        description: `Pedido ${order.orderNumber}: el descuento por el producto que falta no se pudo ejecutar tras ${attempts} intentos`,
        metadata: { orderId: order._id.toString(), lastError: message.slice(0, 200) },
      }).catch(console.error);
    }
  }

  /** Al repartidor, si el pedido ya es suyo: lo que cobra en la puerta cambió. */
  private async notifyDriverOfNewAmount(order: IOrder): Promise<void> {
    if (!order.driverId) return;
    const driver = await Driver.findById(order.driverId).select('userId');
    if (!driver) return;
    const net = await refundService.netOf(order);
    notificationService
      .notifyDriverCashAmountChanged(driver.userId.toString(), order._id.toString(), order.orderNumber, net.customerTotal)
      .catch(console.error);
  }

  // ── Cancelación por rechazo o vencimiento ────────────────────────────

  /**
   * Cancela el pedido por el camino normal, con el comercio como causa. El
   * rol «system» salta los permisos de cancelación del cliente en `PREPARING`
   * (la consulta existe precisamente para ese caso); `cancelledBy: BUSINESS`
   * hace que `businessAnalytics.lostByBusiness` lo cuente contra el comercio.
   * `onCancelled` devuelve stock (salvo los agotados a propósito) y revierte
   * lo que queda, con el neto del reembolso previo si lo hubiera.
   */
  private async cancelForShortage(orderId: string, outcome: 'rejected' | 'expired'): Promise<boolean> {
    try {
      const cancelled = await orderService.updateStatus(
        orderId,
        OrderStatus.CANCELLED,
        'system',
        'system',
        outcome === 'rejected'
          ? 'El cliente no aceptó seguir sin el producto que faltaba'
          : 'El cliente no respondió a tiempo por el producto que faltaba',
        {},
        CancellationReason.BUSINESS_OUT_OF_STOCK,
        { cancelledBy: CancelledBy.BUSINESS }
      );
      await this.broadcastStatus(cancelled);
      return true;
    } catch (error) {
      // Cancelado entretanto por otra vía: el objetivo ya se cumplió.
      const fresh = await Order.findById(orderId).select('status');
      if (fresh?.status === OrderStatus.CANCELLED) return true;
      console.error('[ItemShortage] No se pudo cancelar el pedido tras la consulta', orderId, error);
      return false;
    }
  }

  /** `order:status:changed` a quienes ya lo escuchan: aquí no hay controlador que lo emita. */
  private async broadcastStatus(order: IOrder): Promise<void> {
    const io = getIO();
    if (!io) return;
    const payload = orderEventPayload(order);
    emitToUser(order.clientId.toString(), 'order:status:changed', payload);
    if (order.driverId) {
      const driver = await Driver.findById(order.driverId).select('userId');
      if (driver) emitToUser(driver.userId.toString(), 'order:status:changed', payload);
    }
    if (order.businessId) io.to(`business:${order.businessId.toString()}`).emit('order:status:changed', payload);
    emitToAdmin(io, 'orders', 'order:status:changed', payload);
  }

  private async ownerOf(order: IOrder): Promise<string | null> {
    if (!order.businessId) return null;
    const business = await Business.findById(order.businessId).select('ownerId');
    return business ? business.ownerId.toString() : null;
  }

  // ── Barrido ──────────────────────────────────────────────────────────

  /**
   * Cada 30 s (ver `startItemShortageSweeper`):
   *  1. Vence las consultas sin respuesta y cancela el pedido.
   *  2. Reintenta las aceptadas cuyo descuento no llegó a ejecutarse.
   *  3. Termina las cancelaciones de rechazadas/vencidas que se quedaron a medias.
   * Sin estado en memoria: todo sale de lo persistido, así que un reinicio con
   * consultas en vuelo no pierde ninguna.
   */
  async sweep(now = new Date(), limit = 50): Promise<{ expired: number; applied: number; cancelled: number }> {
    const result = { expired: 0, applied: 0, cancelled: 0 };

    const due = await Order.find({
      'itemShortage.status': ItemShortageStatus.PENDING_CLIENT,
      'itemShortage.expiresAt': { $lte: now },
      status: { $in: REPORTABLE_STATUSES },
    })
      .select('_id')
      .limit(limit);
    for (const { _id } of due) {
      if (await this.expireOne(_id.toString(), now)) result.expired += 1;
    }

    const toApply = await Order.find({
      'itemShortage.status': ItemShortageStatus.ACCEPTED,
      'itemShortage.appliedAt': null,
      'itemShortage.applyAttempts': { $lt: MAX_APPLY_ATTEMPTS },
      status: { $in: REPORTABLE_STATUSES },
    })
      .select('_id')
      .limit(limit);
    for (const { _id } of toApply) {
      if (await this.applyAccepted(_id.toString())) result.applied += 1;
    }

    const toCancel = await Order.find({
      'itemShortage.status': { $in: [ItemShortageStatus.REJECTED, ItemShortageStatus.EXPIRED] },
      status: { $in: REPORTABLE_STATUSES },
    })
      .select('_id itemShortage.status')
      .limit(limit);
    for (const order of toCancel) {
      const outcome = order.itemShortage?.status === ItemShortageStatus.EXPIRED ? 'expired' : 'rejected';
      if (await this.cancelForShortage(order._id.toString(), outcome)) result.cancelled += 1;
    }

    return result;
  }

  private async expireOne(orderId: string, now: Date): Promise<boolean> {
    const claimed = await Order.findOneAndUpdate(
      {
        _id: orderId,
        status: { $in: REPORTABLE_STATUSES },
        'itemShortage.status': ItemShortageStatus.PENDING_CLIENT,
        'itemShortage.expiresAt': { $lte: now },
      },
      { $set: { 'itemShortage.status': ItemShortageStatus.EXPIRED, 'itemShortage.respondedAt': now } },
      { new: true }
    );
    if (!claimed) return false; // El cliente respondió en el último segundo, o el pedido ya se cerró.

    orderTimelineService
      .record(claimed._id.toString(), OrderTimelineAction.ITEM_SHORTAGE_EXPIRED, { userId: 'system', role: 'system' }, {
        newValue: { shortageId: String(claimed.itemShortage?._id) },
      })
      .catch(console.error);
    logSystemAudit({
      userId: 'system',
      role: 'system',
      action: AuditAction.ORDER_ITEM_SHORTAGE_RESPONDED,
      entity: 'order',
      entityId: claimed._id.toString(),
      severity: AuditSeverity.LOW,
      description: `Pedido ${claimed.orderNumber}: el cliente no respondió a tiempo por el producto que falta`,
      metadata: { orderId: claimed._id.toString(), outcome: 'expired' },
    }).catch(console.error);

    announceShortage(claimed);
    await this.cancelForShortage(claimed._id.toString(), 'expired');

    notificationService
      .notifyItemShortageExpired(claimed.clientId.toString(), claimed._id.toString(), claimed.orderNumber)
      .catch(console.error);
    const ownerId = await this.ownerOf(claimed);
    if (ownerId) {
      notificationService
        .notifyItemShortageResult(ownerId, claimed._id.toString(), claimed.orderNumber, 'expired')
        .catch(console.error);
    }
    return true;
  }
}

export const itemShortageService = new ItemShortageService();

// Barrido de proceso (mismo patrón que `businessReopen.service.ts`): PM2 corre
// una sola instancia. Lo que decide qué hacer vive en la base, no aquí: un
// reinicio no pierde ninguna consulta, solo retrasa su vencimiento unos segundos.
let timer: ReturnType<typeof setInterval> | null = null;

export function startItemShortageSweeper(intervalMs = 30_000): void {
  if (timer) return;
  timer = setInterval(() => {
    itemShortageService.sweep().catch((error) => console.error('[item-shortage-sweep]', error));
  }, intervalMs);
  timer.unref?.();
}

export function stopItemShortageSweeper(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
