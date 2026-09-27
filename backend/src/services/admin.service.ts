import { Request } from 'express';
import crypto from 'crypto';
import { Types } from 'mongoose';
import { User, IUser, Business, Order, Driver, Commission, DriverDebt, Payment, Position, Role } from '../models';
import { platformResultService } from './platformResult.service';
import {
  periodRange,
  isReportPeriod,
  bogotaDateString,
  bogotaDayRange,
  shiftDateString,
  type DateRange,
  type ReportPeriod,
} from '../utils/period';
import { escapeRegex } from '../utils';
import { AppError } from '../middlewares';
import { businessService } from './business.service';
import { OrderStatus, PaymentStatus, PaymentMethod, DebtStatus, CommissionStatus, UserRole } from '../types';
import { logAudit, AuditAction, AuditSeverity, validatePasswordComplexity, clearAccountLocks } from '../security';
import { sessionManager } from '../security/sessions';
import { SecurityEventType } from '../models/SecurityEvent';
import { recordSecurityEvent } from './securityEvent.service';
import {
  assertNotSelfTarget,
  assertCanAssignRoles,
  assertTargetIsAdmin,
  assertCanModifyPrivilegedUser,
  assertCanTakeOverAccount,
  assertIsSuperAdmin,
  getEffectivePermissions,
  getEffectiveRoles,
} from './authorization.service';
import { TERMINAL_ORDER_STATUSES } from './order.service';
import { clearTwoFactor } from './mfa.service';
import { getIO } from '../sockets/emitter';

/**
 * Cambiar rol, cargo o roles cambia a qué salas de socket tiene derecho la
 * persona (`admin:*`, tracking). Las salas se calculan al conectar, así que se
 * corta la conexión para que el cliente reconecte y las recalcule.
 */
function disconnectUserSockets(userId: string): void {
  getIO()?.in(`user:${userId}`).disconnectSockets(true);
}
import { normalizePhone } from '../utils/phone';
import { auditSensitiveSearch } from './adminSearch.service';
import { maskEmail } from '../utils/mask';
import { customerFinanceView } from './profileMasking';
import { parseBirthDate, birthDateProblem } from '../utils/age';

/**
 * Agregados de pedidos de un periodo, calculados en la base sobre TODOS los
 * pedidos del rango (antes el panel los sacaba de los 6 más recientes).
 *
 * - `paymentBreakdown` y `deliveryRate` cuentan eventos del periodo: un
 *   pedido cuenta como entregado el día que se entregó y como cancelado el
 *   día que se canceló, igual que el Resumen diario.
 * - `ordersByStatus` es la cohorte creada en el periodo, con su estado actual.
 *
 * El dinero es el total que pagó el cliente (`finance.customerTotal`, con
 * respaldo al campo plano `total` para pedidos anteriores a la migración).
 * Es GMV: NO es ingreso de ZIPP; ese sale de `platformResultService`.
 */
async function getOrderPeriodStats(range: DateRange) {
  const inRange = { $gte: range.from, $lte: range.to };
  const deliveredInRange = { status: OrderStatus.DELIVERED, deliveredAt: inRange };

  const [payments, cancelled, byStatus] = await Promise.all([
    Order.aggregate([
      { $match: deliveredInRange },
      {
        $group: {
          _id: '$paymentMethod',
          count: { $sum: 1 },
          amount: { $sum: { $ifNull: ['$finance.customerTotal', { $ifNull: ['$total', 0] }] } },
        },
      },
    ]),
    Order.countDocuments({ status: OrderStatus.CANCELLED, cancelledAt: inRange }),
    Order.aggregate([
      { $match: { createdAt: inRange } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
  ]);

  const bucket = (method: PaymentMethod) => {
    const row = payments.find((p) => p._id === method);
    return { count: row?.count ?? 0, amount: row?.amount ?? 0 };
  };
  const online = bucket(PaymentMethod.ONLINE);
  const cash = bucket(PaymentMethod.CASH_ON_DELIVERY);

  const delivered = payments.reduce((sum, p) => sum + p.count, 0);
  const closed = delivered + cancelled;

  const ordersByStatus = Object.fromEntries(
    Object.values(OrderStatus).map((status) => [
      status,
      byStatus.find((r) => r._id === status)?.count ?? 0,
    ])
  ) as Record<OrderStatus, number>;

  return {
    paymentBreakdown: { online, cash },
    /** Porcentaje 0–100 (un decimal); `null` si en el periodo no se cerró ningún pedido. */
    deliveryRate: closed > 0 ? Math.round((delivered / closed) * 1000) / 10 : null,
    deliveredCount: delivered,
    cancelledCount: cancelled,
    ordersByStatus,
  };
}

/**
 * Pone una contraseña temporal a la cuenta y cierra todas sus sesiones. La
 * comparten el reset de contraseña, el de 2FA y el script de emergencia
 * (`scripts/emergencyReset2fa.ts`). El valor en claro solo existe en el
 * retorno: no se persiste ni va a la auditoría.
 */
export async function issueTemporaryPassword(user: IUser, updatedBy?: Types.ObjectId, req?: Request): Promise<string> {
  const temporaryPassword = crypto.randomBytes(9).toString('base64url') + 'Aa1!';
  const check = validatePasswordComplexity(temporaryPassword);
  if (!check.valid) throw new AppError('No se pudo generar una contraseña temporal válida', 500);

  user.password = temporaryPassword; // el hook pre-save la hashea
  user.failedLoginAttempts = 0;
  user.lockedUntil = undefined;
  // S10: no hay envío de correo/SMS en este repo, así que quien restablece
  // ve la temporal una vez — pero la temporal caduca sola a las 24h
  // (`auth.service.ts::assertAccountUsable`), en vez de servir
  // indefinidamente como una contraseña más.
  user.mustChangePassword = true;
  user.passwordExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  if (updatedBy) user.updatedBy = updatedBy;
  await user.save();

  const sessionsRevoked = await sessionManager.revokeAllSessions(user._id.toString(), {
    reason: 'admin',
    revokedBy: updatedBy ? String(updatedBy) : null,
  });
  if (user.phone) await clearAccountLocks(user.phone);
  await recordSecurityEvent({
    userId: user._id,
    role: user.role,
    req,
    type: SecurityEventType.PASSWORD_CHANGED,
    reason: 'admin_reset',
    actorId: updatedBy ?? null,
    metadata: { how: 'admin_reset', sessionsRevoked },
  });
  return temporaryPassword;
}

/**
 * Deja en el historial de seguridad (si es una cuenta de comercio) que un
 * administrador le cerró las sesiones al cambiarle el estado, el rol o el
 * contacto. Sin esto el comercio veía sus sesiones desaparecer sin rastro.
 */
async function recordAdminRevocation(
  user: IUser,
  actor: IUser,
  reason: string,
  count: number,
  req?: Request
): Promise<void> {
  if (count === 0) return;
  await recordSecurityEvent({
    userId: user._id,
    role: user.role,
    req,
    type: SecurityEventType.ADMIN_SESSION_REVOCATION,
    reason,
    actorId: actor._id,
    metadata: { scope: 'user', count },
  });
}

export class AdminService {
  // ── Dashboard Stats ──
  async getDashboardStats() {
    const { from: todayStart, to: todayEnd } = periodRange('today');
    const { from: weekStart } = periodRange('week');

    const [
      totalUsers,
      totalBusinesses,
      activeBusinesses,
      totalDrivers,
      approvedDrivers,
      totalOrders,
      activeOrders,
      todayOrders,
      weekOrders,
      todayGmv,
      todayResult,
      todayOrderStats,
    ] = await Promise.all([
      User.countDocuments({ isActive: true }),
      Business.countDocuments(),
      Business.countDocuments({ isActive: true }),
      Driver.countDocuments(),
      Driver.countDocuments({ isApproved: true, isActive: true }),
      Order.countDocuments(),
      Order.countDocuments({ status: { $nin: [OrderStatus.DELIVERED, OrderStatus.CANCELLED] } }),
      Order.countDocuments({ createdAt: { $gte: todayStart, $lte: todayEnd } }),
      Order.countDocuments({ createdAt: { $gte: weekStart } }),
      Order.aggregate([
        { $match: { status: OrderStatus.DELIVERED, deliveredAt: { $gte: todayStart, $lte: todayEnd } } },
        { $group: { _id: null, total: { $sum: '$total' } } },
      ]),
      platformResultService.forRange({ from: todayStart, to: todayEnd }),
      getOrderPeriodStats({ from: todayStart, to: todayEnd }),
    ]);

    return {
      totalUsers,
      totalBusinesses,
      activeBusinesses,
      totalDrivers,
      approvedDrivers,
      totalOrders,
      activeOrders,
      todayOrders,
      weekOrders,
      /** GMV de los pedidos entregados hoy (lo que pagaron los clientes). No es ingreso de ZIPP. */
      todayRevenue: todayGmv[0]?.total || 0,
      /**
       * @deprecated Alias de `platformResult.grossRevenue` (ingreso bruto de
       * ZIPP según el libro mayor, NO solo la comisión del comercio). Se
       * conserva un ciclo para que el panel actual no muestre 0; migrar a
       * `platformResult` y retirar.
       */
      todayCommission: todayResult.grossRevenue,
      // Agregados reales del día, calculados en la base sobre todos los pedidos.
      platformResult: todayResult,
      ...todayOrderStats,
    };
  }

  // ── Financial Summary ──
  /**
   * Resumen del periodo en hora de Colombia. El ingreso de ZIPP
   * (`platformResult`) sale del libro mayor, con la misma función que usan
   * el Dashboard, el Resumen diario y Finanzas: mismo periodo, mismo número.
   * `totalRevenue` es GMV (lo que pagaron los clientes), no ingreso.
   */
  async getFinancialSummary(period: ReportPeriod = 'today') {
    const range = periodRange(isReportPeriod(period) ? period : 'today');

    const [deliveredOrders, pendingDebts, platformResult, orderStats] = await Promise.all([
      Order.aggregate([
        { $match: { status: OrderStatus.DELIVERED, deliveredAt: { $gte: range.from, $lte: range.to } } },
        {
          $group: {
            _id: null,
            totalRevenue: { $sum: '$total' },
            platformEarnings: { $sum: '$platformCommission' },
            businessPayouts: { $sum: '$businessPayout' },
            driverPayouts: { $sum: '$driverPayout' },
            count: { $sum: 1 },
          },
        },
      ]),
      DriverDebt.aggregate([
        { $match: { status: DebtStatus.PENDING } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]),
      platformResultService.forRange(range),
      getOrderPeriodStats(range),
    ]);

    const stats = deliveredOrders[0] || {};

    // `settledCommissions` se retiró: salía de `Commission` con estado
    // SETTLED, y ese modelo nunca pasa de PENDING (la liquidación real vive
    // en `Payout` y en el libro), así que era un 0 permanente que parecía
    // dato. Lo liquidado de verdad está en GET /finance/payouts/summary.
    return {
      /** GMV de los pedidos entregados en el periodo (lo que pagaron los clientes). No es ingreso de ZIPP. */
      totalRevenue: stats.totalRevenue || 0,
      /**
       * @deprecated Alias de `platformResult.grossRevenue` (ingreso bruto de
       * ZIPP según el libro mayor). Antes era solo `platformCommission` de
       * los pedidos. Migrar el panel a `platformResult` y retirar.
       */
      platformEarnings: platformResult.grossRevenue,
      totalBusinessPayouts: stats.businessPayouts || 0,
      totalDriverPayouts: stats.driverPayouts || 0,
      totalOrders: stats.count || 0,
      pendingDriverDebts: pendingDebts[0]?.total || 0,
      period,
      from: range.from.toISOString(),
      to: range.to.toISOString(),
      platformResult,
      ...orderStats,
    };
  }

  // ── Revenue chart por día (días de Bogotá) ──
  async getRevenueChart(days = 30) {
    const today = bogotaDateString();
    const startDate = bogotaDayRange(shiftDateString(today, -(days - 1))).from;
    const range = { from: startDate, to: bogotaDayRange(today).to };

    const [orders, ledgerDays] = await Promise.all([
      Order.aggregate([
        { $match: { status: OrderStatus.DELIVERED, deliveredAt: { $gte: range.from, $lte: range.to } } },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$deliveredAt', timezone: '-05:00' } },
            revenue: { $sum: '$total' },
            orders: { $sum: 1 },
          },
        },
      ]),
      platformResultService.grossRevenueByDay(range),
    ]);

    // Unión de los dos orígenes por día: un día con solo un reembolso (sin
    // entregas) también tiene que aparecer, con su ingreso negativo.
    const byDay = new Map<string, { _id: string; revenue: number; platformRevenue: number; orders: number }>();
    const row = (id: string) => {
      let r = byDay.get(id);
      if (!r) byDay.set(id, (r = { _id: id, revenue: 0, platformRevenue: 0, orders: 0 }));
      return r;
    };
    for (const o of orders) Object.assign(row(o._id), { revenue: o.revenue, orders: o.orders });
    for (const l of ledgerDays) row(l._id).platformRevenue = l.grossRevenue;

    return [...byDay.values()].sort((a, b) => (a._id < b._id ? -1 : 1));
  }

  // ── Users Management ──
  async getUsers(role?: string, search?: string, page = 1, limit = 20, req?: Request) {
    const filter: Record<string, unknown> = {};
    if (role) filter.role = role;
    if (search) {
      // Buscar por teléfono o correo deja huella (hash, nunca el término).
      if (req) await auditSensitiveSearch(req, search, '/api/v1/admin/users', true);
      filter.$or = [
        { name: { $regex: escapeRegex(search), $options: 'i' } },
        { phone: { $regex: escapeRegex(search), $options: 'i' } },
        { email: { $regex: escapeRegex(search), $options: 'i' } },
      ];
    }
    const skip = (page - 1) * limit;
    const [users, total] = await Promise.all([
      User.find(filter).skip(skip).limit(limit).sort({ createdAt: -1 }),
      User.countDocuments(filter),
    ]);
    return { users, meta: { page, limit, total, totalPages: Math.ceil(total / limit) } };
  }

  async toggleUserActive(userId: string, actor: IUser, req?: Request) {
    assertNotSelfTarget(actor._id.toString(), userId, 'No puedes activar/desactivar tu propia cuenta');

    const user = await User.findById(userId);
    if (!user) throw new AppError('Usuario no encontrado', 404);
    await assertCanModifyPrivilegedUser(actor, user);

    user.isActive = !user.isActive;
    if (!user.isActive) {
      user.deactivatedAt = new Date();
    } else {
      user.isBlocked = false;
      user.deactivatedAt = undefined;
    }
    user.updatedBy = actor._id;
    await user.save();

    if (!user.isActive) {
      const count = await sessionManager.revokeAllSessions(userId, { reason: 'admin', revokedBy: actor._id.toString() });
      await recordAdminRevocation(user, actor, 'account_deactivated', count, req);
    }

    if (req) {
      await logAudit(req, {
        action: user.isActive ? AuditAction.USER_ACTIVATED : AuditAction.USER_DEACTIVATED,
        entity: 'user',
        entityId: userId,
        severity: AuditSeverity.HIGH,
        description: `${user.name} ${user.isActive ? 'activado' : 'desactivado'} por un administrador`,
      });
    }

    return user;
  }

  async updateUserRole(userId: string, newRole: string, actor: IUser, req?: Request) {
    if (!Object.values(UserRole).includes(newRole as UserRole)) {
      throw new AppError('Rol inválido', 400);
    }
    // Nadie modifica su propia autorización, ni siquiera el tipo de cuenta:
    // sin esto, un admin con `users:role_change` podría degradarse o
    // "re-confirmarse" a sí mismo para sortear otra regla.
    assertNotSelfTarget(actor._id.toString(), userId, 'No puedes cambiar tu propio rol');

    const user = await User.findById(userId);
    if (!user) throw new AppError('Usuario no encontrado', 404);
    await assertCanModifyPrivilegedUser(actor, user);

    // S9: ascender a alguien a `admin` es la puerta de entrada al panel.
    // Antes cualquier cuenta con `users:role_change` (todo ADMIN legacy)
    // podía crear administradores nuevos con solo cambiar el rol.
    if (newRole === UserRole.ADMIN && user.role !== UserRole.ADMIN) {
      await assertIsSuperAdmin(actor, 'Solo un Super Administrador puede ascender una cuenta a administrador');
    }

    const previousRole = user.role;
    user.role = newRole as UserRole;
    user.updatedBy = actor._id;
    await user.save();

    // M1(a): un rol nuevo es un nivel de acceso nuevo. La sesión vieja
    // quedaba viva con el rol viejo cacheado en su token hasta que
    // caducara sola (hasta 8h de staff) — suficiente para que alguien
    // recién ascendido a admin, o alguien recién degradado, siguiera
    // operando con el permiso anterior.
    const revokedByRoleChange = await sessionManager.revokeAllSessions(userId, {
      reason: 'role_changed',
      revokedBy: actor._id.toString(),
    });
    await recordAdminRevocation(user, actor, 'role_changed', revokedByRoleChange, req);
    disconnectUserSockets(userId);

    if (req) {
      await logAudit(req, {
        action: AuditAction.ROLE_CHANGED,
        entity: 'user',
        entityId: userId,
        severity: newRole === UserRole.ADMIN ? AuditSeverity.CRITICAL : AuditSeverity.HIGH,
        description: `Rol de ${user.name} cambiado de "${previousRole}" a "${newRole}"`,
        metadata: { previousRole, newRole },
      });
    }

    return user;
  }

  // ── Seguridad y Acceso: Cargo, Roles, estado ──

  async assignPosition(
    userId: string,
    positionId: string | null,
    actor: IUser,
    req?: Request
  ) {
    assertNotSelfTarget(actor._id.toString(), userId, 'No puedes asignarte un cargo a ti mismo');

    const user = await User.findById(userId);
    if (!user) throw new AppError('Usuario no encontrado', 404);
    await assertCanModifyPrivilegedUser(actor, user);

    if (positionId) {
      // Un Cargo solo se asigna a cuentas administrativas (quitarlo, a cualquiera).
      assertTargetIsAdmin(user);
      const position = await Position.findById(positionId);
      if (!position) throw new AppError('Cargo no encontrado', 404);
      // El Cargo trae Roles consigo: mismas guardas que al asignar Roles
      // (SUPER_ADMIN y "no otorgar más de lo que posees"). Si el usuario ya
      // tenía ese Cargo no se otorga nada nuevo.
      if (user.positionId?.toString() !== position._id.toString()) {
        await assertCanAssignRoles(actor, position.roleIds);
      }
      user.positionId = position._id;
    } else {
      user.positionId = undefined;
    }
    user.updatedBy = actor._id;
    await user.save();
    disconnectUserSockets(userId);

    if (req) {
      await logAudit(req, {
        action: AuditAction.USER_POSITION_ASSIGNED,
        entity: 'user',
        entityId: userId,
        severity: AuditSeverity.MEDIUM,
        description: `Cargo de ${user.name} actualizado`,
        metadata: { positionId },
      });
    }

    return user;
  }

  async assignRoles(userId: string, roleIds: string[], actor: IUser, req?: Request) {
    assertNotSelfTarget(actor._id.toString(), userId, 'No puedes asignarte roles a ti mismo');

    const user = await User.findById(userId);
    if (!user) throw new AppError('Usuario no encontrado', 404);
    await assertCanModifyPrivilegedUser(actor, user);

    const uniqueIds = Array.from(new Set(roleIds));
    if (uniqueIds.length > 0) {
      // Los roles solo se asignan a cuentas administrativas (vaciarlos, a cualquiera).
      assertTargetIsAdmin(user);
      const found = await Role.find({ _id: { $in: uniqueIds } }).select('_id');
      if (found.length !== uniqueIds.length) {
        throw new AppError('Uno o más roles seleccionados no existen', 400);
      }
    }
    // Único punto que decide si esta asignación puede incluir SUPER_ADMIN o
    // permisos que el actor no posee. Solo se evalúa lo que se AÑADE: los
    // roles que el usuario ya tenía se conservan sin volver a exigirlos.
    const current = new Set((user.roleIds || []).map((id) => id.toString()));
    await assertCanAssignRoles(actor, uniqueIds.filter((id) => !current.has(String(id))));

    user.roleIds = uniqueIds as any;
    user.updatedBy = actor._id;
    await user.save();
    disconnectUserSockets(userId);

    if (req) {
      await logAudit(req, {
        action: AuditAction.USER_ROLES_ASSIGNED,
        entity: 'user',
        entityId: userId,
        severity: AuditSeverity.HIGH,
        description: `Roles de ${user.name} actualizados (${uniqueIds.length})`,
        metadata: { roleIds: uniqueIds },
      });
    }

    return user;
  }

  async getEffectiveAccess(userId: string) {
    // Sin poblar: `getEffectivePermissions`/`getEffectiveRoles` esperan
    // `roleIds`/`positionId` como ObjectIds crudos, no subdocumentos ya
    // resueltos. El detalle de nombre/slug de cada rol ya viaja en
    // `effectiveRoles` — no hace falta poblar `user` para eso.
    const user = await User.findById(userId);
    if (!user) throw new AppError('Usuario no encontrado', 404);

    const [permissions, roles, populated] = await Promise.all([
      getEffectivePermissions(user),
      getEffectiveRoles(user),
      User.findById(userId).populate('positionId', 'name slug').populate('roleIds', 'name slug'),
    ]);

    return {
      user: populated,
      status: user.status,
      permissions,
      effectiveRoles: roles.map((r) => ({ id: r._id, name: r.name, slug: r.slug })),
    };
  }

  /**
   * ACTIVO / INACTIVO / BLOQUEADO, unificado en un solo método (en vez de
   * cuatro endpoints con lógica repetida). Bloquear o desactivar revoca
   * las sesiones activas de inmediato — ver sección 13 de la spec.
   */
  async setUserStatus(
    userId: string,
    status: 'active' | 'inactive' | 'blocked',
    actor: IUser,
    reason: string | undefined,
    req?: Request
  ) {
    assertNotSelfTarget(actor._id.toString(), userId, 'No puedes cambiar el estado de tu propia cuenta');
    // Decisión del dueño (2026-09-24): bloquear, desbloquear y activar/desactivar
    // cuentas no es delegable; `users:block` no otorga esto.
    await assertIsSuperAdmin(actor, 'Solo un Super Administrador puede bloquear, desbloquear o desactivar cuentas');

    const user = await User.findById(userId);
    if (!user) throw new AppError('Usuario no encontrado', 404);
    await assertCanModifyPrivilegedUser(actor, user);

    const previousStatus = user.status;

    if (status === 'active') {
      user.isActive = true;
      user.isBlocked = false;
      user.deactivatedAt = undefined;
    } else if (status === 'inactive') {
      user.isActive = false;
      user.isBlocked = false;
      user.deactivatedAt = new Date();
    } else {
      user.isActive = false;
      user.isBlocked = true;
      user.deactivatedAt = new Date();
    }
    user.updatedBy = actor._id;
    await user.save();

    if (status !== 'active') {
      const count = await sessionManager.revokeAllSessions(userId, { reason: 'admin', revokedBy: actor._id.toString() });
      await recordAdminRevocation(user, actor, status === 'blocked' ? 'account_blocked' : 'account_deactivated', count, req);
    }

    if (req) {
      const action =
        status === 'blocked' ? AuditAction.USER_BLOCKED
          : status === 'inactive' ? AuditAction.USER_DEACTIVATED
          : previousStatus === 'blocked' ? AuditAction.USER_UNBLOCKED
          : AuditAction.USER_ACTIVATED;
      await logAudit(req, {
        action,
        entity: 'user',
        entityId: userId,
        severity: status === 'blocked' ? AuditSeverity.CRITICAL : AuditSeverity.HIGH,
        description: `Estado de ${user.name} cambiado de "${previousStatus}" a "${status}"${reason ? `: ${reason}` : ''}`,
        metadata: { previousStatus, status, reason },
      });
    }

    return user;
  }

  /**
   * Restablece la contraseña de un usuario desde el panel. Genera una
   * contraseña temporal segura, la aplica (queda hasheada por el hook
   * `pre('save')` del modelo) y revoca todas las sesiones activas — quien
   * tenía una sesión abierta con la contraseña anterior queda fuera. El
   * valor en claro solo existe en esta respuesta; no se persiste ni se
   * registra en el log de auditoría.
   */
  async resetUserPassword(userId: string, actor: IUser, req?: Request): Promise<{ user: IUser; temporaryPassword: string }> {
    assertNotSelfTarget(actor._id.toString(), userId, 'Usa "Cambiar contraseña" en tu perfil para tu propia cuenta');

    const user = await User.findById(userId);
    if (!user) throw new AppError('Usuario no encontrado', 404);
    // El panel ve la contraseña temporal: sobre una cuenta administrativa
    // eso es tomarla, así que exige Super Administrador.
    await assertCanTakeOverAccount(actor, user);

    const temporaryPassword = await issueTemporaryPassword(user, actor._id, req);

    if (req) {
      await logAudit(req, {
        action: AuditAction.PASSWORD_RESET,
        entity: 'user',
        entityId: userId,
        severity: AuditSeverity.CRITICAL,
        description: `Contraseña de ${user.name} restablecida por un administrador`,
      });
    }

    return { user, temporaryPassword };
  }

  /**
   * Quita el 2FA de una cuenta que perdió el celular y sus códigos de
   * recuperación. Sin esto, un comercio con 2FA obligatorio que cambia de
   * teléfono quedaba fuera para siempre y dejaba de recibir pedidos.
   *
   * Es un segundo factor que se cae, así que: permiso propio
   * (`users:reset_2fa`), motivo obligatorio, la misma guarda que tomar una
   * cuenta (nunca la propia; sobre un admin, solo Super Administrador).
   *
   * Y rota la contraseña en la misma acción. Sin eso, la cuenta quedaba con
   * un solo factor y era de quien se enrolara primero: quien tuviera la
   * contraseña robada llamaba a soporte "porque perdió el celular" y, en
   * cuanto el login dejaba de pedir el código, registraba SU autenticador.
   * La temporal se entrega por el canal donde se verificó la identidad.
   */
  async resetUserTwoFactor(
    userId: string,
    reason: unknown,
    actor: IUser,
    req?: Request
  ): Promise<{ temporaryPassword: string }> {
    const cleanReason = typeof reason === 'string' ? reason.trim() : '';
    if (cleanReason.length < 10 || cleanReason.length > 500) {
      throw new AppError('Escribe el motivo del restablecimiento (entre 10 y 500 caracteres)', 400);
    }
    if (!Types.ObjectId.isValid(userId)) throw new AppError('Usuario no encontrado', 404);

    const user = await User.findById(userId);
    if (!user) throw new AppError('Usuario no encontrado', 404);
    await assertCanTakeOverAccount(actor, user);

    // Primero el 2FA, que es la compuerta atómica: dos clics simultáneos no
    // pueden rotar dos veces la contraseña y dejar inválida la que el panel
    // ya mostró.
    const notEnabled = new AppError('Esta cuenta no tiene la verificación en dos pasos activa', 409);
    if (!user.twoFactorEnabled || !(await clearTwoFactor(user._id, actor._id))) throw notEnabled;

    // También revoca todas las sesiones.
    const temporaryPassword = await issueTemporaryPassword(user, actor._id, req);
    await recordSecurityEvent({
      userId: user._id,
      role: user.role,
      req,
      type: SecurityEventType.SECURITY_SETTINGS_CHANGED,
      reason: 'two_factor_reset_by_admin',
      note: cleanReason,
      actorId: actor._id,
    });

    if (req) {
      await logAudit(req, {
        action: AuditAction.TOTP_RESET_BY_ADMIN,
        entity: 'user',
        entityId: userId,
        severity: AuditSeverity.CRITICAL,
        description: `Verificación en dos pasos y contraseña de ${user.name} restablecidas por un administrador: ${cleanReason}`,
        metadata: { reason: cleanReason, targetRole: user.role, passwordRotated: true },
      });
    }

    return { temporaryPassword };
  }

  /**
   * Crea una cuenta administrativa directamente desde el panel (a
   * diferencia de `/auth/register`, que solo permite client/driver/business
   * y no acepta Cargo/Roles). Requiere `users:create`.
   */
  async createStaffUser(
    data: { name: string; phone?: string; email: string; password: string; positionId?: string; roleIds?: string[] },
    actor: IUser,
    req?: Request
  ): Promise<IUser> {
    // S9: crear una cuenta administrativa es crear acceso al panel — solo
    // el Super Administrador, igual que ascender a alguien a `admin`.
    await assertIsSuperAdmin(actor, 'Solo un Super Administrador puede crear cuentas de equipo');

    // El panel admin entra por correo (ver `auth.service.ts::login`), así
    // que toda cuenta creada desde aquí necesita uno; el celular queda
    // opcional, a diferencia de antes.
    const normalizedEmail = data.email?.trim().toLowerCase();
    if (!normalizedEmail || !/^\S+@\S+\.\S+$/.test(normalizedEmail)) {
      throw new AppError('Correo electrónico inválido', 400);
    }
    const existingEmail = await User.findOne({ email: normalizedEmail });
    if (existingEmail) throw new AppError('Este correo electrónico ya está registrado', 409);

    let normalizedPhone: string | undefined;
    if (data.phone) {
      normalizedPhone = normalizePhone(data.phone) ?? undefined;
      if (!normalizedPhone) throw new AppError('Número de celular inválido', 400);
      const existingPhone = await User.findOne({ phone: normalizedPhone });
      if (existingPhone) throw new AppError('Este número de celular ya está registrado', 409);
    }

    data = { ...data, email: normalizedEmail, phone: normalizedPhone };
    if (!data.name || data.name.trim().length < 2) {
      throw new AppError('El nombre es requerido', 400);
    }

    const passwordCheck = validatePasswordComplexity(data.password);
    if (!passwordCheck.valid) throw new AppError(passwordCheck.errors.join('. '), 400);

    const roleIds = Array.from(new Set(data.roleIds || []));
    if (roleIds.length > 0) {
      const found = await Role.find({ _id: { $in: roleIds } }).select('_id');
      if (found.length !== roleIds.length) throw new AppError('Uno o más roles seleccionados no existen', 400);
    }
    if (data.positionId) {
      const position = await Position.findById(data.positionId);
      if (!position) throw new AppError('Cargo no encontrado', 404);
      await assertCanAssignRoles(actor, position.roleIds);
    }
    await assertCanAssignRoles(actor, roleIds);

    const user = await User.create({
      name: data.name,
      phone: data.phone,
      email: data.email,
      password: data.password,
      role: UserRole.ADMIN,
      isActive: true,
      isVerified: true,
      positionId: data.positionId || undefined,
      roleIds,
      createdBy: actor._id,
      updatedBy: actor._id,
    });

    if (req) {
      await logAudit(req, {
        action: AuditAction.REGISTER,
        entity: 'user',
        entityId: user._id.toString(),
        severity: AuditSeverity.HIGH,
        description: `Cuenta administrativa creada: ${user.name} (${maskEmail(user.email)})`,
        metadata: { positionId: data.positionId, roleIds, withoutRole: roleIds.length === 0 && !data.positionId },
      });
    }

    return user;
  }

  /**
   * Phone/email verified via OTP login are locked for self-service edits
   * (see auth.service.updateProfile). This is the only way to change one —
   * it resets the corresponding *Verified flag so the user must re-confirm
   * the new value through the normal OTP flow before it locks again.
   *
   * Cambiar el contacto de alguien equivale a poder entrar en su cuenta (el
   * OTP llega al número nuevo), así que:
   * - nadie lo hace sobre su propia cuenta por esta vía,
   * - sobre una cuenta administrativa o financiera exige Super Administrador,
   * - todas las sesiones de la cuenta se cierran,
   * - y en una cuenta con 2FA el número nuevo no basta para entrar: el login
   *   por OTP sigue pidiendo el segundo factor (ver `AuthService.completeLogin`).
   */
  /**
   * Corrige (o borra, con `null`) la fecha de nacimiento de un cliente.
   *
   * El propio usuario la guarda una sola vez (ver `authService.updateProfile`)
   * porque decide si puede pedir productos +18; esta es la vía de soporte
   * para un error de digitación. No da acceso a la cuenta, así que no pide
   * lo que `overrideUserContact`, pero queda auditada con el valor anterior.
   */
  async correctBirthDate(userId: string, value: string | null, actor: IUser, req?: Request) {
    const user = await User.findById(userId);
    if (!user) throw new AppError('Usuario no encontrado', 404);

    let birthDate: Date | undefined;
    if (value !== null) {
      const parsed = parseBirthDate(value);
      if (!parsed) throw new AppError('Fecha de nacimiento inválida (AAAA-MM-DD)', 400);
      const problem = birthDateProblem(parsed);
      if (problem) throw new AppError(problem, 400);
      birthDate = parsed;
    }

    const previous = user.birthDate ? user.birthDate.toISOString().slice(0, 10) : null;
    user.birthDate = birthDate;
    user.updatedBy = actor._id;
    await user.save();

    if (req) {
      await logAudit(req, {
        action: AuditAction.PROFILE_UPDATED,
        entity: 'user',
        entityId: userId,
        severity: AuditSeverity.HIGH,
        description: `Admin ${actor._id.toString()} corrigió la fecha de nacimiento del usuario ${userId}`,
        metadata: { updatedFields: ['birthDate'], previous, next: value },
      });
    }

    return user;
  }

  async overrideUserContact(
    userId: string,
    data: { phone?: string; email?: string },
    actor: IUser,
    req?: Request
  ) {
    const user = await User.findById(userId);
    if (!user) throw new AppError('Usuario no encontrado', 404);
    await assertCanTakeOverAccount(actor, user);

    const updatedFields: string[] = [];
    const unset: Record<string, 1> = {};

    if (data.phone !== undefined) {
      const phone = normalizePhone(data.phone);
      if (!phone) throw new AppError('Número de celular inválido', 400);

      if (phone !== user.phone) {
        const existing = await User.findOne({ phone, _id: { $ne: userId } });
        if (existing) {
          throw new AppError('Este número de celular ya está registrado por otro usuario', 409);
        }
        user.phone = phone;
        user.phoneVerified = false;
        user.pendingPhone = undefined;
        // Un OTP pedido para el número anterior no puede servir con el nuevo.
        Object.assign(unset, {
          otpCode: 1, otpExpires: 1, otpAttempts: 1,
          pendingPhoneOtpCode: 1, pendingPhoneOtpExpires: 1, pendingPhoneOtpAttempts: 1,
        });
        updatedFields.push('phone');
      }
    }

    if (data.email !== undefined) {
      const trimmedEmail = data.email.trim().toLowerCase();
      if (trimmedEmail !== (user.email || '')) {
        if (trimmedEmail !== '') {
          const existingEmail = await User.findOne({ email: trimmedEmail, _id: { $ne: userId } });
          if (existingEmail) {
            throw new AppError('Este correo electrónico ya está registrado por otro usuario', 409);
          }
          user.email = trimmedEmail;
        } else {
          user.email = undefined;
        }
        user.emailVerified = false;
        Object.assign(unset, { emailOtpCode: 1, emailOtpExpires: 1, emailOtpAttempts: 1 });
        updatedFields.push('email');
      }
    }

    if (updatedFields.length === 0) return user;

    user.updatedBy = actor._id;
    await user.save();
    if (Object.keys(unset).length) await User.updateOne({ _id: user._id }, { $unset: unset });

    const revokedSessions = await sessionManager.revokeAllSessions(userId, {
      reason: 'contact_changed',
      revokedBy: actor._id.toString(),
    });
    await recordAdminRevocation(user, actor, 'contact_changed', revokedSessions, req);

    if (req) {
      await logAudit(req, {
        action: AuditAction.USER_CONTACT_OVERRIDDEN,
        entity: 'user',
        entityId: userId,
        severity: AuditSeverity.CRITICAL,
        description: `Admin ${actor._id.toString()} sobrescribió ${updatedFields.join(', ')} del usuario ${userId}`,
        metadata: { updatedFields, revokedSessions },
      });
    }

    return user;
  }

  // ── Business Management ──
  async getBusinesses(search?: string, category?: string, page = 1, limit = 20, archived = false) {
    // Por defecto, el archivo (S11) queda fuera del listado normal del
    // panel — es la lista aparte de "archivados" la que lo pide. `$ne`
    // (no `isArchived: false`) porque un negocio de antes de este cambio
    // no tiene el campo todavía, y una igualdad estricta lo dejaría fuera
    // de los dos listados.
    const filter: Record<string, unknown> = archived ? { isArchived: true } : { isArchived: { $ne: true } };
    if (category) filter.category = category;
    if (search) {
      filter.$or = [
        { name: { $regex: escapeRegex(search), $options: 'i' } },
        { city: { $regex: escapeRegex(search), $options: 'i' } },
      ];
    }
    const skip = (page - 1) * limit;
    const [businesses, total] = await Promise.all([
      Business.find(filter).skip(skip).limit(limit).sort({ createdAt: -1 }).populate('ownerId', 'name phone'),
      Business.countDocuments(filter),
    ]);
    return { businesses, meta: { page, limit, total, totalPages: Math.ceil(total / limit) } };
  }

  /**
   * A1: suspender/levantar suspensión, no `isActive`.
   *
   * `isActive` es el interruptor "abierto/cerrado" del propio dueño (su
   * PUT normal). Lo que este botón del panel hace es distinto: ZIPP saca
   * al negocio de la app por incumplimiento, fraude o disputa, y el dueño
   * no puede revertirlo solo. El motivo es obligatorio al suspender —queda
   * en el historial, no solo "quién y cuándo"— y no lo es al levantarla.
   */
  async toggleBusinessActive(businessId: string, reason: string | undefined, req?: Request) {
    const business = await Business.findById(businessId);
    if (!business) throw new AppError('Negocio no encontrado', 404);
    const wasSuspended = business.isSuspended;
    const willSuspend = !wasSuspended;

    if (willSuspend && (!reason || !reason.trim())) {
      throw new AppError('El motivo de la suspensión es obligatorio', 400);
    }

    business.isSuspended = willSuspend;
    business.suspendedAt = willSuspend ? new Date() : null;
    business.suspendedBy = willSuspend ? (req?.user?._id as any) ?? null : null;
    business.suspensionReason = willSuspend ? reason!.trim() : null;
    await business.save();

    if (req) {
      await logAudit(req, {
        action: AuditAction.BUSINESS_TOGGLED_ACTIVE,
        entity: 'business',
        entityId: businessId,
        severity: AuditSeverity.HIGH,
        description: `Negocio ${business.name} ${business.isSuspended ? 'suspendido' : 'reactivado'}${business.isSuspended && reason ? `: ${reason}` : ''}`,
        metadata: { wasSuspended, isSuspended: business.isSuspended, reason },
      });
    }

    return business;
  }

  async toggleBusinessFeatured(businessId: string, req?: Request) {
    const business = await Business.findById(businessId);
    if (!business) throw new AppError('Negocio no encontrado', 404);
    business.isFeatured = !business.isFeatured;
    await business.save();

    if (req) {
      await logAudit(req, {
        action: AuditAction.BUSINESS_TOGGLED_FEATURED,
        entity: 'business',
        entityId: businessId,
        severity: AuditSeverity.LOW,
        description: `Negocio ${business.name} ${business.isFeatured ? 'destacado' : 'quitado de destacados'}`,
        metadata: { isFeatured: business.isFeatured },
      });
    }

    return business;
  }

  /**
   * S11: ya no borra. Archivar (`businessService.archive`) es el único
   * camino — sale de la app y del catálogo, pero conserva pedidos,
   * liquidaciones y reseñas, y es reversible con `restoreBusiness`.
   */
  async archiveBusiness(businessId: string, reason: string, actor: IUser, req?: Request) {
    const business = await businessService.archive(businessId, actor._id.toString(), reason, req);
    return { archived: true, business };
  }

  async restoreBusiness(businessId: string, req?: Request) {
    const business = await businessService.restore(businessId, req);
    return { restored: true, business };
  }

  // ── Orders Management ──
  async getAllOrders(filters: {
    /** Sin `commissions:view`, `finance` sale reducido a lo que el cliente ya vio (H3). */
    maskCommissions?: boolean;
    status?: string;
    city?: string;
    dateFrom?: string;
    dateTo?: string;
    search?: string;
    page?: number;
    limit?: number;
  } = {}) {
    const { status, city, dateFrom, dateTo, search, page = 1, limit = 20, maskCommissions = false } = filters;
    const filter: Record<string, unknown> = {};
    if (status) filter.status = status;
    if (city) filter.city = city;
    if (dateFrom || dateTo) {
      const dateFilter: Record<string, Date> = {};
      if (dateFrom) dateFilter.$gte = new Date(dateFrom);
      if (dateTo) {
        const end = new Date(dateTo);
        end.setHours(23, 59, 59, 999);
        dateFilter.$lte = end;
      }
      filter.createdAt = dateFilter;
    }
    if (search) filter.orderNumber = { $regex: escapeRegex(search), $options: 'i' };

    const skip = (page - 1) * limit;
    const [orders, total] = await Promise.all([
      Order.find(filter)
        .skip(skip).limit(limit)
        .sort({ createdAt: -1 })
        .populate('clientId', 'name phone')
        .populate('businessId', 'name')
        // O1: sin este populate, todo pedido asignado se veía como "Sin
        // asignar" en el panel — `driverId` es un `Driver`, así que hace
        // falta un segundo nivel para llegar al nombre/teléfono de la
        // persona.
        .populate({ path: 'driverId', select: 'userId vehicleType', populate: { path: 'userId', select: 'name phone' } }),
      Order.countDocuments(filter),
    ]);
    if (maskCommissions) {
      const masked = orders.map((o) => {
        const plain = o.toObject();
        (plain as any).finance = customerFinanceView(plain.finance);
        return plain;
      });
      return { orders: masked as unknown as typeof orders, meta: { page, limit, total, totalPages: Math.ceil(total / limit) } };
    }
    return { orders, meta: { page, limit, total, totalPages: Math.ceil(total / limit) } };
  }

  // ── Commissions ──
  async getCommissions(status?: string, page = 1, limit = 20, businessId?: string) {
    if (businessId && !Types.ObjectId.isValid(businessId)) throw new AppError('Comercio inválido', 400);
    const filter: Record<string, unknown> = {};
    if (status) filter.status = status;
    if (businessId) filter.businessId = businessId;
    const skip = (page - 1) * limit;
    const [commissions, total, totalsRows] = await Promise.all([
      Commission.find(filter)
        .skip(skip).limit(limit)
        .sort({ createdAt: -1 })
        .populate('orderId', 'orderNumber total')
        .populate('businessId', 'name'),
      Commission.countDocuments(filter),
      // Totales de todo el filtro, no de la página: lo que la pantalla enseña
      // arriba tiene que cuadrar con lo que hay debajo aunque se pagine.
      Commission.aggregate([
        { $match: businessId ? { businessId: new Types.ObjectId(businessId) } : {} },
        {
          $group: {
            _id: '$status',
            count: { $sum: 1 },
            platformAmount: { $sum: '$platformAmount' },
            businessAmount: { $sum: '$businessAmount' },
            driverAmount: { $sum: '$driverAmount' },
          },
        },
      ]),
    ]);
    const totals: Record<string, { count: number; platformAmount: number; businessAmount: number; driverAmount: number }> = {};
    for (const row of totalsRows) {
      totals[row._id as string] = {
        count: row.count,
        platformAmount: row.platformAmount,
        businessAmount: row.businessAmount,
        driverAmount: row.driverAmount,
      };
    }
    return { commissions, totals, meta: { page, limit, total, totalPages: Math.ceil(total / limit) } };
  }

  // ── Driver Debts ──
  async getDriverDebts(status?: string, page = 1, limit = 20) {
    const filter: Record<string, unknown> = {};
    if (status) filter.status = status;
    const skip = (page - 1) * limit;
    const [debts, total] = await Promise.all([
      DriverDebt.find(filter)
        .skip(skip).limit(limit)
        .sort({ createdAt: -1 })
        .populate({ path: 'driverId', populate: { path: 'userId', select: 'name phone' } })
        .populate('orderId', 'orderNumber total'),
      DriverDebt.countDocuments(filter),
    ]);
    return { debts, meta: { page, limit, total, totalPages: Math.ceil(total / limit) } };
  }

  // ── Driver Management ──
  async suspendDriver(driverId: string, req: Request) {
    if (!(await Driver.exists({ _id: driverId }))) throw new AppError('Domiciliario no encontrado', 404);

    // Suspender a mitad de una entrega deja al cliente y al comercio esperando
    // a alguien que ya no puede repartir. `Order.driverId` guarda el _id del Driver.
    const activeOrder = await Order.exists({
      driverId,
      status: { $nin: TERMINAL_ORDER_STATUSES },
    });
    if (activeOrder) {
      throw new AppError(
        'No se puede suspender: el domiciliario tiene un pedido en curso. Espera a que lo entregue o reasígnalo primero.',
        409,
        'DRIVER_HAS_ACTIVE_ORDER'
      );
    }

    // Carrera residual: un pedido asignado justo después del chequeo no se detecta.
    const driver = await Driver.findOneAndUpdate(
      { _id: driverId, isActive: true },
      { $set: { isActive: false } },
      { new: true }
    );
    if (!driver) throw new AppError('El domiciliario ya está suspendido', 409);

    void logAudit(req, {
      action: AuditAction.DRIVER_SUSPENDED,
      entity: 'driver',
      entityId: driver._id.toString(),
      severity: AuditSeverity.HIGH,
      description: 'Domiciliario suspendido',
    });
    return driver;
  }

  async reactivateDriver(driverId: string, req: Request) {
    if (!(await Driver.exists({ _id: driverId }))) throw new AppError('Domiciliario no encontrado', 404);

    const driver = await Driver.findOneAndUpdate(
      { _id: driverId, isActive: false },
      { $set: { isActive: true } },
      { new: true }
    );
    if (!driver) throw new AppError('El domiciliario ya está activo', 409);

    void logAudit(req, {
      action: AuditAction.DRIVER_REACTIVATED,
      entity: 'driver',
      entityId: driver._id.toString(),
      severity: AuditSeverity.MEDIUM,
      description: 'Domiciliario reactivado',
    });
    return driver;
  }

  /**
   * Suspender o levantar la suspensión indicando el estado DESEADO (H6): el
   * toggle viejo (`findById → save`) hacía que dos clics simultáneos se
   * anularan. Aquí la condición va en el filtro; si el estado ya es el pedido
   * responde idempotente (`changed: false`) sin duplicar auditoría. Igual que
   * el toggle, no tiene más efectos colaterales que el propio estado.
   */
  async setBusinessSuspension(businessId: string, suspended: boolean, reason: string | undefined, req: Request) {
    const trimmed = reason?.trim();
    if (suspended && (!trimmed || trimmed.length < 5 || trimmed.length > 300)) {
      throw new AppError('El motivo de la suspensión es obligatorio (5 a 300 caracteres)', 400);
    }
    if (!(await Business.exists({ _id: businessId }))) throw new AppError('Negocio no encontrado', 404);

    const updated = await Business.findOneAndUpdate(
      { _id: businessId, isSuspended: suspended ? { $ne: true } : true },
      {
        $set: {
          isSuspended: suspended,
          suspendedAt: suspended ? new Date() : null,
          suspendedBy: suspended ? (req.user?._id as any) ?? null : null,
          suspensionReason: suspended ? trimmed! : null,
        },
      },
      { new: true }
    );

    if (!updated) {
      const current = await Business.findById(businessId);
      return { business: current!, changed: false };
    }

    await logAudit(req, {
      action: AuditAction.BUSINESS_SUSPENSION_SET,
      entity: 'business',
      entityId: businessId,
      severity: AuditSeverity.HIGH,
      description: `Negocio ${updated.name} ${suspended ? 'suspendido' : 'reactivado'}${suspended ? `: ${trimmed}` : ''}`,
      metadata: { suspended, reason: suspended ? trimmed : undefined },
    });
    return { business: updated, changed: true };
  }
}

export const adminService = new AdminService();
