import { Request, Response, NextFunction } from 'express';
import { orderService, driverService } from '../services';
import { sendResponse, param, query, clientIp, userAgent, clampLimit } from '../utils';
import { OrderStatus, UserRole } from '../types';
import { Business } from '../models';
import { AppError } from '../middlewares';

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
      if (io && !order.scheduledFor && !order.$locals?.replayed) {
        const business = await Business.findById(order.businessId).select('ownerId');
        if (business) {
          // El pedido va entero y poblado, con la misma forma que devuelve
          // el listado del comercio. Antes viajaba un resumen de cinco
          // campos sin `_id`, sin `items` y sin cliente: el panel lo metía
          // en su lista tal cual y la fila salía vacía —o rompía al leer
          // `_id`—, así que el pedido nuevo solo aparecía de verdad tras
          // refrescar. Empujar un pedido incompleto no es empujar nada.
          const payload = await orderService.getById(order._id.toString());

          // Las dos salas en una sola emisión. El socket de un comercio
          // está en las dos —la personal y la del negocio—, y dos `emit`
          // encadenados le entregaban el pedido por duplicado; Socket.IO
          // solo deduplica dentro de una misma emisión.
          io.to(`user:${business.ownerId.toString()}`)
            .to(`business:${order.businessId!.toString()}`)
            .emit('order:incoming', payload);
        }
        // Notify drivers and admin
        io.to('drivers').emit('order:available', { orderId: order._id.toString(), city: order.city });
        io.to('admin').emit('order:new', { orderId: order._id.toString(), orderNumber: order.orderNumber });
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
      const isBusiness = user.role === UserRole.BUSINESS && (await Business.exists({ _id: (order.businessId as any)._id ?? order.businessId, ownerId: user._id }));
      if (user.role !== UserRole.ADMIN && !isClient && !isDriver && !isBusiness) throw new AppError('No autorizado para ver este pedido', 403);
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
      const data = req.user!.role === UserRole.ADMIN
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
      if (req.user!.role === UserRole.BUSINESS) {
        const owned = await Business.exists({ _id: param(req, 'businessId'), ownerId: req.user!._id });
        if (!owned) return next(new AppError('No autorizado para ver pedidos de este comercio', 403));
      }
      const result = await orderService.getByBusiness(
        param(req, 'businessId'),
        query(req, 'status'),
        Number(query(req, 'page')) || 1,
        clampLimit(query(req, 'limit'), 100, 20)
      );
      sendResponse(res, 200, 'Pedidos del negocio', result.orders, result.meta);
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
      const order = await orderService.updateStatus(
        param(req, 'id'),
        req.body.status as OrderStatus,
        req.user!._id.toString(),
        req.user!.role,
        req.body.cancellationReason,
        { ip: clientIp(req), userAgent: userAgent(req) },
        req.body.cancellationCode
      );

      const io = req.app.get('io');
      if (io) {
        const payload = {
          orderId: order._id.toString(),
          orderNumber: order.orderNumber,
          status: order.status,
          driverId: order.driverId?.toString(),
          cancellationReason: order.cancellationReason,
        };
        io.to(`user:${order.clientId.toString()}`).emit('order:status:changed', payload);
        if (order.driverId) {
          io.to(`user:${order.driverId.toString()}`).emit('order:status:changed', payload);
        }
        // Un mandado no tiene comercio al que avisar: no hay nadie
        // preparando nada al otro lado.
        if (order.businessId) {
          io.to(`business:${order.businessId.toString()}`).emit('order:status:changed', payload);
        }
        io.to('admin').emit('order:status:changed', payload);
      }

      sendResponse(res, 200, 'Estado actualizado', order);
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
        const payload = {
          orderId: order._id.toString(),
          orderNumber: order.orderNumber,
          status: order.status,
          driverId: order.driverId?.toString(),
        };
        io.to(`user:${order.clientId.toString()}`).emit('order:driver:assigned', payload);
        if (order.driverId) {
          io.to(`user:${order.driverId.toString()}`).emit('order:driver:assigned', payload);
        }
        // El comercio es quien va a tener a esa persona en el mostrador
        // pidiendo el código de recogida; era el único de los tres que no
        // se enteraba de la asignación en vivo.
        if (order.businessId) {
          io.to(`business:${order.businessId.toString()}`).emit('order:driver:assigned', payload);
        }
        io.to('admin').emit('order:driver:assigned', payload);
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
