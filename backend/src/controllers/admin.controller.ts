import { Request, Response, NextFunction } from 'express';
import { adminService } from '../services/admin.service';
import { dailySummaryService } from '../services/dailySummary.service';
import { dailySummaryFinanceService } from '../services/dailySummaryFinance.service';
import { bogotaDateString } from '../utils/period';
import { sendResponse, param, query, toCsv, csvFilename, clampLimit, clientIp, type CsvColumn } from '../utils';
import { OrderEvidenceType } from '../types';
import { orderEvidenceService } from '../services/orderEvidence.service';
import { orderSecurityService } from '../services/orderSecurity.service';
import { resolveOrderAccess } from '../services/orderAccess.service';
import { OrderEvent, AuditAction, AuditSeverity, logAudit } from '../security';
import { AppError } from '../middlewares';
import { can } from '../middlewares/auth';
import { Permission } from '../security';
import { assertExportAuthorized } from '../security/exportGate';

/** Hasta medio año: es lo que guarda la colección de eventos. */
const IMAGE_STATS_MAX_RANGE_MS = 180 * 24 * 60 * 60_000;
const IMAGE_STATS_DEFAULT_RANGE_MS = 30 * 24 * 60 * 60_000;

const DASHBOARD_MONEY_KEYS = ['todayRevenue', 'todayCommission', 'platformResult'];

/** Sin `finance:view` el panel no recibe cifras de dinero (ni el desglose por medio de pago). */
function omitDashboardMoney<T extends Record<string, any>>(stats: T) {
  const out: Record<string, any> = { ...stats };
  for (const k of DASHBOARD_MONEY_KEYS) delete out[k];
  if (out.paymentBreakdown) {
    out.paymentBreakdown = {
      online: { count: out.paymentBreakdown.online?.count ?? 0 },
      cash: { count: out.paymentBreakdown.cash?.count ?? 0 },
    };
  }
  return out;
}

const dateOrToday = (v: string | undefined) => (/^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v! : bogotaDateString());

const SUMMARY_MONEY_KEYS = [
  'gmv', 'platformGrossRevenue', 'promotionExpense', 'netRevenue', 'businessPayouts', 'driverPayouts',
  'tips', 'tax', 'merchantFundedDiscount', 'platformFundedDiscount', 'platformResult', 'avgTicket',
  'payDigitalAmount', 'payCashAmount', 'refundsAmount', 'driverDeliveryPayouts', 'deliveryFees',
];

/** Mensajes de alertas de salud del día sin cifras en pesos (los originales las traen; ver `deriveHealthFlags`). */
const MONEY_FLAG_MESSAGES: Record<string, string> = {
  MARGEN_NEGATIVO: 'El día cerró con margen negativo. Revisa promociones activas y subsidios de domicilio.',
  PROMOCION_CARA: 'Las promociones costaron más del 10 % del GMV.',
  REEMBOLSOS_ALTOS: 'Los reembolsos superaron el 5 % del GMV.',
};

function maskMoneyFlag(flag: { code: string; message: string } & Record<string, any>) {
  const replacement = MONEY_FLAG_MESSAGES[flag.code];
  if (replacement) return { ...flag, message: replacement };
  // Red de seguridad: una alerta futura con "$" no debe filtrar pesos por omisión.
  if (/\$\s?\d/.test(flag.message)) return { ...flag, message: 'Revisa el detalle financiero del día.' };
  return flag;
}

/** Resumen diario para quien tiene `reports:view` pero no `finance:view`: solo operación. */
function omitSummaryMoney<T extends Record<string, any>>(summary: T) {
  const strip = (snap: Record<string, any>) => {
    const o = { ...snap };
    for (const k of SUMMARY_MONEY_KEYS) delete o[k];
    return o;
  };
  const out: Record<string, any> = { ...summary };
  out.today = strip(summary.today);
  out.baseline = strip(summary.baseline);
  if (summary.monthBaseline) out.monthBaseline = strip(summary.monthBaseline);
  out.monthComparison = (summary.monthComparison || []).filter((r: { metric: string }) => !SUMMARY_MONEY_KEYS.includes(r.metric));
  delete out.pending;
  delete out.gateway;
  out.comparison = (summary.comparison || []).filter((r: { metric: string }) => !SUMMARY_MONEY_KEYS.includes(r.metric));
  out.flags = (summary.flags || []).map(maskMoneyFlag);
  delete out.topBusinessesByGmv;
  delete out.cashByStatus;
  out.topBusinessesByOrders = (summary.topBusinessesByOrders || []).map((b: Record<string, any>) => {
    const { gmv: _gmv, ...rest } = b;
    return rest;
  });
  return out;
}

export class AdminController {
  /**
   * Cuántas fotos de producto pasaron por el recorte de fondo, cómo
   * salieron y cuánto costaron (`billable`), entre `from` y `to`. Por
   * defecto, los últimos 30 días.
   */
  async imageProcessingStats(req: Request, res: Response, next: NextFunction) {
    try {
      const { backgroundRemovalService } = await import('../services/backgroundRemoval.service');
      const toRaw = query(req, 'to');
      const fromRaw = query(req, 'from');
      const to = toRaw ? new Date(toRaw) : new Date();
      const from = fromRaw ? new Date(fromRaw) : new Date(to.getTime() - IMAGE_STATS_DEFAULT_RANGE_MS);

      if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) {
        throw new AppError('Rango de fechas inválido', 400);
      }
      if (to.getTime() - from.getTime() > IMAGE_STATS_MAX_RANGE_MS) {
        throw new AppError('El rango no puede pasar de 180 días', 400);
      }

      const stats = await backgroundRemovalService.stats({ from, to });
      sendResponse(res, 200, 'Métricas del recorte de fondo', stats);
    } catch (error) { next(error); }
  }

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
    // M2: un CSV con datos personales no debe quedar en la caché de un
    // proxy ni del navegador.
    res.setHeader('Cache-Control', 'no-store');
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
      // Todos reciben la vista enmascarada por defecto; la completa es un acto deliberado.
      const view = query(req, 'view') ?? 'masked';
      if (view !== 'masked' && view !== 'full') throw new AppError('Parámetro "view" inválido', 400);
      if (view === 'full' && !can(req, Permission.USERS_VIEW_SENSITIVE)) {
        throw new AppError('No tienes permisos para ver la ficha completa', 403);
      }
      const { internalNoteService } = await import('../services/internalNote.service');
      const profile = await userProfile360Service.profile360(param(req, 'id'), {
        sensitive: view === 'full',
        commissions: can(req, Permission.COMMISSIONS_VIEW),
        refunds: can(req, Permission.REFUNDS_VIEW),
        legal: can(req, Permission.LEGAL_VIEW),
        noteActor: await internalNoteService.noteActorFromRequest(req),
      });
      if (view === 'full') {
        void logAudit(req, {
          action: AuditAction.PROFILE_VIEWED,
          entity: 'user',
          entityId: param(req, 'id'),
          severity: AuditSeverity.MEDIUM,
          description: 'Ficha 360 de cliente consultada en vista completa',
          metadata: { view: 'full' },
        });
      }
      // S14: quién abrió la ficha 360 de un cliente queda auditado — es
      // dirección, pagos, riesgo y sesiones de una persona real.
      void logAudit(req, {
        action: AuditAction.PROFILE_VIEWED,
        entity: 'user',
        entityId: param(req, 'id'),
        severity: AuditSeverity.LOW,
        description: 'Ficha 360 de cliente consultada',
        metadata: { view },
      });
      sendResponse(res, 200, 'Historial del usuario', profile);
    } catch (error) { next(error); }
  }

  // ── Envíos dirigidos ──

  /** Cuánta gente alcanza un segmento, sin mandar nada todavía. */
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
      // S14: un interruptor mal apagado es exactamente el tipo de acción
      // que hay que poder reconstruir después (ver O2, el del reparto).
      void logAudit(req, {
        action: AuditAction.SETTINGS_UPDATED,
        entity: 'feature_flag',
        entityId: param(req, 'key'),
        severity: AuditSeverity.HIGH,
        description: `Interruptor "${param(req, 'key')}" actualizado`,
        metadata: { body: req.body },
      });
      sendResponse(res, 200, 'Interruptor actualizado', flag);
    } catch (error) { next(error); }
  }

  async deleteFeatureFlag(req: Request, res: Response, next: NextFunction) {
    try {
      const { featureFlagService } = await import('../services/featureFlag.service');
      await featureFlagService.remove(param(req, 'key'));
      void logAudit(req, {
        action: AuditAction.SETTINGS_UPDATED,
        entity: 'feature_flag',
        entityId: param(req, 'key'),
        severity: AuditSeverity.HIGH,
        description: `Interruptor "${param(req, 'key')}" eliminado`,
      });
      sendResponse(res, 200, 'Interruptor eliminado');
    } catch (error) { next(error); }
  }

  /** Puerta común de los exportes con datos personales: solo Super Administrador, con motivo y TOTP. */
  private assertExportAuthorized(req: Request, reason: unknown, totpToken: unknown): Promise<void> {
    return assertExportAuthorized(req, reason, totpToken);
  }

  async exportOrders(req: Request, res: Response, next: NextFunction) {
    try {
      const reason = req.body?.reason;
      const totpToken = req.body?.totpToken;
      await this.assertExportAuthorized(req, reason, totpToken);

      const { Order } = await import('../models');
      const filter: Record<string, unknown> = {};

      const from = req.body?.from;
      const to = req.body?.to;
      if (from || to) {
        filter.createdAt = {
          ...(from ? { $gte: new Date(from) } : {}),
          ...(to ? { $lte: new Date(to) } : {}),
        };
      }
      const status = req.body?.status;
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

      void logAudit(req, {
        action: AuditAction.DATA_EXPORTED,
        entity: 'order',
        severity: AuditSeverity.HIGH,
        description: `Exporte de pedidos (${orders.length} filas): ${reason}`,
        metadata: { filter: { from, to, status }, rows: orders.length, reason },
      });

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
      const reason = req.body?.reason;
      const totpToken = req.body?.totpToken;
      await this.assertExportAuthorized(req, reason, totpToken);

      const { User } = await import('../models');
      const filter: Record<string, unknown> = {};
      const role = req.body?.role;
      if (role) filter.role = role;

      const users = await User.find(filter)
        .select('name phone email role isActive isVerified isBlocked createdAt')
        .sort({ createdAt: -1 })
        .limit(10_000)
        .lean();

      void logAudit(req, {
        action: AuditAction.DATA_EXPORTED,
        entity: 'user',
        severity: AuditSeverity.HIGH,
        description: `Exporte de usuarios (${users.length} filas): ${reason}`,
        metadata: { filter: { role }, rows: users.length, reason },
      });

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
      sendResponse(res, 200, 'Dashboard obtenido', can(req, Permission.FINANCE_VIEW) ? stats : omitDashboardMoney(stats));
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
      sendResponse(res, 200, 'Resumen diario', can(req, Permission.FINANCE_VIEW) ? summary : omitSummaryMoney(summary));
    } catch (error) { next(error); }
  }

  /** Detalle financiero por pedido del día. Siempre `finance:view` (ver la ruta). */
  async getDailySummaryFinanceDetail(req: Request, res: Response, next: NextFunction) {
    try {
      const detail = await dailySummaryFinanceService.detail(
        dateOrToday(query(req, 'date')),
        Number(query(req, 'page')) || 1,
        Number(query(req, 'limit')) || 50
      );
      sendResponse(res, 200, 'Detalle financiero del día', detail);
    } catch (error) { next(error); }
  }

  /** El día partido por zona de entrega. El dinero solo con `finance:view`. */
  async getDailySummaryByZone(req: Request, res: Response, next: NextFunction) {
    try {
      const summary = await dailySummaryService.byZone(query(req, 'date'));
      const zones = can(req, Permission.FINANCE_VIEW)
        ? summary.zones
        : summary.zones.map(({ gmv: _gmv, driverPayouts: _payouts, ...rest }) => rest);
      sendResponse(res, 200, 'Resumen diario por zona', { ...summary, zones });
    } catch (error) { next(error); }
  }

  async getCrashes(req: Request, res: Response, next: NextFunction) {
    try {
      const { appHealthService, CRASH_DEFAULT_DAYS } = await import('../services/appHealth.service');
      const days = Number(query(req, 'days')) || CRASH_DEFAULT_DAYS;
      sendResponse(res, 200, 'Crashes de la app', await appHealthService.crashes(days));
    } catch (error) { next(error); }
  }

  async resolveCrash(req: Request, res: Response, next: NextFunction) {
    try {
      const { appHealthService } = await import('../services/appHealth.service');
      const resolution = await appHealthService.resolve(req.body.message, req.user!._id.toString(), req.body.note);
      void logAudit(req, {
        action: AuditAction.SETTINGS_UPDATED,
        entity: 'crash_resolution',
        entityId: String(resolution!._id),
        severity: AuditSeverity.LOW,
        description: 'Error de la app marcado como resuelto',
        metadata: { versions: resolution!.versions },
      });
      sendResponse(res, 200, 'Marcado como resuelto', resolution);
    } catch (error) { next(error); }
  }

  async reopenCrash(req: Request, res: Response, next: NextFunction) {
    try {
      const { appHealthService } = await import('../services/appHealth.service');
      const removed = await appHealthService.reopen(req.body.message);
      void logAudit(req, {
        action: AuditAction.SETTINGS_UPDATED,
        entity: 'crash_resolution',
        entityId: String(removed._id),
        severity: AuditSeverity.LOW,
        description: 'Error de la app reabierto',
      });
      sendResponse(res, 200, 'Reabierto');
    } catch (error) { next(error); }
  }

  // ── Users ──

  async getUsers(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await adminService.getUsers(
        query(req, 'role'),
        query(req, 'search'),
        Number(query(req, 'page')) || 1,
        clampLimit(query(req, 'limit')),
        req
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

  async resetUserTwoFactor(req: Request, res: Response, next: NextFunction) {
    try {
      const { temporaryPassword } = await adminService.resetUserTwoFactor(param(req, 'id'), req.body?.reason, req.user!, req);
      sendResponse(res, 200, 'Verificación en dos pasos y contraseña restablecidas', { temporaryPassword });
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

  async correctBirthDate(req: Request, res: Response, next: NextFunction) {
    try {
      const { birthDate } = req.body ?? {};
      if (birthDate !== null && typeof birthDate !== 'string') {
        return sendResponse(res, 400, 'Envía birthDate como AAAA-MM-DD, o null para borrarla');
      }
      const user = await adminService.correctBirthDate(param(req, 'id'), birthDate, req.user!, req);
      sendResponse(res, 200, 'Fecha de nacimiento actualizada', user);
    } catch (error) { next(error); }
  }

  // ── Businesses ──

  async getBusinesses(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await adminService.getBusinesses(
        query(req, 'search'),
        query(req, 'category'),
        Number(query(req, 'page')) || 1,
        clampLimit(query(req, 'limit')),
        query(req, 'archived') === 'true'
      );
      sendResponse(res, 200, 'Negocios obtenidos', result.businesses, result.meta);
    } catch (error) { next(error); }
  }

  async toggleBusiness(req: Request, res: Response, next: NextFunction) {
    try {
      const business = await adminService.toggleBusinessActive(param(req, 'id'), req.body?.reason, req);
      sendResponse(res, 200, `Negocio ${business.isSuspended ? 'suspendido' : 'reactivado'}`, business);
    } catch (error) { next(error); }
  }

  async toggleBusinessFeatured(req: Request, res: Response, next: NextFunction) {
    try {
      const business = await adminService.toggleBusinessFeatured(param(req, 'id'), req);
      sendResponse(res, 200, `Negocio ${business.isFeatured ? 'destacado' : 'quitado de destacados'}`, business);
    } catch (error) { next(error); }
  }

  /**
   * S11: archiva en vez de borrar. `reason` es obligatorio (lo exige
   * `businessService.archive`) — "por qué" queda en el historial, no solo
   * "quién y cuándo".
   */
  async archiveBusiness(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await adminService.archiveBusiness(param(req, 'id'), req.body?.reason, req.user!, req);
      sendResponse(res, 200, 'Negocio archivado', result.business);
    } catch (error) { next(error); }
  }

  async restoreBusiness(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await adminService.restoreBusiness(param(req, 'id'), req);
      sendResponse(res, 200, 'Negocio restaurado', result.business);
    } catch (error) { next(error); }
  }

  // ── Orders ──

  async getAllOrders(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await adminService.getAllOrders({
        maskCommissions: !can(req, Permission.COMMISSIONS_VIEW),
        status: query(req, 'status'),
        city: query(req, 'city'),
        dateFrom: query(req, 'dateFrom'),
        dateTo: query(req, 'dateTo'),
        search: query(req, 'search'),
        page: Number(query(req, 'page')) || 1,
        limit: clampLimit(query(req, 'limit')),
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
        limit: clampLimit(query(req, 'limit')),
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
        clampLimit(query(req, 'limit')),
        query(req, 'businessId')
      );
      sendResponse(res, 200, 'Comisiones obtenidas', { items: result.commissions, totals: result.totals }, result.meta);
    } catch (error) { next(error); }
  }

  // ── Driver Debts ──

  // ── Driver actions ──

  async suspendDriver(req: Request, res: Response, next: NextFunction) {
    try {
      const driver = await adminService.suspendDriver(param(req, 'id'), req, cleanReason(req.body?.reason));
      sendResponse(res, 200, 'Domiciliario suspendido', driver);
    } catch (error) { next(error); }
  }

  async reactivateDriver(req: Request, res: Response, next: NextFunction) {
    try {
      const driver = await adminService.reactivateDriver(param(req, 'id'), req, cleanReason(req.body?.reason));
      sendResponse(res, 200, 'Domiciliario reactivado', driver);
    } catch (error) { next(error); }
  }

  /** Ficha completa de un domiciliario en una sola llamada. */
  async driverProfile360(req: Request, res: Response, next: NextFunction) {
    try {
      const { driverProfile360Service } = await import('../services/driverProfile360.service');
      // Igual que la ficha del cliente: enmascarada por defecto; la completa es deliberada y auditada.
      const view = query(req, 'view') ?? 'masked';
      if (view !== 'masked' && view !== 'full') throw new AppError('Parámetro "view" inválido', 400);
      if (view === 'full' && !can(req, Permission.USERS_VIEW_SENSITIVE)) {
        throw new AppError('No tienes permisos para ver la ficha completa', 403);
      }
      const { internalNoteService } = await import('../services/internalNote.service');
      const profile = await driverProfile360Service.profile360(param(req, 'id'), {
        finance: can(req, Permission.FINANCE_VIEW),
        sensitive: view === 'full',
        noteActor: await internalNoteService.noteActorFromRequest(req),
      });
      if (view === 'full') {
        void logAudit(req, {
          action: AuditAction.PROFILE_VIEWED,
          entity: 'driver',
          entityId: param(req, 'id'),
          severity: AuditSeverity.MEDIUM,
          description: 'Ficha 360 de domiciliario consultada en vista completa',
          metadata: { view: 'full' },
        });
      }
      void logAudit(req, {
        action: AuditAction.PROFILE_VIEWED,
        entity: 'driver',
        entityId: param(req, 'id'),
        severity: AuditSeverity.LOW,
        description: 'Ficha 360 de domiciliario consultada',
        metadata: { view },
      });
      // Identidad, vehículo, operación, seguridad, cuenta e historial: mismo enmascarado que el resto de la ficha.
      const { driverFichaService } = await import('../services/driverFicha.service');
      const ficha = await driverFichaService.build(param(req, 'id'), {
        sensitive: view === 'full',
        finance: can(req, Permission.FINANCE_VIEW),
        track: can(req, Permission.DRIVERS_TRACK),
      });
      sendResponse(res, 200, 'Ficha del domiciliario', { ...profile, ficha });
    } catch (error) { next(error); }
  }
}

/** Motivo opcional de una suspensión o reactivación: texto corto, sin espacios sobrantes. */
function cleanReason(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 300) : undefined;
}

export const adminController = new AdminController();
