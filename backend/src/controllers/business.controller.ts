import { Request, Response, NextFunction } from 'express';
import { businessService, businessImageService, payoutService, publicCatalogService } from '../services';
import { can } from '../middlewares/auth';
import { AppError, uploadBusinessImage, uploadBusinessDocumentFile, cacheHeaders } from '../middlewares';
import { Business, BusinessPermission as BusinessPermissionEnum } from '../models';
import { PayoutStatus } from '../types';
import { sendResponse, param, query, toCsv, csvFilename, clampLimit } from '../utils';
import { UserRole } from '../types';
import { AuditAction, AuditSeverity, Permission, logAudit } from '../security';
import { businessDocumentBody } from '../validators/business.validator';

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
      await this.assertBusinessPermission(req, businessId, 'SETTLEMENTS_VIEW', 'Sin permisos para ver liquidaciones.');

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

  private async staffService() {
    const { businessStaffService } = await import('../services/businessStaff.service');
    const { BusinessPermission } = await import('../models');
    return { businessStaffService, BusinessPermission };
  }

  async listStaff(req: Request, res: Response, next: NextFunction) {
    try {
      const { businessStaffService, BusinessPermission } = await this.staffService();
      await businessStaffService.assertCan(
        req.user!._id.toString(),
        param(req, 'id'),
        BusinessPermission.TEAM_VIEW,
        'Sin permisos para ver al equipo.'
      );

      sendResponse(res, 200, 'Empleados', await businessStaffService.list(param(req, 'id')));
    } catch (error) { next(error); }
  }

  /** Invita a alguien: queda pendiente hasta que acepte. */
  async addStaff(req: Request, res: Response, next: NextFunction) {
    try {
      const { businessStaffService, BusinessPermission } = await this.staffService();
      await businessStaffService.assertCan(
        req.user!._id.toString(),
        param(req, 'id'),
        BusinessPermission.TEAM_INVITE,
        'Sin permisos para invitar empleados.'
      );

      const staff = await businessStaffService.invite(
        param(req, 'id'),
        { phone: req.body.phone, role: req.body.role, name: req.body.name, email: req.body.email },
        req.user!._id.toString()
      );

      void logAudit(req, {
        action: AuditAction.BUSINESS_UPDATED,
        entity: 'business',
        entityId: param(req, 'id'),
        description: `Empleado invitado con papel ${req.body.role}`,
        metadata: { staffUserId: staff?.userId?.toString?.(), role: req.body.role },
      });

      sendResponse(res, 201, 'Invitación enviada', staff);
    } catch (error) { next(error); }
  }

  /** Cambiar el papel, o suspender / reactivar. */
  async updateStaff(req: Request, res: Response, next: NextFunction) {
    try {
      const { businessStaffService, BusinessPermission } = await this.staffService();
      const businessId = param(req, 'id');
      const actorId = req.user!._id.toString();
      const { role, suspended } = req.body as { role?: any; suspended?: boolean };

      let staff;
      if (role) {
        await businessStaffService.assertCan(actorId, businessId, BusinessPermission.TEAM_CHANGE_ROLE, 'Sin permisos para cambiar roles.');
        staff = await businessStaffService.changeRole(businessId, param(req, 'staffId'), role, actorId);
      }
      if (suspended !== undefined) {
        await businessStaffService.assertCan(actorId, businessId, BusinessPermission.TEAM_EDIT, 'Sin permisos para editar empleados.');
        staff = await businessStaffService.setSuspended(businessId, param(req, 'staffId'), suspended, actorId);
      }

      void logAudit(req, {
        action: AuditAction.BUSINESS_UPDATED,
        entity: 'business',
        entityId: businessId,
        description: role ? `Papel de empleado cambiado a ${role}` : suspended ? 'Empleado suspendido' : 'Empleado reactivado',
        metadata: { staffUserId: staff?.userId?.toString?.(), role, suspended },
      });

      sendResponse(res, 200, 'Empleado actualizado', staff);
    } catch (error) { next(error); }
  }

  async removeStaff(req: Request, res: Response, next: NextFunction) {
    try {
      const { businessStaffService, BusinessPermission } = await this.staffService();
      const actorId = req.user!._id.toString();
      await businessStaffService.assertCan(actorId, param(req, 'id'), BusinessPermission.TEAM_REMOVE, 'Sin permisos para eliminar empleados.');

      const staff = await businessStaffService.remove(param(req, 'id'), param(req, 'staffId'), actorId);

      void logAudit(req, {
        action: AuditAction.BUSINESS_UPDATED,
        entity: 'business',
        entityId: param(req, 'id'),
        description: 'Acceso de empleado retirado',
        metadata: { staffUserId: staff?.userId?.toString?.() },
      });

      sendResponse(res, 200, 'Acceso retirado', staff);
    } catch (error) { next(error); }
  }

  /** Invitaciones sin responder de quien pregunta (no depende de ningún negocio). */
  async myInvitations(req: Request, res: Response, next: NextFunction) {
    try {
      const { businessStaffService } = await this.staffService();
      sendResponse(res, 200, 'Invitaciones', await businessStaffService.pendingInvitations(req.user!._id.toString()));
    } catch (error) { next(error); }
  }

  async respondInvitation(req: Request, res: Response, next: NextFunction) {
    try {
      const { businessStaffService } = await this.staffService();
      const accept = req.body.accept as boolean;
      const staff = await businessStaffService.respondToInvitation(req.user!._id.toString(), param(req, 'staffId'), accept);
      sendResponse(res, 200, accept ? 'Invitación aceptada' : 'Invitación rechazada', staff);
    } catch (error) { next(error); }
  }

  /** Abrir o cerrar el negocio. Dueño y personal con `store:toggle`. */
  async setOpen(req: Request, res: Response, next: NextFunction) {
    try {
      const businessId = param(req, 'id');
      if (req.user!.role !== UserRole.ADMIN) {
        const { businessStaffService } = await import('../services/businessStaff.service');
        const { BusinessPermission } = await import('../models');
        await businessStaffService.assertCan(req.user!._id.toString(), businessId, BusinessPermission.STORE_TOGGLE);
      }

      const isActive = req.body.isActive as boolean;
      const business = await businessService.setOpen(businessId, isActive);

      // Quién abrió y quién cerró queda escrito: con varias personas en el
      // mostrador, "¿por qué estábamos cerrados a las 8?" tiene respuesta.
      void logAudit(req, {
        action: AuditAction.BUSINESS_UPDATED,
        entity: 'business',
        entityId: businessId,
        description: isActive ? 'Negocio abierto' : 'Negocio cerrado',
        metadata: { isActive },
      });

      sendResponse(res, 200, isActive ? 'Negocio abierto' : 'Negocio cerrado', business);
    } catch (error) { next(error); }
  }

  /** Qué puede hacer quien pregunta, en este negocio. */
  async myPermissions(req: Request, res: Response, next: NextFunction) {
    try {
      const { businessStaffService } = await import('../services/businessStaff.service');
      // El papel viaja junto a los permisos: el panel esconde al personal las
      // pantallas cuyos endpoints aún son solo del dueño, aunque el papel
      // declare el permiso (p. ej. el encargado y `menu:manage`).
      const access = await businessStaffService.accessFor(
        req.user!._id.toString(),
        param(req, 'id')
      );
      sendResponse(res, 200, 'Permisos', { permissions: access?.permissions ?? [], role: access?.role ?? null });
    } catch (error) { next(error); }
  }

  /** Analíticas del comercio, calculadas en la base y no en el navegador. */
  async analytics(req: Request, res: Response, next: NextFunction) {
    try {
      const businessId = param(req, 'id');
      const user = req.user!;

      await this.assertBusinessPermission(req, businessId, 'ANALYTICS_VIEW', 'Sin permisos para ver estadísticas.');

      const { businessAnalyticsService } = await import('../services/businessAnalytics.service');
      const data = await businessAnalyticsService.analyticsFor(businessId, {
        days: Number(query(req, 'days')) || 30,
      });

      sendResponse(res, 200, 'Analíticas', data);
    } catch (error) { next(error); }
  }

  /** Cierre del día del comercio: ventas, neto, pagos, top productos y comparación con -7 días. */
  async dailySummary(req: Request, res: Response, next: NextFunction) {
    try {
      const businessId = param(req, 'id');
      const user = req.user!;

      await this.assertBusinessPermission(req, businessId, 'FINANCIAL_VIEW', 'Sin permisos para ver información financiera.');

      const { businessDailySummaryService } = await import('../services/businessDailySummary.service');
      const data = await businessDailySummaryService.summaryFor(businessId, query(req, 'date'));
      sendResponse(res, 200, 'Resumen del día', data);
    } catch (error) { next(error); }
  }

  // ── Alta y verificación documental ──

  /** Cola de negocios esperando revisión, con lo que le falta a cada uno. */
  async pendingApprovals(req: Request, res: Response, next: NextFunction) {
    try {
      const pending = await businessService.pendingApprovals();
      // Copias de cédulas y RUT: que ningún intermediario las guarde, y
      // que consultar la cola deje rastro (antes no lo dejaba).
      res.setHeader('Cache-Control', 'no-store');
      void logAudit(req, {
        action: AuditAction.BUSINESS_DOCUMENT_VIEWED,
        entity: 'business',
        entityId: 'pending-approvals',
        severity: AuditSeverity.LOW,
        description: 'Cola de negocios por revisar consultada (incluye enlaces a documentos)',
        metadata: { businesses: pending.length },
      });
      sendResponse(res, 200, 'Negocios por revisar', pending);
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

  /**
   * Acceso a los papeles y datos fiscales de un negocio.
   *
   * Antes bastaba con tener rol `business` para leer o pisar los de cualquier
   * negocio cambiando el `:id`. Ahora:
   *   - el dueño (o un empleado con `settings:manage`, que hoy solo tiene el
   *     dueño) entra a los de SU negocio y a ninguno más;
   *   - un administrador entra con el permiso que la operación pida
   *     (`adminPermissions`, cualquiera de la lista) — no basta con ser admin.
   * Devuelve si quien pregunta es admin, para que el caller decida qué auditar.
   */
  private async assertBusinessFileAccess(
    req: Request,
    businessId: string,
    adminPermissions: Permission[],
    businessPermission: 'SETTINGS_MANAGE' | 'DOCUMENTS_MANAGE' = 'SETTINGS_MANAGE'
  ): Promise<{ isAdmin: boolean }> {
    if (req.user!.role === UserRole.ADMIN) {
      if (!adminPermissions.some((permission) => can(req, permission))) {
        throw new AppError('No tienes permisos suficientes para esta acción', 403);
      }
      return { isAdmin: true };
    }

    const { businessStaffService } = await import('../services/businessStaff.service');
    const { BusinessPermission } = await import('../models');
    await businessStaffService.assertCan(req.user!._id.toString(), businessId, BusinessPermission[businessPermission]);
    return { isAdmin: false };
  }

  /** Papeles: el admin necesita poder aprobar comercios. */
  private assertCanManageDocuments(req: Request, businessId: string) {
    return this.assertBusinessFileAccess(req, businessId, [Permission.BUSINESSES_APPROVE], 'DOCUMENTS_MANAGE');
  }

  async listDocuments(req: Request, res: Response, next: NextFunction) {
    try {
      const businessId = param(req, 'id');
      const { isAdmin } = await this.assertCanManageDocuments(req, businessId);
      // `?history=true` firma también las versiones anteriores (bajo demanda).
      const documents = await businessService.listDocuments(businessId, {
        includeHistory: query(req, 'history') === 'true',
      });
      res.setHeader('Cache-Control', 'no-store');

      // Un admin abriendo los papeles de un comercio es un acceso a copias de
      // cédulas: queda rastro. El dueño viendo los suyos no.
      if (isAdmin) {
        void logAudit(req, {
          action: AuditAction.BUSINESS_DOCUMENT_VIEWED,
          entity: 'business',
          entityId: businessId,
          severity: AuditSeverity.LOW,
          description: 'Documentos del comercio consultados por administración',
          metadata: { count: documents.length },
        });
      }

      sendResponse(res, 200, 'Documentos', documents);
    } catch (error) { next(error); }
  }

  /**
   * Subida de un documento: multipart con el archivo en el campo `file`
   * (imagen o PDF) más `type`, `reference` y `expiresAt`.
   *
   * Sin `validate()` en la ruta por la misma razón que las fotos: zod vaciaría
   * `req.body` antes de que multer lo lea. El acceso se comprueba **antes** de
   * leer el archivo, para no cargar a memoria lo que un tercero intenta subir.
   */
  async submitDocument(req: Request, res: Response, next: NextFunction) {
    try {
      const businessId = param(req, 'id');
      await this.assertCanManageDocuments(req, businessId);

      uploadBusinessDocumentFile(req, res, async (err: unknown) => {
        try {
          if (err) {
            const tooBig = (err as { code?: string }).code === 'LIMIT_FILE_SIZE';
            throw new AppError(
              tooBig
                ? 'El archivo supera el máximo de 8 MB'
                : err instanceof Error ? err.message : 'No se pudo procesar el archivo',
              tooBig ? 413 : 400
            );
          }
          if (!req.file) throw new AppError('Adjunta el archivo del documento (campo "file")', 400);

          const parsed = businessDocumentBody.safeParse(req.body);
          if (!parsed.success) {
            throw new AppError(parsed.error.issues[0]?.message ?? 'Revisa los datos del documento', 400);
          }

          const document = await businessService.submitDocument(
            businessId,
            { ...parsed.data, file: req.file.buffer, submittedBy: req.user!._id.toString() },
            req
          );

          res.setHeader('Cache-Control', 'no-store');
          sendResponse(res, 201, 'Documento recibido para verificación', businessService.documentView(document));
        } catch (error) { next(error); }
      });
    } catch (error) { next(error); }
  }

  async reviewDocument(req: Request, res: Response, next: NextFunction) {
    try {
      const document = await businessService.reviewDocument(
        param(req, 'documentId'),
        req.user!._id.toString(),
        req.body.status,
        req.body.rejectionReason,
        req.body.revision
      );
      void logAudit(req, {
        action: AuditAction.DOCUMENT_REVIEWED,
        entity: 'business_document',
        entityId: document._id.toString(),
        description: 'Documento de comercio verificado',
        metadata: {
          businessId: document.businessId.toString(),
          status: document.status,
          type: document.type,
          rejectionReason: document.rejectionReason ?? undefined,
        },
      });
      res.setHeader('Cache-Control', 'no-store');
      sendResponse(res, 200, 'Documento verificado', businessService.documentView(document));
    } catch (error) { next(error); }
  }

  // ── Datos legales y cuenta de pago ──

  /** Leer: el dueño, o un admin que pueda aprobar comercios o ver finanzas. */
  private assertCanReadFiscal(req: Request, businessId: string) {
    return this.assertBusinessFileAccess(req, businessId, [Permission.BUSINESSES_APPROVE, Permission.FINANCE_VIEW]);
  }

  /** Escribir: el dueño, o un admin con permiso para editar cualquier negocio. */
  private assertCanWriteFiscal(req: Request, businessId: string) {
    return this.assertBusinessFileAccess(req, businessId, [Permission.BUSINESSES_UPDATE_ALL]);
  }

  async getLegal(req: Request, res: Response, next: NextFunction) {
    try {
      const businessId = param(req, 'id');
      await this.assertCanReadFiscal(req, businessId);
      res.setHeader('Cache-Control', 'no-store');
      sendResponse(res, 200, 'Datos legales', await businessService.getLegal(businessId));
    } catch (error) { next(error); }
  }

  async putLegal(req: Request, res: Response, next: NextFunction) {
    try {
      const businessId = param(req, 'id');
      await this.assertCanWriteFiscal(req, businessId);
      const legal = await businessService.setLegal(businessId, req.body, req.user!._id.toString(), req);
      sendResponse(res, 200, 'Datos legales guardados', legal);
    } catch (error) { next(error); }
  }

  /** La cuenta, enmascarada (4 últimos dígitos). El número completo es `revealPayoutAccount`. */
  async getPayoutAccount(req: Request, res: Response, next: NextFunction) {
    try {
      const businessId = param(req, 'id');
      await this.assertCanReadFiscal(req, businessId);
      res.setHeader('Cache-Control', 'no-store');
      sendResponse(res, 200, 'Cuenta de pago', await businessService.getPayoutAccount(businessId));
    } catch (error) { next(error); }
  }

  async putPayoutAccount(req: Request, res: Response, next: NextFunction) {
    try {
      const businessId = param(req, 'id');
      const { isAdmin } = await this.assertCanWriteFiscal(req, businessId);

      // Reautenticación: cambiar a dónde va el dinero pide algo que un token
      // robado no tiene. Los campos de prueba no se propagan al servicio.
      const { currentPassword, otpCode, ...accountInput } = req.body;
      const { authService } = await import('../services/auth.service');
      try {
        await authService.assertReauth(req.user!._id.toString(), { password: currentPassword, otpCode });
      } catch (error) {
        void logAudit(req, {
          action: AuditAction.SUSPICIOUS_ACTIVITY,
          entity: 'business',
          entityId: businessId,
          severity: AuditSeverity.HIGH,
          description: 'Cambio de cuenta de pago rechazado: reautenticación fallida',
        });
        throw error;
      }

      const account = await businessService.setPayoutAccount(businessId, accountInput, req.user!._id.toString(), {
        asOwner: !isAdmin,
        req,
      });
      res.setHeader('Cache-Control', 'no-store');
      sendResponse(res, 200, 'Cuenta de pago guardada: queda pendiente de verificación por finanzas', account);
    } catch (error) { next(error); }
  }

  /**
   * Pide el OTP de reautenticación (solo para cuentas sin contraseña, que
   * entran con OAuth). Con contraseña no manda nada: responde `password`.
   */
  async requestPayoutAccountOtp(req: Request, res: Response, next: NextFunction) {
    try {
      const businessId = param(req, 'id');
      await this.assertCanWriteFiscal(req, businessId);
      const { authService } = await import('../services/auth.service');
      sendResponse(res, 200, 'Confirmación solicitada', await authService.requestReauthOtp(req.user!._id.toString()));
    } catch (error) { next(error); }
  }

  /** Solo el admin financiero (`requireFinanceAdmin` en la ruta). */
  async verifyPayoutAccount(req: Request, res: Response, next: NextFunction) {
    try {
      const account = await businessService.verifyPayoutAccount(
        param(req, 'id'),
        req.user!._id.toString(),
        req.body.version,
        req,
        req.body.note
      );
      sendResponse(res, 200, 'Cuenta de pago verificada', account);
    } catch (error) { next(error); }
  }

  /** Solo el admin financiero: el número de cuenta completo, auditado. */
  async revealPayoutAccount(req: Request, res: Response, next: NextFunction) {
    try {
      const account = await businessService.revealPayoutAccount(param(req, 'id'), req);
      // Datos sensibles: que ningún intermediario los guarde.
      res.setHeader('Cache-Control', 'no-store');
      sendResponse(res, 200, 'Cuenta de pago (completa)', account);
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
        limit: clampLimit(query(req, 'limit')),
        // Ruta pública sin sesión: nadie puede pedir aquí los no aprobados.
        // El panel admin lista todo por `/admin/businesses`.
        includeInactive: false,
      });
      sendResponse(res, 200, 'Negocios obtenidos', result.businesses, result.meta);
    } catch (error) { next(error); }
  }

  async getById(req: Request, res: Response, next: NextFunction) {
    try {
      const business = await publicCatalogService.businessDetail(param(req, 'id'));
      cacheHeaders(res, 'revalidate');
      sendResponse(res, 200, 'Negocio obtenido', business);
    } catch (error) { next(error); }
  }

  async getBySlug(req: Request, res: Response, next: NextFunction) {
    try {
      const business = await publicCatalogService.businessBySlug(param(req, 'slug'));
      cacheHeaders(res, 'revalidate');
      sendResponse(res, 200, 'Negocio obtenido', business);
    } catch (error) { next(error); }
  }

  /** Ficha, secciones, carta, más pedidos y opinión: la tienda en una petición. */
  async storefront(req: Request, res: Response, next: NextFunction) {
    try {
      const data = await publicCatalogService.storefront(param(req, 'id'));
      cacheHeaders(res, 'revalidate');
      sendResponse(res, 200, 'Tienda', data);
    } catch (error) { next(error); }
  }

  /**
   * La tarjeta pública que carga `web/` cuando alguien abre un enlace
   * compartido desde el botón "Compartir" de la app. Público a propósito
   * —es justo el punto de un enlace para compartir— y con su propio
   * proyecto de campos: ver `businessService.getPublicBySlug`.
   */
  async sharePreview(req: Request, res: Response, next: NextFunction) {
    try {
      const business = await businessService.getPublicBySlug(param(req, 'slug'));
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

  /**
   * Reemplaza el logo o la portada del comercio.
   *
   * Una sola función para las dos ranuras: el camino es idéntico —multer,
   * dueño del negocio, Cloudinary, guardar la URL— y duplicarlo es cómo se
   * acaba con dos comprobaciones de propiedad que un día dejan de decir lo
   * mismo. Lo único que cambia es el campo y el recorte, y eso viaja como
   * dato.
   */
  private uploadBrandImage(
    slot: 'logo' | 'cover',
    field: 'logo' | 'coverImage',
    req: Request,
    res: Response,
    next: NextFunction
  ) {
    uploadBusinessImage(req, res, async (err: unknown) => {
      try {
        if (err) {
          throw new AppError(
            err instanceof Error ? err.message : 'No se pudo procesar la imagen',
            400
          );
        }
        if (!req.file) throw new AppError('Adjunta una imagen', 400);

        const business = await this.assertOwnsBusiness(req, param(req, 'id'));
        const url = await businessImageService.upload(
          slot,
          String(business._id),
          req.file.buffer
        );

        business.set(field, url);
        await business.save();

        sendResponse(res, 201, 'Imagen actualizada', { [field]: url });
      } catch (error) { next(error); }
    });
  }

  async uploadLogo(req: Request, res: Response, next: NextFunction) {
    this.uploadBrandImage('logo', 'logo', req, res, next);
  }

  async uploadCover(req: Request, res: Response, next: NextFunction) {
    this.uploadBrandImage('cover', 'coverImage', req, res, next);
  }

  /**
   * Quita el logo o la portada.
   *
   * Solo borra la referencia, no el archivo en Cloudinary. Es deliberado:
   * la ficha vuelve al respaldo de color e ilustración al instante, y una
   * imagen huérfana en el almacén cuesta céntimos, mientras que borrar el
   * archivo de verdad deja rotas las copias que ya viajaron en respuestas
   * cacheadas o en una pantalla abierta.
   */
  async removeBrandImage(req: Request, res: Response, next: NextFunction) {
    try {
      const field = param(req, 'slot') === 'logo' ? 'logo' : 'coverImage';
      const business = await this.assertOwnsBusiness(req, param(req, 'id'));

      business.set(field, null);
      await business.save();

      sendResponse(res, 200, 'Imagen eliminada', { [field]: null });
    } catch (error) { next(error); }
  }

  /**
   * El negocio, si quien pregunta puede editarlo.
   *
   * Aparte de `assertCanReadFinance` porque aquello autoriza *lectura* de
   * cuentas y esto autoriza *escritura* sobre la ficha pública. Compartir
   * una sola función para ambas cosas es cómo un permiso de lectura acaba
   * dejando cambiar el logo de otro.
   */
  private async assertOwnsBusiness(req: Request, businessId: string) {
    const business = await businessService.getById(businessId);
    await this.assertBusinessPermission(req, businessId, 'BUSINESS_EDIT', 'Sin permisos para modificar la información del negocio.');
    return business;
  }

  /**
   * Permiso por nombre, resuelto contra el rol de la persona en ESTE negocio.
   * Un Admin de plataforma ya pasó por `adminRequires` en la ruta.
   */
  private async assertBusinessPermission(
    req: Request,
    businessId: string,
    permission: keyof typeof BusinessPermissionEnum,
    message: string
  ): Promise<void> {
    if (req.user!.role === UserRole.ADMIN) return;
    const { businessStaffService } = await import('../services/businessStaff.service');
    const { BusinessPermission } = await import('../models');
    await businessStaffService.assertCan(req.user!._id.toString(), businessId, BusinessPermission[permission], message);
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
  private async assertCanReadFinance(req: Request, businessId: string): Promise<void> {
    await this.assertBusinessPermission(req, businessId, 'SETTLEMENTS_VIEW', 'Sin permisos para ver liquidaciones.');
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
        limit: clampLimit(query(req, 'limit'), 50),
      });

      sendResponse(res, 200, 'Ventas del extracto', result.lines, {
        ...result.meta,
        totals: result.totals,
      });
    } catch (error) { next(error); }
  }
}

export const businessController = new BusinessController();
