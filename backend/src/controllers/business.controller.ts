import { Request, Response, NextFunction } from 'express';
import { businessService, payoutService } from '../services';
import { AppError } from '../middlewares';
import { PayoutStatus } from '../types';
import { sendResponse, param, query, toCsv, csvFilename } from '../utils';
import { UserRole } from '../types';
import { AuditAction, logAudit } from '../security';

export class BusinessController {
  /**
   * Descarga las ventas del comercio en CSV.
   *
   * Va al mismo sitio que el extracto que ya ve en pantalla, pero en un
   * archivo: quien lleva la contabilidad de un negocio pequeño no consulta
   * un panel, abre Excel. Reutiliza el generador del panel de
   * administración, con su defensa contra fórmulas y su separador para
   * configuración regional española.
   */
  async exportSales(req: Request, res: Response, next: NextFunction) {
    try {
      const businessId = param(req, 'id');
      const user = req.user!;

      // Un comercio solo descarga lo suyo. Sin esto, cambiar el id en la
      // URL entregaría las ventas del vecino.
      if (user.role !== UserRole.ADMIN) {
        const { Business } = await import('../models');
        const owns = await Business.exists({ _id: businessId, ownerId: user._id });
        if (!owns) throw new AppError('No autorizado', 403);
      }

      const from = query(req, 'from');
      const to = query(req, 'to');

      const { lines } = await payoutService.merchantStatementLines({
        businessId,
        ...(from ? { from: new Date(from) } : {}),
        ...(to ? { to: new Date(to) } : {}),
        // Tope alto pero finito: un informe es un archivo que alguien abre,
        // no un volcado de la base.
        limit: 5000,
      });

      const body = toCsv(lines, [
        { header: 'Pedido', value: (l: any) => l.orderNumber },
        { header: 'Fecha', value: (l: any) => l.createdAt },
        { header: 'Entregado', value: (l: any) => l.deliveredAt },
        { header: 'Estado', value: (l: any) => l.orderStatus },
        { header: 'Pago', value: (l: any) => l.paymentMethod },
        { header: 'Venta', value: (l: any) => l.productSubtotal },
        { header: 'Comisión ZIPP', value: (l: any) => l.merchantCommission },
        { header: 'Descuento asumido', value: (l: any) => l.merchantFundedDiscount },
        { header: 'Reversado', value: (l: any) => l.reversedAmount },
        { header: 'Neto a recibir', value: (l: any) => l.netAmount },
      ]);

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${csvFilename('ventas')}"`);
      res.send(body);
    } catch (error) { next(error); }
  }

  // ── Empleados del comercio ──

  async listStaff(req: Request, res: Response, next: NextFunction) {
    try {
      const { businessStaffService } = await import('../services/businessStaff.service');
      const { BusinessPermission } = await import('../models');

      await businessStaffService.assertCan(
        req.user!._id.toString(),
        param(req, 'id'),
        BusinessPermission.STAFF_MANAGE
      );

      sendResponse(res, 200, 'Empleados', await businessStaffService.list(param(req, 'id')));
    } catch (error) { next(error); }
  }

  async addStaff(req: Request, res: Response, next: NextFunction) {
    try {
      const { businessStaffService } = await import('../services/businessStaff.service');
      const { BusinessPermission } = await import('../models');

      await businessStaffService.assertCan(
        req.user!._id.toString(),
        param(req, 'id'),
        BusinessPermission.STAFF_MANAGE
      );

      const staff = await businessStaffService.add(
        param(req, 'id'),
        req.body.phone,
        req.body.role,
        req.user!._id.toString()
      );

      void logAudit(req, {
        action: AuditAction.BUSINESS_UPDATED,
        entity: 'business',
        entityId: param(req, 'id'),
        description: `Empleado agregado con papel ${req.body.role}`,
        metadata: { phone: req.body.phone, role: req.body.role },
      });

      sendResponse(res, 201, 'Empleado agregado', staff);
    } catch (error) { next(error); }
  }

  async removeStaff(req: Request, res: Response, next: NextFunction) {
    try {
      const { businessStaffService } = await import('../services/businessStaff.service');
      const { BusinessPermission } = await import('../models');

      await businessStaffService.assertCan(
        req.user!._id.toString(),
        param(req, 'id'),
        BusinessPermission.STAFF_MANAGE
      );

      const staff = await businessStaffService.remove(param(req, 'id'), param(req, 'staffId'));
      sendResponse(res, 200, 'Acceso retirado', staff);
    } catch (error) { next(error); }
  }

  /** Qué puede hacer quien pregunta, en este negocio. */
  async myPermissions(req: Request, res: Response, next: NextFunction) {
    try {
      const { businessStaffService } = await import('../services/businessStaff.service');
      const permissions = await businessStaffService.permissionsFor(
        req.user!._id.toString(),
        param(req, 'id')
      );
      sendResponse(res, 200, 'Permisos', { permissions });
    } catch (error) { next(error); }
  }

  /** Analíticas del comercio, calculadas en la base y no en el navegador. */
  async analytics(req: Request, res: Response, next: NextFunction) {
    try {
      const businessId = param(req, 'id');
      const user = req.user!;

      if (user.role !== UserRole.ADMIN) {
        const { Business } = await import('../models');
        const owns = await Business.exists({ _id: businessId, ownerId: user._id });
        if (!owns) throw new AppError('No autorizado', 403);
      }

      const { businessAnalyticsService } = await import('../services/businessAnalytics.service');
      const data = await businessAnalyticsService.analyticsFor(businessId, {
        days: Number(query(req, 'days')) || 30,
      });

      sendResponse(res, 200, 'Analíticas', data);
    } catch (error) { next(error); }
  }

  // ── Alta y verificación documental ──

  /** Cola de negocios esperando revisión, con lo que le falta a cada uno. */
  async pendingApprovals(req: Request, res: Response, next: NextFunction) {
    try {
      sendResponse(res, 200, 'Negocios por revisar', await businessService.pendingApprovals());
    } catch (error) { next(error); }
  }

  async approve(req: Request, res: Response, next: NextFunction) {
    try {
      const business = await businessService.approve(param(req, 'id'), req.user!._id.toString());
      void logAudit(req, {
        action: AuditAction.BUSINESS_UPDATED,
        entity: 'business',
        entityId: business._id.toString(),
        description: `Negocio aprobado tras revisión documental: ${business.name}`,
      });
      sendResponse(res, 200, 'Negocio aprobado', business);
    } catch (error) { next(error); }
  }

  async listDocuments(req: Request, res: Response, next: NextFunction) {
    try {
      sendResponse(res, 200, 'Documentos', await businessService.listDocuments(param(req, 'id')));
    } catch (error) { next(error); }
  }

  async submitDocument(req: Request, res: Response, next: NextFunction) {
    try {
      const document = await businessService.submitDocument(param(req, 'id'), req.body);
      sendResponse(res, 201, 'Documento recibido para verificación', document);
    } catch (error) { next(error); }
  }

  async reviewDocument(req: Request, res: Response, next: NextFunction) {
    try {
      const document = await businessService.reviewDocument(
        param(req, 'documentId'),
        req.user!._id.toString(),
        req.body.status,
        req.body.rejectionReason
      );
      void logAudit(req, {
        action: AuditAction.DOCUMENT_REVIEWED,
        entity: 'business_document',
        entityId: document._id.toString(),
        description: 'Documento de comercio verificado',
        metadata: { status: document.status, type: document.type },
      });
      sendResponse(res, 200, 'Documento verificado', document);
    } catch (error) { next(error); }
  }

  async create(req: Request, res: Response, next: NextFunction) {
    try {
      // An admin may register a business on an owner's behalf; a merchant is
      // always the owner of what it creates, whatever the payload claims.
      const isAdmin = req.user?.role === 'admin';
      const ownerId =
        isAdmin && req.body.ownerId ? req.body.ownerId : req.user!._id.toString();

      const business = await businessService.create({ ...req.body, ownerId });
      sendResponse(res, 201, 'Negocio creado exitosamente', business);
    } catch (error) { next(error); }
  }

  async getAll(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await businessService.getAll({
        city: query(req, 'city'),
        category: query(req, 'category'),
        featured: query(req, 'featured') === 'true',
        search: query(req, 'search'),
        lat: query(req, 'lat') ? Number(query(req, 'lat')) : undefined,
        lng: query(req, 'lng') ? Number(query(req, 'lng')) : undefined,
        maxDistance: query(req, 'maxDistance') ? Number(query(req, 'maxDistance')) : undefined,
        page: Number(query(req, 'page')) || 1,
        limit: Number(query(req, 'limit')) || 20,
        includeInactive: query(req, 'includeInactive') === 'true' || query(req, 'all') === 'true' || req.user?.role === 'admin',
      });
      sendResponse(res, 200, 'Negocios obtenidos', result.businesses, result.meta);
    } catch (error) { next(error); }
  }

  async getById(req: Request, res: Response, next: NextFunction) {
    try {
      const business = await businessService.getById(param(req, 'id'));
      sendResponse(res, 200, 'Negocio obtenido', business);
    } catch (error) { next(error); }
  }

  async getBySlug(req: Request, res: Response, next: NextFunction) {
    try {
      const business = await businessService.getBySlug(param(req, 'slug'));
      sendResponse(res, 200, 'Negocio obtenido', business);
    } catch (error) { next(error); }
  }

  async update(req: Request, res: Response, next: NextFunction) {
    try {
      const isAdmin = req.user?.role === 'admin';
      const business = await businessService.update(param(req, 'id'), req.user!._id.toString(), req.body, isAdmin);
      sendResponse(res, 200, 'Negocio actualizado', business);
    } catch (error) { next(error); }
  }
  async delete(req: Request, res: Response, next: NextFunction) {
    try {
      const isAdmin = req.user?.role === 'admin';
      await businessService.delete(param(req, 'id'), req.user!._id.toString(), isAdmin);
      sendResponse(res, 200, 'Negocio eliminado exitosamente');
    } catch (error) { next(error); }
  }

  async getMyBusinesses(req: Request, res: Response, next: NextFunction) {
    try {
      // Incluye los negocios donde solo es empleado. Antes solo devolvía
      // los propios, así que un encargado se autenticaba bien y se
      // encontraba un panel vacío sin ninguna explicación.
      const { businessStaffService } = await import('../services/businessStaff.service');
      const businesses = await businessStaffService.accessibleBusinesses(
        req.user!._id.toString()
      );
      sendResponse(res, 200, 'Mis negocios', businesses);
    } catch (error) { next(error); }
  }

  /**
   * Comprueba que quien pregunta puede leer las cuentas de este comercio.
   *
   * Un comercio solo lee lo suyo; administración lee cualquiera, que es lo
   * que usa la trastienda. Está extraído en vez de repetido porque la
   * comprobación de propiedad es justo el tipo de cosa que se copia mal la
   * tercera vez que se escribe.
   */
  private async assertCanReadFinance(req: Request, businessId: string) {
    const business = await businessService.getById(businessId);
    const isAdmin = req.user?.role === 'admin';
    if (!isAdmin && business.ownerId.toString() !== req.user!._id.toString()) {
      throw new AppError('No autorizado', 403);
    }
    return business;
  }

  /**
   * El extracto de liquidación del comercio: lo que se le debe, de qué
   * semana viene y qué se le ha liquidado ya.
   *
   * Absorbe al antiguo `/payouts`, que devolvía este mismo resumen sin el
   * desglose semanal ni la próxima liquidación. Dos endpoints contando el
   * mismo dinero es la forma habitual de que un día cuenten distinto.
   *
   * Sustituye además a la suma que el panel hacía en el navegador, y la
   * diferencia no es de estilo: el listado de pedidos viene paginado, así
   * que sumar en el cliente significaba enseñar como "ganancia neta" la
   * suma de los pedidos que cupieron en la primera página.
   */
  async getStatement(req: Request, res: Response, next: NextFunction) {
    try {
      const businessId = param(req, 'id');
      await this.assertCanReadFinance(req, businessId);

      const statement = await payoutService.merchantStatement({
        businessId,
        weeks: Number(query(req, 'weeks')) || undefined,
      });

      sendResponse(res, 200, 'Extracto del comercio', statement);
    } catch (error) { next(error); }
  }

  /**
   * Las ventas que componen una liquidación, o las que entrarán en la
   * próxima.
   *
   * Es el enlace que faltaba en las dos direcciones: desde una venta se
   * llega a la liquidación que la pagó (`settlementId` en cada fila) y
   * desde una liquidación se llega a sus ventas (`?settlementId=`).
   */
  async getStatementLines(req: Request, res: Response, next: NextFunction) {
    try {
      const businessId = param(req, 'id');
      await this.assertCanReadFinance(req, businessId);

      const rawStatus = query(req, 'status');
      const statuses = rawStatus
        ? rawStatus
            .split(',')
            .map((value) => value.trim())
            .filter((value): value is PayoutStatus =>
              Object.values(PayoutStatus).includes(value as PayoutStatus)
            )
        : undefined;

      const parseDate = (value?: string) => {
        if (!value) return undefined;
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? undefined : date;
      };

      const result = await payoutService.merchantStatementLines({
        businessId,
        orderId: query(req, 'orderId'),
        settlementId: query(req, 'settlementId'),
        statuses,
        from: parseDate(query(req, 'from')),
        to: parseDate(query(req, 'to')),
        page: Number(query(req, 'page')) || 1,
        limit: Number(query(req, 'limit')) || 50,
      });

      sendResponse(res, 200, 'Ventas del extracto', result.lines, {
        ...result.meta,
        totals: result.totals,
      });
    } catch (error) { next(error); }
  }
}

export const businessController = new BusinessController();
