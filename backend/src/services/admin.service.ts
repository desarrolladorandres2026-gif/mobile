import { Request } from 'express';
import crypto from 'crypto';
import { User, IUser, Business, Order, Driver, Commission, DriverDebt, Payment, Position, Role } from '../models';
import { AppError } from '../middlewares';
import { OrderStatus, PaymentStatus, DebtStatus, CommissionStatus, UserRole } from '../types';
import { logAudit, AuditAction, AuditSeverity, validatePasswordComplexity } from '../security';
import { sessionManager } from '../security/sessions';
import {
  assertNotSelfTarget,
  assertCanAssignRoles,
  assertCanModifyPrivilegedUser,
  getEffectivePermissions,
  getEffectiveRoles,
} from './authorization.service';

export class AdminService {
  // ── Dashboard Stats ──
  async getDashboardStats() {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);

    const weekStart = new Date();
    weekStart.setDate(weekStart.getDate() - 7);
    weekStart.setHours(0, 0, 0, 0);

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
      todayRevenue,
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
        { $group: { _id: null, total: { $sum: '$total' }, commission: { $sum: '$platformCommission' } } },
      ]),
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
      todayRevenue: todayRevenue[0]?.total || 0,
      todayCommission: todayRevenue[0]?.commission || 0,
    };
  }

  // ── Financial Summary ──
  async getFinancialSummary(period: 'today' | 'week' | 'month' = 'today') {
    const now = new Date();
    let startDate: Date;

    if (period === 'today') {
      startDate = new Date(now);
      startDate.setHours(0, 0, 0, 0);
    } else if (period === 'week') {
      startDate = new Date(now);
      startDate.setDate(startDate.getDate() - 7);
    } else {
      startDate = new Date(now);
      startDate.setMonth(startDate.getMonth() - 1);
    }

    const [deliveredOrders, pendingDebts, settledCommissions] = await Promise.all([
      Order.aggregate([
        { $match: { status: OrderStatus.DELIVERED, deliveredAt: { $gte: startDate } } },
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
      Commission.aggregate([
        { $match: { status: CommissionStatus.SETTLED, createdAt: { $gte: startDate } } },
        { $group: { _id: null, total: { $sum: '$platformAmount' } } },
      ]),
    ]);

    const stats = deliveredOrders[0] || {};

    return {
      totalRevenue: stats.totalRevenue || 0,
      platformEarnings: stats.platformEarnings || 0,
      totalBusinessPayouts: stats.businessPayouts || 0,
      totalDriverPayouts: stats.driverPayouts || 0,
      totalOrders: stats.count || 0,
      pendingDriverDebts: pendingDebts[0]?.total || 0,
      settledCommissions: settledCommissions[0]?.total || 0,
      period,
    };
  }

  // ── Revenue chart por día ──
  async getRevenueChart(days = 30) {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    startDate.setHours(0, 0, 0, 0);

    const data = await Order.aggregate([
      { $match: { status: OrderStatus.DELIVERED, deliveredAt: { $gte: startDate } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$deliveredAt' } },
          revenue: { $sum: '$total' },
          commission: { $sum: '$platformCommission' },
          orders: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    return data;
  }

  // ── Users Management ──
  async getUsers(role?: string, search?: string, page = 1, limit = 20) {
    const filter: Record<string, unknown> = {};
    if (role) filter.role = role;
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { phone: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
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
      await sessionManager.revokeAllSessions(userId);
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

    const previousRole = user.role;
    user.role = newRole as UserRole;
    user.updatedBy = actor._id;
    await user.save();

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
      const position = await Position.findById(positionId);
      if (!position) throw new AppError('Cargo no encontrado', 404);
      // El Cargo trae Roles consigo: la misma guarda de SUPER_ADMIN aplica.
      await assertCanAssignRoles(actor, position.roleIds);
      user.positionId = position._id;
    } else {
      user.positionId = undefined;
    }
    user.updatedBy = actor._id;
    await user.save();

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
      const found = await Role.find({ _id: { $in: uniqueIds } }).select('_id');
      if (found.length !== uniqueIds.length) {
        throw new AppError('Uno o más roles seleccionados no existen', 400);
      }
    }
    // Único punto que decide si esta asignación puede incluir SUPER_ADMIN.
    await assertCanAssignRoles(actor, uniqueIds);

    user.roleIds = uniqueIds as any;
    user.updatedBy = actor._id;
    await user.save();

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
      await sessionManager.revokeAllSessions(userId);
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
    await assertCanModifyPrivilegedUser(actor, user);

    const temporaryPassword = crypto.randomBytes(9).toString('base64url') + 'Aa1!';
    const check = validatePasswordComplexity(temporaryPassword);
    if (!check.valid) throw new AppError('No se pudo generar una contraseña temporal válida', 500);

    user.password = temporaryPassword;
    user.refreshToken = undefined;
    user.failedLoginAttempts = 0;
    user.lockedUntil = undefined;
    user.updatedBy = actor._id;
    await user.save();

    await sessionManager.revokeAllSessions(userId);

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
   * Crea una cuenta administrativa directamente desde el panel (a
   * diferencia de `/auth/register`, que solo permite client/driver/business
   * y no acepta Cargo/Roles). Requiere `users:create`.
   */
  async createStaffUser(
    data: { name: string; phone: string; email?: string; password: string; positionId?: string; roleIds?: string[] },
    actor: IUser,
    req?: Request
  ): Promise<IUser> {
    if (!/^(\+57)?[0-9]{10}$/.test(data.phone || '')) {
      throw new AppError('Número de celular inválido', 400);
    }
    if (!data.name || data.name.trim().length < 2) {
      throw new AppError('El nombre es requerido', 400);
    }

    const existing = await User.findOne({ phone: data.phone });
    if (existing) throw new AppError('Este número de celular ya está registrado', 409);

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
        description: `Cuenta administrativa creada: ${user.name} (${user.phone})`,
        metadata: { positionId: data.positionId, roleIds },
      });
    }

    return user;
  }

  /**
   * Phone/email verified via OTP login are locked for self-service edits
   * (see auth.service.updateProfile). This is the only way to change one —
   * it resets the corresponding *Verified flag so the user must re-confirm
   * the new value through the normal OTP flow before it locks again.
   */
  async overrideUserContact(
    userId: string,
    data: { phone?: string; email?: string },
    adminUserId: string,
    req?: Request
  ) {
    const user = await User.findById(userId);
    if (!user) throw new AppError('Usuario no encontrado', 404);

    const updatedFields: string[] = [];

    if (data.phone !== undefined && data.phone !== user.phone) {
      const existing = await User.findOne({ phone: data.phone, _id: { $ne: userId } });
      if (existing) {
        throw new AppError('Este número de celular ya está registrado por otro usuario', 409);
      }
      user.phone = data.phone;
      user.phoneVerified = false;
      updatedFields.push('phone');
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
        updatedFields.push('email');
      }
    }

    if (updatedFields.length === 0) return user;

    await user.save();

    if (req) {
      await logAudit(req, {
        action: AuditAction.USER_CONTACT_OVERRIDDEN,
        entity: 'user',
        entityId: userId,
        severity: AuditSeverity.HIGH,
        description: `Admin ${adminUserId} sobrescribió ${updatedFields.join(', ')} del usuario ${userId}`,
        metadata: { updatedFields },
      });
    }

    return user;
  }

  // ── Business Management ──
  async getBusinesses(search?: string, category?: string, page = 1, limit = 20) {
    const filter: Record<string, unknown> = {};
    if (category) filter.category = category;
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { city: { $regex: search, $options: 'i' } },
      ];
    }
    const skip = (page - 1) * limit;
    const [businesses, total] = await Promise.all([
      Business.find(filter).skip(skip).limit(limit).sort({ createdAt: -1 }).populate('ownerId', 'name phone'),
      Business.countDocuments(filter),
    ]);
    return { businesses, meta: { page, limit, total, totalPages: Math.ceil(total / limit) } };
  }

  async toggleBusinessActive(businessId: string) {
    const business = await Business.findById(businessId);
    if (!business) throw new AppError('Negocio no encontrado', 404);
    business.isActive = !business.isActive;
    await business.save();
    return business;
  }

  async toggleBusinessFeatured(businessId: string) {
    const business = await Business.findById(businessId);
    if (!business) throw new AppError('Negocio no encontrado', 404);
    business.isFeatured = !business.isFeatured;
    await business.save();
    return business;
  }

  async deleteBusiness(businessId: string) {
    const business = await Business.findById(businessId);
    if (!business) throw new AppError('Negocio no encontrado', 404);
    await Business.findByIdAndDelete(businessId);
    return { deleted: true };
  }

  // ── Orders Management ──
  async getAllOrders(filters: {
    status?: string;
    city?: string;
    dateFrom?: string;
    dateTo?: string;
    search?: string;
    page?: number;
    limit?: number;
  } = {}) {
    const { status, city, dateFrom, dateTo, search, page = 1, limit = 20 } = filters;
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
    if (search) filter.orderNumber = { $regex: search, $options: 'i' };

    const skip = (page - 1) * limit;
    const [orders, total] = await Promise.all([
      Order.find(filter)
        .skip(skip).limit(limit)
        .sort({ createdAt: -1 })
        .populate('clientId', 'name phone')
        .populate('businessId', 'name'),
      Order.countDocuments(filter),
    ]);
    return { orders, meta: { page, limit, total, totalPages: Math.ceil(total / limit) } };
  }

  // ── Commissions ──
  async getCommissions(status?: string, page = 1, limit = 20) {
    const filter: Record<string, unknown> = {};
    if (status) filter.status = status;
    const skip = (page - 1) * limit;
    const [commissions, total] = await Promise.all([
      Commission.find(filter)
        .skip(skip).limit(limit)
        .sort({ createdAt: -1 })
        .populate('orderId', 'orderNumber total')
        .populate('businessId', 'name'),
      Commission.countDocuments(filter),
    ]);
    return { commissions, meta: { page, limit, total, totalPages: Math.ceil(total / limit) } };
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
  async suspendDriver(driverId: string) {
    const driver = await Driver.findById(driverId);
    if (!driver) throw new AppError('Domiciliario no encontrado', 404);
    driver.isActive = false;
    await driver.save();
    return driver;
  }

  async reactivateDriver(driverId: string) {
    const driver = await Driver.findById(driverId);
    if (!driver) throw new AppError('Domiciliario no encontrado', 404);
    driver.isActive = true;
    await driver.save();
    return driver;
  }
}

export const adminService = new AdminService();
