import { Types } from 'mongoose';
import {
  BusinessStaff,
  BusinessRole,
  BusinessPermission,
  BUSINESS_ROLE_PERMISSIONS,
  Business,
  User,
} from '../models';
import { AppError } from '../middlewares/errorHandler';

/**
 * Empleados de un comercio y lo que cada uno puede hacer.
 *
 * El dueño no vive en esta colección: es `Business.ownerId` y lo puede
 * todo. Guardarlo aquí además crearía dos sitios donde consultar quién
 * manda, y tarde o temprano dirían cosas distintas.
 */
export class BusinessStaffService {
  /**
   * Qué puede hacer esta persona en este negocio.
   *
   * Devuelve la lista vacía si no tiene nada que ver con él. Es la única
   * función que decide accesos, así que cualquier pantalla nueva del panel
   * pasa por aquí en vez de inventarse su propia comprobación.
   */
  async permissionsFor(userId: string, businessId: string): Promise<BusinessPermission[]> {
    const business = await Business.findById(businessId).select('ownerId');
    if (!business) return [];

    if (business.ownerId.toString() === userId) {
      return BUSINESS_ROLE_PERMISSIONS[BusinessRole.OWNER];
    }

    const staff = await BusinessStaff.findOne({ businessId, userId, isActive: true });
    if (!staff) return [];

    return BUSINESS_ROLE_PERMISSIONS[staff.role] ?? [];
  }

  /** Lanza si la persona no puede hacer eso en ese negocio. */
  async assertCan(
    userId: string,
    businessId: string,
    permission: BusinessPermission
  ): Promise<void> {
    const permissions = await this.permissionsFor(userId, businessId);

    if (!permissions.includes(permission)) {
      throw new AppError(
        'No tienes permiso para hacer esto en este negocio',
        403,
        'BUSINESS_PERMISSION_DENIED'
      );
    }
  }

  /**
   * Los negocios a los que esta persona puede entrar.
   *
   * Incluye los propios y aquellos donde es empleado. Antes solo existían
   * los propios, así que un encargado no tenía forma de llegar al panel.
   */
  async accessibleBusinesses(userId: string) {
    const [owned, staffOf] = await Promise.all([
      Business.find({ ownerId: userId }).sort({ createdAt: -1 }),
      BusinessStaff.find({ userId, isActive: true }).select('businessId'),
    ]);

    if (!staffOf.length) return owned;

    const employed = await Business.find({
      _id: { $in: staffOf.map((s) => s.businessId) },
      // Un empleado de un negocio dado de baja no debería seguir entrando.
      isActive: true,
    });

    const seen = new Set(owned.map((b) => b._id.toString()));
    return [...owned, ...employed.filter((b) => !seen.has(b._id.toString()))];
  }

  async list(businessId: string) {
    return BusinessStaff.find({ businessId })
      .populate('userId', 'name phone email avatar')
      .sort({ createdAt: -1 });
  }

  /**
   * Da de alta a alguien que ya tiene cuenta en ZIPP.
   *
   * No se crea el usuario aquí a propósito: el empleado entra con su propia
   * cuenta, con su propio teléfono y su propia contraseña. Crear cuentas
   * desde el panel del negocio llevaría de vuelta al problema que esto
   * resuelve — credenciales compartidas.
   */
  async add(
    businessId: string,
    phone: string,
    role: BusinessRole.MANAGER | BusinessRole.STAFF,
    invitedBy: string
  ) {
    const user = await User.findOne({ phone });
    if (!user) {
      throw new AppError(
        'No hay ninguna cuenta de ZIPP con ese teléfono. Pídele que se registre primero.',
        404
      );
    }

    const business = await Business.findById(businessId).select('ownerId');
    if (!business) throw new AppError('Negocio no encontrado', 404);

    if (business.ownerId.toString() === user._id.toString()) {
      throw new AppError('El dueño ya tiene acceso completo', 409);
    }

    const existing = await BusinessStaff.findOne({ businessId, userId: user._id });
    if (existing) {
      // Reactivar y cambiar el papel, en vez de fallar: dar de alta a
      // alguien que trabajó aquí hace meses es el caso normal, no un error.
      existing.role = role;
      existing.isActive = true;
      await existing.save();
      return existing;
    }

    return BusinessStaff.create({
      businessId,
      userId: user._id,
      role,
      invitedBy: new Types.ObjectId(invitedBy),
    });
  }

  /**
   * Quita el acceso.
   *
   * Se desactiva en vez de borrarse: los pedidos que esa persona aceptó
   * siguen apuntando a ella, y para investigar una incidencia hace falta
   * poder saber quién era.
   */
  async remove(businessId: string, staffId: string) {
    const staff = await BusinessStaff.findOne({ _id: staffId, businessId });
    if (!staff) throw new AppError('Empleado no encontrado', 404);

    staff.isActive = false;
    await staff.save();
    return staff;
  }
}

export const businessStaffService = new BusinessStaffService();
