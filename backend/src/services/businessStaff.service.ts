import { Types } from 'mongoose';
import {
  BusinessStaff,
  BusinessRole,
  BusinessPermission,
  BUSINESS_ROLE_PERMISSIONS,
  COUNTER_ROLES,
  STAFF_ROLES,
  normalizeStaffRole,
  StaffRole,
  Business,
  User,
} from '../models';
import { AppError } from '../middlewares/errorHandler';
import { bogotaDateString, bogotaDayRange } from '../utils/period';
import { getIO } from '../sockets/emitter';

/**
 * El rol de alguien en un negocio decide a qué sala de socket entra
 * (`business:<id>`) y las salas se calculan solo al conectar. El PC del
 * mostrador queda encendido días, así que sin esto un empleado dado de baja
 * —o reasignado— seguía recibiendo `order:incoming` con el cliente, su
 * teléfono y su dirección hasta que algo más cortara esa conexión (hallazgo
 * MEDIO 6, auditoría 2026-10-01). El REST ya se corta solo: `accessFor`
 * consulta la base en cada petición.
 */
function disconnectUserSockets(userId: string): void {
  getIO()?.in(`user:${userId}`).disconnectSockets(true);
}

/** Quién es alguien en un negocio y qué puede hacer ahí. */
export interface BusinessAccess {
  role: BusinessRole;
  permissions: BusinessPermission[];
}

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
    return (await this.accessFor(userId, businessId))?.permissions ?? [];
  }

  /**
   * Lo mismo que `permissionsFor`, más el papel. Hace falta cuando no basta
   * con "¿puede?": el mostrador ve solo los pedidos del día y el personal
   * recibe el pedido sin el margen de ZIPP ni el pago al domiciliario.
   * `null` si no tiene nada que ver con el negocio.
   */
  async accessFor(userId: string, businessId: string): Promise<BusinessAccess | null> {
    const business = await Business.findById(businessId).select('ownerId isArchived');
    if (!business) return null;

    if (business.ownerId.toString() === userId) {
      return { role: BusinessRole.OWNER, permissions: BUSINESS_ROLE_PERMISSIONS[BusinessRole.OWNER] };
    }

    // MEDIO 8 (auditoría 2026-10-01): un negocio archivado ya no aparece en
    // `accessibleBusinesses`, pero esto seguía dándole al personal acceso
    // directo por API. El dueño sí conserva su historial archivado.
    if (business.isArchived) return null;

    // Una invitación pendiente no da acceso: falta que la persona la acepte.
    const staff = await BusinessStaff.findOne({
      businessId,
      userId,
      isActive: true,
      status: { $ne: 'pending' },
    });
    if (!staff) return null;

    const role = normalizeStaffRole(staff.role);
    return { role, permissions: BUSINESS_ROLE_PERMISSIONS[role] ?? [] };
  }

  /** Lanza si la persona no puede hacer eso en ese negocio. */
  async assertCan(
    userId: string,
    businessId: string,
    permission: BusinessPermission,
    message = 'No tienes permiso para hacer esto en este negocio'
  ): Promise<BusinessAccess> {
    const access = await this.accessFor(userId, businessId);

    if (!access?.permissions.includes(permission)) {
      throw new AppError(message, 403, 'BUSINESS_PERMISSION_DENIED');
    }
    return access;
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
      BusinessStaff.find({ userId, isActive: true, status: { $ne: 'pending' } }).select('businessId'),
    ]);

    if (!staffOf.length) return owned;

    const employed = await Business.find({
      _id: { $in: staffOf.map((s) => s.businessId) },
      // Un empleado de un negocio dado de baja no debería seguir entrando.
      // "De baja" es archivado, no `isActive`: ese es el Abierto/Cerrado del
      // día, y filtrar por él dejaba al personal que cerraba por la noche
      // sin forma de volver a abrir por la mañana.
      isArchived: { $ne: true },
    });

    const seen = new Set(owned.map((b) => b._id.toString()));
    return [...owned, ...employed.filter((b) => !seen.has(b._id.toString()))];
  }

  async list(businessId: string) {
    return BusinessStaff.find({ businessId })
      .populate('userId', 'name phone email avatar lastLoginAt')
      .sort({ createdAt: -1 });
  }

  /**
   * Un administrador solo gestiona al personal operativo. Sin esto podría
   * ascender a otro a administrador o suspender a un igual, y el dueño
   * dejaría de ser el único que reparte el poder.
   */
  private assertCanGrant(actorRole: BusinessRole, role: BusinessRole): void {
    if (actorRole === BusinessRole.OWNER) return;
    if (actorRole === BusinessRole.MANAGER && COUNTER_ROLES.includes(role)) return;
    throw new AppError(
      'Solo el propietario puede gestionar administradores',
      403,
      'BUSINESS_PERMISSION_DENIED'
    );
  }

  private async actorRole(actorId: string, businessId: string): Promise<BusinessRole> {
    const access = await this.accessFor(actorId, businessId);
    if (!access) throw new AppError('No autorizado', 403, 'BUSINESS_PERMISSION_DENIED');
    return access.role;
  }

  /**
   * Invita a alguien que ya tiene cuenta en ZIPP. Queda `pending` y no da
   * ningún acceso hasta que la persona acepta: el dueño no puede dar acceso
   * a datos de clientes a un tercero que no lo sabe.
   *
   * No se crea el usuario aquí a propósito: el empleado entra con su propia
   * cuenta, con su propio teléfono y su propia contraseña. Crear cuentas
   * desde el panel del negocio llevaría de vuelta al problema que esto
   * resuelve — credenciales compartidas.
   */
  async invite(
    businessId: string,
    input: { phone: string; role: StaffRole; name?: string; email?: string },
    invitedBy: string
  ) {
    const actor = await this.actorRole(invitedBy, businessId);
    this.assertCanGrant(actor, input.role);

    const user = await User.findOne({ phone: input.phone });
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
      // Un administrador no puede pisar la fila de otro administrador.
      this.assertCanGrant(actor, normalizeStaffRole(existing.role));
      // Reinvitar a quien ya trabajó aquí es el caso normal, no un error. Vuelve
      // a `pending`: debe aceptar otra vez, y mientras tanto no conserva acceso.
      existing.role = input.role;
      existing.isActive = false;
      existing.status = 'pending';
      existing.invitedName = input.name;
      existing.invitedEmail = input.email;
      existing.invitedBy = new Types.ObjectId(invitedBy);
      await existing.save();
      disconnectUserSockets(user._id.toString());
      return existing;
    }

    return BusinessStaff.create({
      businessId,
      userId: user._id,
      role: input.role,
      isActive: false,
      status: 'pending',
      invitedName: input.name,
      invitedEmail: input.email,
      invitedBy: new Types.ObjectId(invitedBy),
    });
  }

  /** Invitaciones que esta persona tiene sin responder. */
  async pendingInvitations(userId: string) {
    return BusinessStaff.find({ userId, status: 'pending' })
      .populate('businessId', 'name logo')
      .sort({ createdAt: -1 });
  }

  /** Aceptar o rechazar: solo quien fue invitado, y solo sobre su propia fila. */
  async respondToInvitation(userId: string, staffId: string, accept: boolean) {
    const staff = await BusinessStaff.findOne({ _id: staffId, userId, status: 'pending' });
    if (!staff) throw new AppError('Invitación no encontrada', 404);

    if (!accept) {
      await staff.deleteOne();
      return null;
    }

    staff.status = 'active';
    staff.isActive = true;
    staff.acceptedAt = new Date();
    await staff.save();
    return staff;
  }

  private async loadMember(businessId: string, staffId: string) {
    const staff = await BusinessStaff.findOne({ _id: staffId, businessId });
    if (!staff) throw new AppError('Empleado no encontrado', 404);
    return staff;
  }

  /** Cambiar el papel de alguien que ya está dentro. */
  async changeRole(businessId: string, staffId: string, role: StaffRole, actorId: string) {
    if (!STAFF_ROLES.includes(role)) throw new AppError('Papel inválido', 400);
    const actor = await this.actorRole(actorId, businessId);
    const staff = await this.loadMember(businessId, staffId);
    this.assertCanGrant(actor, normalizeStaffRole(staff.role));
    this.assertCanGrant(actor, role);

    staff.role = role;
    await staff.save();
    // Su socket ya abierto sigue con las salas de su papel anterior.
    disconnectUserSockets(staff.userId.toString());
    return staff;
  }

  /** Suspender conserva la fila (y el historial); reactivar la devuelve a `active`. */
  async setSuspended(businessId: string, staffId: string, suspended: boolean, actorId: string) {
    const actor = await this.actorRole(actorId, businessId);
    const staff = await this.loadMember(businessId, staffId);
    this.assertCanGrant(actor, normalizeStaffRole(staff.role));
    if (staff.status === 'pending') throw new AppError('Esa invitación aún no fue aceptada', 409);

    staff.status = suspended ? 'suspended' : 'active';
    staff.isActive = !suspended;
    await staff.save();
    if (suspended) disconnectUserSockets(staff.userId.toString());
    return staff;
  }

  /**
   * Quita a alguien del negocio.
   *
   * Los pedidos que esa persona aceptó apuntan a su `User`, no a esta fila,
   * así que borrarla no rompe el historial; lo que queda de rastro es la
   * auditoría de quien la retiró.
   */
  async remove(businessId: string, staffId: string, actorId: string) {
    const actor = await this.actorRole(actorId, businessId);
    const staff = await this.loadMember(businessId, staffId);
    this.assertCanGrant(actor, normalizeStaffRole(staff.role));

    await staff.deleteOne();
    disconnectUserSockets(staff.userId.toString());
    return staff;
  }
}

/**
 * El mostrador ve "solo los pedidos del día" (ver `COUNTER_ROLES`).
 *
 * "Del día" no puede ser solo `createdAt` de hoy: un pedido que entra a las
 * 23:55 y sigue en preparación a las 00:05 desaparecería de la cocina en
 * plena preparación. Se ve lo creado hoy en hora de Colombia y, además,
 * todo lo que aún no terminó. Lo que queda fuera es el historial cerrado.
 *
 * Devuelve un filtro de Mongo, o `null` si el papel no tiene recorte.
 */
export function staffOrderScope(
  role: BusinessRole,
  terminalStatuses: readonly string[],
  now: Date = new Date()
): Record<string, unknown> | null {
  if (!COUNTER_ROLES.includes(role)) return null;
  const { from } = bogotaDayRange(bogotaDateString(now));
  return { $or: [{ createdAt: { $gte: from } }, { status: { $nin: [...terminalStatuses] } }] };
}

/** Versión en memoria de `staffOrderScope`, para un pedido ya cargado. */
export function isInStaffScope(
  role: BusinessRole,
  order: { createdAt: Date | string; status: string },
  terminalStatuses: readonly string[],
  now: Date = new Date()
): boolean {
  if (!COUNTER_ROLES.includes(role)) return true;
  if (!terminalStatuses.includes(order.status)) return true;
  const { from } = bogotaDayRange(bogotaDateString(now));
  return new Date(order.createdAt).getTime() >= from.getTime();
}

export const businessStaffService = new BusinessStaffService();

/**
 * Guarda de los endpoints del panel: un Admin de plataforma ya pasó por
 * `adminRequires` en la ruta; todos los demás necesitan el permiso en ESTE
 * negocio. Es la comprobación que sustituye al viejo "¿es el dueño?".
 */
export async function assertBusinessCan(
  user: { _id: { toString(): string }; role: string },
  businessId: string,
  permission: BusinessPermission,
  message?: string
): Promise<void> {
  if (user.role === 'admin') return;
  await businessStaffService.assertCan(user._id.toString(), businessId, permission, message);
}
