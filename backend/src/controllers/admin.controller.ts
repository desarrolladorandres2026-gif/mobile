import { Request, Response, NextFunction } from 'express';
import { adminService } from '../services/admin.service';
import { dailySummaryService } from '../services/dailySummary.service';
import { sendResponse, param, query, toCsv, csvFilename, type CsvColumn } from '../utils';
import { OrderEvidenceType } from '../types';
import { orderEvidenceService } from '../services/orderEvidence.service';
import { orderSecurityService } from '../services/orderSecurity.service';
import { resolveOrderAccess } from '../services/orderAccess.service';
import { OrderEvent, AuditAction, logAudit } from '../security';
import { AppError } from '../middlewares';

export class AdminController {
  /**
   * Descarga de informes en CSV.
   *
   * El permiso `reports:export` llevaba tiempo declarado en el RBAC sin que
   * ningún endpoint lo usara: se podía conceder, aparecía en los roles, y
   * no habilitaba nada. Esto es lo que habilita.
   *
   * Se envía como descarga y no como JSON porque el destinatario no es otro
   * programa: es la persona de contabilidad que necesita abrirlo en Excel.
   */
  private sendCsv<T>(res: Response, prefix: string, rows: T[], columns: Array<CsvColumn<T>>) {
    const body = toCsv(rows, columns);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${csvFilename(prefix)}"`);
    res.send(body);
  }

  /**
   * Todo lo que se sabe de una persona, en una sola pantalla.
   *
   * Atender un reclamo significaba abrir cinco pantallas y reconstruir la
   * historia a mano mientras el cliente esperaba al teléfono.
   */
  async userProfile360(req: Request, res: Response, next: NextFunction) {
    try {
      const { userProfile360Service } = await import('../services/userProfile360.service');
      const profile = await userProfile360Service.profile360(param(req, 'id'));
      sendResponse(res, 200, 'Historial del usuario', profile);
    } catch (error) { next(error); }
  }

  // ── Envíos dirigidos ──

  /** Cuánta gente alcanza un segmento, sin mandar nada todavía. */
  async previewCampaign(req: Request, res: Response, next: NextFunction) {
    try {
      const { campaignService } = await import('../services/campaign.service');
      const reach = await campaignService.preview(req.body.segment ?? {});
      sendResponse(res, 200, 'Alcance del segmento', { reach });
    } catch (error) { next(error); }
  }

  async sendCampaign(req: Request, res: Response, next: NextFunction) {
    try {
      const { campaignService } = await import('../services/campaign.service');
      const result = await campaignService.send(req.body.segment ?? {}, req.body.message);

      void logAudit(req, {
        action: AuditAction.SUSPICIOUS_ACTIVITY,
        entity: 'campaign',
        entityId: 'push',
        description: `Envío dirigido a ${result.targeted} personas: "${req.body.message.title}"`,
        metadata: { segment: req.body.segment, ...result },
      });

      sendResponse(res, 200, 'Notificaciones enviadas', result);
    } catch (error) { next(error); }
  }

  // ── Interruptores de funcionalidad ──
  async listFeatureFlags(req: Request, res: Response, next: NextFunction) {
    try {
      const { featureFlagService } = await import('../services/featureFlag.service');
      sendResponse(res, 200, 'Interruptores', await featureFlagService.list());
    } catch (error) { next(error); }
  }

  async saveFeatureFlag(req: Request, res: Response, next: NextFunction) {
    try {
      const { featureFlagService } = await import('../services/featureFlag.service');
      const flag = await featureFlagService.upsert(
        param(req, 'key'),
        req.body,
        req.user!._id.toString()
      );
      sendResponse(res, 200, 'Interruptor actualizado', flag);
    } catch (error) { next(error); }
  }

  async deleteFeatureFlag(req: Request, res: Response, next: NextFunction) {
    try {
      const { featureFlagService } = await import('../services/featureFlag.service');
      await featureFlagService.remove(param(req, 'key'));
      sendResponse(res, 200, 'Interruptor eliminado');
    } catch (error) { next(error); }
  }

  async exportOrders(req: Request, res: Response, next: NextFunction) {
    try {
      const { Order } = await import('../models');
      const filter: Record<string, unknown> = {};

      const from = query(req, 'from');
      const to = query(req, 'to');
      if (from || to) {
        filter.createdAt = {
          ...(from ? { $gte: new Date(from) } : {}),
          ...(to ? { $lte: new Date(to) } : {}),
        };
      }
      const status = query(req, 'status');
      if (status) filter.status = status;

      // Tope duro: un informe es un archivo que alguien abre, no un volcado
      // de la base. Sin límite, un rango amplio tumbaría el proceso
      // construyendo una cadena de cientos de megas en memoria.
      const orders = await Order.find(filter)
        .sort({ createdAt: -1 })
        .limit(10_000)
        .populate('businessId', 'name')
        .populate('clientId', 'name phone')
        .lean();

      this.sendCsv(res, 'pedidos', orders, [
        { header: 'Número', value: (o: any) => o.orderNumber },
        { header: 'Fecha', value: (o: any) => o.createdAt },
        { header: 'Estado', value: (o: any) => o.status },
        { header: 'Negocio', value: (o: any) => o.businessId?.name },
        { header: 'Cliente', value: (o: any) => o.clientId?.name },
        { header: 'Teléfono', value: (o: any) => o.clientId?.phone },
        { header: 'Método de pago', value: (o: any) => o.paymentMethod },
        { header: 'Estado del pago', value: (o: any) => o.paymentStatus },
        { header: 'Subtotal', value: (o: any) => o.finance?.subtotal ?? o.subtotal },
        { header: 'Domicilio', value: (o: any) => o.finance?.deliveryFee ?? o.deliveryFee },
        { header: 'Descuento', value: (o: any) => o.discount },
        { header: 'Propina', value: (o: any) => o.tip },
        { header: 'Total', value: (o: any) => o.finance?.customerTotal ?? o.total },
        { header: 'Comisión plataforma', value: (o: any) => o.finance?.merchantCommission ?? o.platformCommission },
        { header: 'Pago al negocio', value: (o: any) => o.finance?.businessPayout ?? o.businessPayout },
        { header: 'Pago al domiciliario', value: (o: any) => o.finance?.driverPayout ?? o.driverPayout },
        { header: 'Dirección', value: (o: any) => o.deliveryAddress },
        { header: 'Entregado', value: (o: any) => o.deliveredAt },
      ]);
    } catch (error) { next(error); }
  }

  async exportUsers(req: Request, res: Response, next: NextFunction) {
    try {
      const { User } = await import('../models');
      const filter: Record<string, unknown> = {};
      const role = query(req, 'role');
      if (role) filter.role = role;

      const users = await User.find(filter)
        .select('name phone email role isActive isVerified isBlocked createdAt')
        .sort({ createdAt: -1 })
        .limit(10_000)
        .lean();

      this.sendCsv(res, 'usuarios', users, [
        { header: 'Nombre', value: (u: any) => u.name },
        { header: 'Teléfono', value: (u: any) => u.phone },
        { header: 'Correo', value: (u: any) => u.email },
        { header: 'Rol', value: (u: any) => u.role },
        { header: 'Activo', value: (u: any) => (u.isActive ? 'Sí' : 'No') },
        { header: 'Verificado', value: (u: any) => (u.isVerified ? 'Sí' : 'No') },
        { header: 'Bloqueado', value: (u: any) => (u.isBlocked ? 'Sí' : 'No') },
        { header: 'Alta', value: (u: any) => u.createdAt },
      ]);
    } catch (error) { next(error); }
  }

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
      const { phone, email } = req.body;
      const user = await adminService.overrideUserContact(
        param(req, 'id'),
        {
          phone: typeof phone === 'string' ? phone : undefined,
          email: typeof email === 'string' ? email : undefined,
        },
        req.user!,
        req
      );
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
