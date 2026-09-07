import { Request, Response, NextFunction } from 'express';
import { adminService } from '../services/admin.service';
import { dailySummaryService } from '../services/dailySummary.service';
import { sendResponse, param, query } from '../utils';
import { OrderEvidenceType } from '../types';
import { orderEvidenceService } from '../services/orderEvidence.service';
import { orderSecurityService } from '../services/orderSecurity.service';
import { resolveOrderAccess } from '../services/orderAccess.service';
import { OrderEvent } from '../security';
import { AppError } from '../middlewares';

export class AdminController {
  async getDashboard(req: Request, res: Response, next: NextFunction) {
    try {
      const stats = await adminService.getDashboardStats();
      sendResponse(res, 200, 'Dashboard obtenido', stats);
    } catch (error) { next(error); }
  }

  async getFinancials(req: Request, res: Response, next: NextFunction) {
    try {
      const period = (query(req, 'period') || 'today') as 'today' | 'week' | 'month';
      const summary = await adminService.getFinancialSummary(period);
      sendResponse(res, 200, 'Resumen financiero', summary);
    } catch (error) { next(error); }
  }

  async getRevenueChart(req: Request, res: Response, next: NextFunction) {
    try {
      const days = Number(query(req, 'days')) || 30;
      const data = await adminService.getRevenueChart(Math.min(days, 365));
      sendResponse(res, 200, 'Datos de ingresos', data);
    } catch (error) { next(error); }
  }

  async getDailySummary(req: Request, res: Response, next: NextFunction) {
    try {
      const summary = await dailySummaryService.generate(query(req, 'date'));
      sendResponse(res, 200, 'Resumen diario', summary);
    } catch (error) { next(error); }
  }

  // ── Users ──

  async getUsers(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await adminService.getUsers(
        query(req, 'role'),
        query(req, 'search'),
        Number(query(req, 'page')) || 1,
        Number(query(req, 'limit')) || 20
      );
      sendResponse(res, 200, 'Usuarios obtenidos', result.users, result.meta);
    } catch (error) { next(error); }
  }

  async toggleUser(req: Request, res: Response, next: NextFunction) {
    try {
      const user = await adminService.toggleUserActive(param(req, 'id'), req.user!, req);
      sendResponse(res, 200, `Usuario ${user.isActive ? 'activado' : 'desactivado'}`, user);
    } catch (error) { next(error); }
  }

  async updateUserRole(req: Request, res: Response, next: NextFunction) {
    try {
      const user = await adminService.updateUserRole(param(req, 'id'), req.body.role, req.user!, req);
      sendResponse(res, 200, 'Rol de usuario actualizado', user);
    } catch (error) { next(error); }
  }

  // ── Seguridad y Acceso ──

  async createStaffUser(req: Request, res: Response, next: NextFunction) {
    try {
      const user = await adminService.createStaffUser(req.body, req.user!, req);
      sendResponse(res, 201, 'Cuenta administrativa creada', user);
    } catch (error) { next(error); }
  }

  async assignPosition(req: Request, res: Response, next: NextFunction) {
    try {
      const user = await adminService.assignPosition(param(req, 'id'), req.body.positionId || null, req.user!, req);
      sendResponse(res, 200, 'Cargo asignado', user);
    } catch (error) { next(error); }
  }

  async assignRoles(req: Request, res: Response, next: NextFunction) {
    try {
      const user = await adminService.assignRoles(param(req, 'id'), req.body.roleIds || [], req.user!, req);
      sendResponse(res, 200, 'Roles asignados', user);
    } catch (error) { next(error); }
  }

  async getEffectiveAccess(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await adminService.getEffectiveAccess(param(req, 'id'));
      sendResponse(res, 200, 'Permisos efectivos', result);
    } catch (error) { next(error); }
  }

  async setUserStatus(req: Request, res: Response, next: NextFunction) {
    try {
      const status = req.body.status;
      if (!['active', 'inactive', 'blocked'].includes(status)) {
        return next(new AppError('Estado inválido. Usa active, inactive o blocked.', 400));
      }
      const user = await adminService.setUserStatus(param(req, 'id'), status, req.user!, req.body.reason, req);
      sendResponse(res, 200, 'Estado del usuario actualizado', user);
    } catch (error) { next(error); }
  }

  async resetUserPassword(req: Request, res: Response, next: NextFunction) {
    try {
      const { user, temporaryPassword } = await adminService.resetUserPassword(param(req, 'id'), req.user!, req);
      sendResponse(res, 200, 'Contraseña restablecida', { user, temporaryPassword });
    } catch (error) { next(error); }
  }

  async overrideUserContact(req: Request, res: Response, next: NextFunction) {
    try {
      const adminUserId = req.user?._id?.toString() || '';
      const { phone, email } = req.body;
      const user = await adminService.overrideUserContact(param(req, 'id'), { phone, email }, adminUserId, req);
      sendResponse(res, 200, 'Datos de contacto actualizados', user);
    } catch (error) { next(error); }
  }

  // ── Businesses ──

  async getBusinesses(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await adminService.getBusinesses(
        query(req, 'search'),
        query(req, 'category'),
        Number(query(req, 'page')) || 1,
        Number(query(req, 'limit')) || 20
      );
      sendResponse(res, 200, 'Negocios obtenidos', result.businesses, result.meta);
    } catch (error) { next(error); }
  }

  async toggleBusiness(req: Request, res: Response, next: NextFunction) {
    try {
      const business = await adminService.toggleBusinessActive(param(req, 'id'));
      sendResponse(res, 200, `Negocio ${business.isActive ? 'activado' : 'desactivado'}`, business);
    } catch (error) { next(error); }
  }

  async toggleBusinessFeatured(req: Request, res: Response, next: NextFunction) {
    try {
      const business = await adminService.toggleBusinessFeatured(param(req, 'id'));
      sendResponse(res, 200, `Negocio ${business.isFeatured ? 'destacado' : 'quitado de destacados'}`, business);
    } catch (error) { next(error); }
  }

  async deleteBusiness(req: Request, res: Response, next: NextFunction) {
    try {
      await adminService.deleteBusiness(param(req, 'id'));
      sendResponse(res, 200, 'Negocio eliminado');
    } catch (error) { next(error); }
  }

  // ── Orders ──

  async getAllOrders(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await adminService.getAllOrders({
        status: query(req, 'status'),
        city: query(req, 'city'),
        dateFrom: query(req, 'dateFrom'),
        dateTo: query(req, 'dateTo'),
        search: query(req, 'search'),
        page: Number(query(req, 'page')) || 1,
        limit: Number(query(req, 'limit')) || 20,
      });
      sendResponse(res, 200, 'Pedidos obtenidos', result.orders, result.meta);
    } catch (error) { next(error); }
  }

  // ── Trazabilidad de la entrega ──

  /**
   * Buscador de evidencias fotográficas.
   *
   * Las URLs que devuelve van firmadas y se generan en el momento: el
   * panel no guarda enlaces permanentes a la puerta de casa de nadie.
   */
  async getEvidences(req: Request, res: Response, next: NextFunction) {
    try {
      const type = query(req, 'type') as OrderEvidenceType | undefined;
      const result = await orderEvidenceService.search({
        orderId: query(req, 'orderId'),
        businessId: query(req, 'businessId'),
        driverId: query(req, 'driverId'),
        type: type && Object.values(OrderEvidenceType).includes(type) ? type : undefined,
        from: query(req, 'from'),
        to: query(req, 'to'),
        page: Number(query(req, 'page')) || 1,
        limit: Number(query(req, 'limit')) || 20,
      });
      sendResponse(res, 200, 'Evidencias obtenidas', result.evidences, result.meta);
    } catch (error) { next(error); }
  }

  /**
   * Expediente de seguridad de un pedido: estado de los dos códigos,
   * evidencias e historial de eventos.
   *
   * Nunca incluye los códigos en claro. Un administrador tiene que poder
   * saber si el código de entrega se usó, cuándo y quién lo validó —eso
   * resuelve una disputa— pero no necesita el secreto, y un panel que lo
   * muestra es un panel desde el que se filtra.
   */
  async getOrderSecurity(req: Request, res: Response, next: NextFunction) {
    try {
      const access = await resolveOrderAccess(param(req, 'id'), req.user!);
      const [security, evidences, events] = await Promise.all([
        orderSecurityService.viewFor(access).catch(() => null),
        orderEvidenceService.listForOrder(access),
        OrderEvent.find({ orderId: access.order._id.toString() })
          .sort({ timestamp: -1 })
          .limit(100),
      ]);

      sendResponse(res, 200, 'Seguridad del pedido', {
        orderId: access.order._id.toString(),
        orderNumber: access.order.orderNumber,
        status: access.order.status,
        pickup: security?.pickup ?? null,
        delivery: security?.delivery ?? null,
        evidences,
        events,
      });
    } catch (error) { next(error); }
  }

  // ── Commissions ──

  async getCommissions(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await adminService.getCommissions(
        query(req, 'status'),
        Number(query(req, 'page')) || 1,
        Number(query(req, 'limit')) || 20
      );
      sendResponse(res, 200, 'Comisiones obtenidas', result.commissions, result.meta);
    } catch (error) { next(error); }
  }

  // ── Driver Debts ──

  async getDriverDebts(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await adminService.getDriverDebts(
        query(req, 'status'),
        Number(query(req, 'page')) || 1,
        Number(query(req, 'limit')) || 20
      );
      sendResponse(res, 200, 'Deudas obtenidas', result.debts, result.meta);
    } catch (error) { next(error); }
  }

  // ── Driver actions ──

  async suspendDriver(req: Request, res: Response, next: NextFunction) {
    try {
      const driver = await adminService.suspendDriver(param(req, 'id'));
      sendResponse(res, 200, 'Domiciliario suspendido', driver);
    } catch (error) { next(error); }
  }

  async reactivateDriver(req: Request, res: Response, next: NextFunction) {
    try {
      const driver = await adminService.reactivateDriver(param(req, 'id'));
      sendResponse(res, 200, 'Domiciliario reactivado', driver);
    } catch (error) { next(error); }
  }
}

export const adminController = new AdminController();
