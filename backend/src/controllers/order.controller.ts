import { Request, Response, NextFunction } from 'express';
import { orderService, driverService } from '../services';
import { sendResponse, param, query, clientIp, userAgent, clampLimit } from '../utils';
import { OrderStatus, UserRole, CancellationReason } from '../types';
import { Driver, BusinessPermission, BusinessRole } from '../models';
import { AppError } from '../middlewares';
import { can } from '../middlewares/auth';
import { Permission } from '../security';
import { customerFinanceView, merchantStaffOrderView } from '../services/profileMasking';
import { businessStaffService, staffOrderScope, isInStaffScope, type BusinessAccess } from '../services/businessStaff.service';
import { TERMINAL_ORDER_STATUSES } from '../services/order.service';
import { isMerchantVisible, orderEventPayload } from '../utils/merchantVisibility';
import { emitToAdmin } from '../sockets/emitter';

/**
 * `order.driverId` es el `_id` de `Driver`, no de `User` (O3). Emitir a
 * `user:<Driver._id>` no le llegaba a nadie: la sala personal de un socket
 * se une por `User._id` (`sockets/index.ts:112`), así que el repartidor no
 * recibía en vivo ni la asignación ni la cancelación por esta vía — solo
 * por el socket `driver:*`, si estaba conectado en ese momento.
 */
async function driverUserId(driverId: unknown): Promise<string | null> {
  if (!driverId) return null;
  const driver = await Driver.findById(driverId).select('userId');
  return driver ? driver.userId.toString() : null;
}

/**
 * El motivo del rechazo, si es uno de los nuestros.
 *
 * Un valor desconocido se descarta en silencio en vez de devolver 400: lo
 * que importa de esta petición es liberar el pedido, y tumbarla por una
 * etiqueta mal escrita dejaría a un cliente esperando por una cuestión de
 * estadística.
 */
const DECLINE_REASONS = ['too_far', 'busy', 'low_pay', 'other'] as const;
type DeclineReasonInput = (typeof DECLINE_REASONS)[number];

function parseDeclineReason(raw: unknown): DeclineReasonInput | undefined {
  return DECLINE_REASONS.includes(raw as DeclineReasonInput)
    ? (raw as DeclineReasonInput)
    : undefined;
}

export class OrderController {
  /**
   * Prices a cart without creating an order, so checkout can show a
   * breakdown that is guaranteed to match what will be charged.
   */
  async quote(req: Request, res: Response, next: NextFunction) {
    try {
      const quote = await orderService.quote({
        ...req.body,
        clientId: req.user!._id.toString(),
      });
      sendResponse(res, 200, 'Cotización calculada', quote);
    } catch (error) { next(error); }
  }

  async create(req: Request, res: Response, next: NextFunction) {
    try {
      const order = await orderService.create({ ...req.body, clientId: req.user!._id.toString() });

      const io = req.app.get('io');

      // Un pedido programado no se anuncia al crearse: lo hace el barrido
      // cuando llega su hora. Avisar ahora pondría en la cocina un pedido
      // para pasado mañana.
      //
      // Una réplica idempotente —el doble toque, el reintento de la red—
      // tampoco: ese pedido ya se anunció la primera vez, y repetirlo hacía
      // sonar la cocina dos veces y le ofrecía a los domiciliarios dos veces
      // el mismo pedido.
      // El anuncio al comercio vive en `orderService.announceToBusiness`: sale
      // cuando el pedido se puede aceptar (efectivo al crear; en línea al
      // cobrarse; programado al activarse), no aquí.
      if (io && !order.scheduledFor && !order.$locals?.replayed) {
        // Notify drivers and admin
        io.to('drivers').emit('order:available', { orderId: order._id.toString(), city: order.city });
        emitToAdmin(io, 'orders', 'order:new', { orderId: order._id.toString(), orderNumber: order.orderNumber });
      }

      sendResponse(res, 201, 'Pedido creado exitosamente', order);
    } catch (error) { next(error); }
  }

  async getById(req: Request, res: Response, next: NextFunction) {
    try {
      const order = await orderService.getById(param(req, 'id'));
      const user = req.user!;
      const isClient = order.clientId._id?.toString?.() === user._id.toString() || order.clientId.toString() === user._id.toString();
      const isDriver = order.driverId && (order.driverId as any).userId?._id?.toString?.() === user._id.toString();
      const businessAccess = user.role === UserRole.BUSINESS && !isClient && !isDriver && order.businessId
        ? await businessStaffService.accessFor(user._id.toString(), String((order.businessId as any)._id ?? order.businessId))
        : null;
      const isBusiness = !!businessAccess
        && businessAccess.permissions.includes(BusinessPermission.ORDERS_VIEW)
        && isInStaffScope(businessAccess.role, order, TERMINAL_ORDER_STATUSES);
      if (user.role !== UserRole.ADMIN && !isClient && !isDriver && !isBusiness) throw new AppError('No autorizado para ver este pedido', 403);
      if (isBusiness && businessAccess!.role !== BusinessRole.OWNER) {
        return sendResponse(res, 200, 'Pedido obtenido', merchantStaffOrderView(order, { terminal: TERMINAL_ORDER_STATUSES.includes(order.status) }));
      }
      // H3: el margen de ZIPP solo para quien ve comisiones.
      if (user.role === UserRole.ADMIN && !can(req, Permission.COMMISSIONS_VIEW)) {
        const plain = typeof (order as any).toObject === 'function' ? (order as any).toObject() : { ...(order as any) };
        plain.finance = customerFinanceView(plain.finance);
        return sendResponse(res, 200, 'Pedido obtenido', plain);
      }
      sendResponse(res, 200, 'Pedido obtenido', order);
    } catch (error) { next(error); }
  }

  async getMyOrders(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await orderService.getByClient(
        req.user!._id.toString(),
        Number(query(req, 'page')) || 1,
        clampLimit(query(req, 'limit'), 100, 20)
      );
      sendResponse(res, 200, 'Mis pedidos', result.orders, result.meta);
    } catch (error) { next(error); }
  }
  async receipt(req: Request, res: Response, next: NextFunction) {
    try {
      const order = await orderService.getById(param(req, 'id'));
      const isOwner = order.clientId._id?.toString?.() === req.user!._id.toString();
      if (req.user!.role !== UserRole.ADMIN && !isOwner) {
        throw new AppError('No autorizado para ver este comprobante', 403);
      }

      const base = {
        orderNumber: order.orderNumber, createdAt: order.createdAt, status: order.status, paymentStatus: order.paymentStatus,
        business: order.businessId, items: order.items, currency: order.finance.currency,
        valorProductos: order.finance.productSubtotal, valorDomicilio: order.finance.deliveryCustomerFee,
        descuentos: order.finance.merchantFundedDiscount + order.finance.platformFundedDiscount,
        propina: order.finance.tip, impuestos: order.finance.taxPayable,
        totalPagado: order.finance.customerTotal,
      };

      /**
       * `comisionZipp` y los subsidios solo se enseñan al admin.
       *
       * Este comprobante es lo que ve el **cliente**, y esos campos son el
       * margen interno de la plataforma sobre ese pedido concreto — cuánto
       * se queda ZIPP y cuánto puso el comercio para financiar un
       * descuento. Antes viajaban siempre: cualquier cliente que abriera
       * su propio comprobante podía ver la comisión que ZIPP le cobra a
       * cada negocio, dato que ni el propio comercio expone en su carta.
       */
      const data = req.user!.role === UserRole.ADMIN && can(req, Permission.COMMISSIONS_VIEW)
        ? {
            ...base,
            comisionZipp: order.finance.merchantCommission,
            subsidioZipp: order.finance.platformFundedDiscount,
            subsidioComercio: order.finance.merchantFundedDiscount,
          }
        : base;

      sendResponse(res, 200, 'Comprobante de pedido', data);
    } catch (error) { next(error); }
  }

  async getBusinessOrders(req: Request, res: Response, next: NextFunction) {
    try {
      // Dueño y personal con `orders:view`. Antes solo el dueño: el empleado
      // recibía el pedido por socket, la lista le respondía 403 y su panel
      // no podía hacer sonar nada.
      let access: BusinessAccess | null = null;
      if (req.user!.role === UserRole.BUSINESS) {
        access = await businessStaffService.accessFor(req.user!._id.toString(), param(req, 'businessId'));
        if (!access?.permissions.includes(BusinessPermission.ORDERS_VIEW)) {
          return next(new AppError('No autorizado para ver pedidos de este comercio', 403));
        }
      }
      const result = await orderService.getByBusiness(
        param(req, 'businessId'),
        query(req, 'status'),
        Number(query(req, 'page')) || 1,
        clampLimit(query(req, 'limit'), 100, 20),
        access ? staffOrderScope(access.role, TERMINAL_ORDER_STATUSES) : null
      );
      // El personal no ve el margen de ZIPP ni el pago al domiciliario: la
      // misma forma que ya le llega por socket (`announceToBusiness`).
      const orders = access && access.role !== BusinessRole.OWNER
        ? result.orders.map((order) => merchantStaffOrderView(order, { terminal: TERMINAL_ORDER_STATUSES.includes(order.status) }))
        : result.orders;
      sendResponse(res, 200, 'Pedidos del negocio', orders, result.meta);
    } catch (error) { next(error); }
  }

  /**
   * Cambia el método de pago de un pedido que el comercio aún no aceptó.
   *
   * Todas las reglas viven en el servicio —cuándo se puede, qué se
   * invalida, qué se abre—; aquí solo se identifica a quién pregunta.
   */
  async changePaymentMethod(req: Request, res: Response, next: NextFunction) {
    try {
      const order = await orderService.changePaymentMethod({
        orderId: param(req, 'id'),
        clientId: req.user!._id.toString(),
        paymentMethod: req.body.paymentMethod,
        context: { ip: clientIp(req), userAgent: userAgent(req) },
      });

      sendResponse(res, 200, 'Método de pago actualizado', {
        orderId: order._id.toString(),
        orderNumber: order.orderNumber,
        paymentMethod: order.paymentMethod,
        paymentStatus: order.paymentStatus,
        total: order.finance?.customerTotal ?? order.total,
      });
    } catch (error) { next(error); }
  }

  async updateStatus(req: Request, res: Response, next: NextFunction) {
    try {
      if (req.user!.role === UserRole.ADMIN) {
        // Cancelar y forzar un estado sin códigos son poderes distintos de `orders:update`.
        const target = req.body.status as OrderStatus;
        if (target === OrderStatus.CANCELLED && !can(req, Permission.ORDERS_CANCEL)) {
          throw new AppError('No tienes permiso para cancelar pedidos', 403);
        }
        if (target === OrderStatus.CANCELLED) {
          if (!req.body.cancellationCode) {
            throw new AppError('Indica el motivo de la cancelación (cancellationCode)', 400);
          }
          if (
            req.body.cancellationCode === CancellationReason.OTHER &&
            String(req.body.cancellationReason ?? '').trim().length < 10
          ) {
            throw new AppError('Con el motivo "otro" describe la razón en al menos 10 caracteres', 400);
          }
        }
        if (
          (target === OrderStatus.PICKED_UP || target === OrderStatus.DELIVERED) &&
          !can(req, Permission.ORDERS_MODIFY)
        ) {
          throw new AppError('No tienes permiso para forzar el estado de un pedido', 403);
        }
      }
      const order = await orderService.updateStatus(
        param(req, 'id'),
        req.body.status as OrderStatus,
        req.user!._id.toString(),
        req.user!.role,
        req.body.cancellationReason,
        { ip: clientIp(req), userAgent: userAgent(req) },
        req.body.cancellationCode,
        { canRefund: req.user!.role === UserRole.ADMIN && can(req, Permission.REFUNDS_CREATE) }
      );

      const io = req.app.get('io');
      if (io) {
        const payload = orderEventPayload(order);
        io.to(`user:${order.clientId.toString()}`).emit('order:status:changed', payload);
        const driverUid = await driverUserId(order.driverId);
        if (driverUid) {
          io.to(`user:${driverUid}`).emit('order:status:changed', payload);
        }
        // Un mandado no tiene comercio al que avisar: no hay nadie
        // preparando nada al otro lado.
        // Un pedido que el comercio nunca vio (en línea sin pagar) no le
        // concierne: su cancelación sería ruido sin nada que mostrar.
        if (order.businessId && isMerchantVisible(order)) {
          io.to(`business:${order.businessId.toString()}`).emit('order:status:changed', payload);
        }
        emitToAdmin(io, 'orders', 'order:status:changed', payload);
      }

      const partial = Boolean((order.$locals as Record<string, unknown> | undefined)?.cancelSideEffectsFailed);

      // ALTO 1 (auditoría 2026-10-01): esto devolvía el pedido entero, margen
      // de ZIPP y pago al domiciliario incluidos, a quien acaba de aceptarlo
      // o cancelarlo — el cliente y el personal del comercio. El mismo
      // recorte que ya tiene `getById`.
      let body: unknown = order;
      if (req.user!.role === UserRole.CLIENT) {
        const plain = typeof (order as any).toObject === 'function' ? (order as any).toObject() : { ...(order as any) };
        plain.finance = customerFinanceView(plain.finance);
        delete plain.driverPayout;
        body = plain;
      } else if (req.user!.role === UserRole.BUSINESS && order.businessId) {
        const access = await businessStaffService.accessFor(
          req.user!._id.toString(),
          String((order.businessId as any)._id ?? order.businessId)
        );
        if (access && access.role !== BusinessRole.OWNER) {
          body = merchantStaffOrderView(order, { terminal: TERMINAL_ORDER_STATUSES.includes(order.status) });
        }
      }

      sendResponse(
        res,
        200,
        partial ? 'Pedido cancelado, pero falló la reversión del cobro: queda pendiente para Finanzas' : 'Estado actualizado',
        body
      );
    } catch (error) { next(error); }
  }

  /**
   * El domiciliario rechaza una oferta.
   *
   * Decir que no explícitamente vale más que dejar que el reloj expire:
   * libera el pedido en el acto en vez de retener a la ronda entera los
   * cuarenta y cinco segundos. En un pueblo con pocos repartidores esa
   * diferencia es la comida caliente.
   */
  async declineOffer(req: Request, res: Response, next: NextFunction) {
    try {
      const driver = await driverService.getByUserId(req.user!._id.toString());
      const { declineOffer, annotateDecline } = await import('../services/dispatch.service');
      const reason = parseDeclineReason(req.body?.reason);

      // Con motivo y sin rechazo previo no puede distinguirse de un rechazo
      // normal, así que se hacen las dos cosas: soltar el pedido y anotar.
      // El caso habitual es el otro — la app suelta primero y explica
      // después—, y entonces `declineOffer` no encuentra ya al domiciliario
      // entre los candidatos y sale sin hacer nada. Anotar sí funciona.
      await declineOffer(param(req, 'id'), driver._id.toString(), reason);
      if (reason) await annotateDecline(param(req, 'id'), driver._id.toString(), reason);
      sendResponse(res, 200, 'Oferta rechazada');
    } catch (error) { next(error); }
  }

  async assignDriver(req: Request, res: Response, next: NextFunction) {
    try {
      let driverId: string;
      if (req.user!.role === UserRole.DRIVER) {
        const driver = await driverService.getByUserId(req.user!._id.toString());
        driverId = driver._id.toString();
      } else {
        driverId = req.body.driverId;
      }
      const order = await orderService.assignDriver(param(req, 'id'), driverId, {
        userId: req.user!._id.toString(),
        role: req.user!.role,
      });

      const io = req.app.get('io');
      if (io) {
        const payload = orderEventPayload(order);
        io.to(`user:${order.clientId.toString()}`).emit('order:driver:assigned', payload);
        const driverUid = await driverUserId(order.driverId);
        if (driverUid) {
          io.to(`user:${driverUid}`).emit('order:driver:assigned', payload);
        }
        // El comercio es quien va a tener a esa persona en el mostrador
        // pidiendo el código de recogida; era el único de los tres que no
        // se enteraba de la asignación en vivo.
        if (order.businessId) {
          io.to(`business:${order.businessId.toString()}`).emit('order:driver:assigned', payload);
        }
        emitToAdmin(io, 'orders', 'order:driver:assigned', payload);
      }

      sendResponse(res, 200, 'Domiciliario asignado', order);
    } catch (error) { next(error); }
  }

  async getAvailableOrders(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await orderService.getAvailableOrders(
        Number(query(req, 'page')) || 1,
        clampLimit(query(req, 'limit'), 100, 20)
      );
      sendResponse(res, 200, 'Pedidos disponibles', result.orders, result.meta);
    } catch (error) { next(error); }
  }

  async getDriverOrders(req: Request, res: Response, next: NextFunction) {
    try {
      const driver = await driverService.getByUserId(req.user!._id.toString());
      const result = await orderService.getDriverOrders(
        driver._id.toString(),
        Number(query(req, 'page')) || 1,
        clampLimit(query(req, 'limit'), 100, 20)
      );
      sendResponse(res, 200, 'Pedidos del domiciliario', result.orders, result.meta);
    } catch (error) { next(error); }
  }
}

export const orderController = new OrderController();
