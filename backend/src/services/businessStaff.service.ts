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
import { UserRole } from '../types';

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

/**
 * Espeja `req.sessionScope` (ver `middlewares/auth.ts`) sin importar Express
 * aquí: `'full'`, `'counter'` (mostrador) o `'elevated:<businessId>'`
 * (entrada con PIN desde el mostrador, válida solo en ese negocio).
 */
export type SessionScope = 'full' | 'counter' | `elevated:${string}`;

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
  async permissionsFor(userId: string, businessId: string, scope?: SessionScope): Promise<BusinessPermission[]> {
    return (await this.accessFor(userId, businessId, scope))?.permissions ?? [];
  }

  /**
   * Lo mismo que `permissionsFor`, más el papel. Hace falta cuando no basta
   * con "¿puede?": el mostrador ve solo los pedidos del día y el personal
   * recibe el pedido sin el margen de ZIPP ni el pago al domiciliario.
   * `null` si no tiene nada que ver con el negocio.
   *
   * `scope` es el de la SESIÓN (`req.sessionScope`), no el rol de la cuenta
   * (decisión 2026-10-09). Con `scope === 'counter'` el resultado es siempre
   * el papel Empleado, incluso para el propietario: el PC del mostrador
   * entra con el correo del negocio directo a ese panel, y solo
   * `/auth/counter/elevate` abre una sesión aparte con `scope: 'full'`. Es
   * el único sitio donde se aplica el tope — toda la base de `assertCan` y
   * de los controladores sigue intacta debajo.
   */
  async accessFor(userId: string, businessId: string, scope?: SessionScope): Promise<BusinessAccess | null> {
    // Revisión 2026-10-10: una sesión elevada con PIN nació en el mostrador
    // de UN negocio. En cualquier otro de la misma persona no es nadie: sin
    // esto, acertar el PIN del dueño en un local abría todos sus locales.
    if (scope?.startsWith('elevated:') && scope.slice('elevated:'.length) !== businessId) return null;

    const business = await Business.findById(businessId).select('ownerId isArchived');
    if (!business) return null;

    if (business.ownerId.toString() === userId) {
      if (scope === 'counter') {
        return { role: BusinessRole.EMPLOYEE, permissions: BUSINESS_ROLE_PERMISSIONS[BusinessRole.EMPLOYEE] };
      }
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

    // Un administrador con sesión de mostrador también se topa a Empleado:
    // el tope es de la sesión, no de a quién pertenece.
    const role = scope === 'counter' ? BusinessRole.EMPLOYEE : normalizeStaffRole(staff.role);
    return { role, permissions: BUSINESS_ROLE_PERMISSIONS[role] ?? [] };
  }

  /** Lanza si la persona no puede hacer eso en ese negocio. */
  async assertCan(
    userId: string,
    businessId: string,
    permission: BusinessPermission,
    message = 'No tienes permiso para hacer esto en este negocio',
    scope?: SessionScope
  ): Promise<BusinessAccess> {
    const access = await this.accessFor(userId, businessId, scope);

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

  /**
   * El equipo del negocio. Quien ya aceptó trae los datos de su cuenta; una
   * invitación pendiente NO: es una cuenta que todavía no ha dicho que sí, y
   * mostrar su nombre, correo o último acceso convertía invitar en una forma de
   * consultar datos personales de cualquier teléfono (auditoría 2026-10-09,
   * ALTO 2). De una pendiente solo se ve lo que escribió quien invitó, y ni
   * siquiera el id de la cuenta.
   */
  async list(businessId: string): Promise<Array<Record<string, unknown>>> {
    const rows = await BusinessStaff.find({ businessId }).sort({ createdAt: -1 }).lean();

    const accepted = rows.filter((r) => r.status !== 'pending');
    const users = await User.find({ _id: { $in: accepted.map((r) => r.userId) } })
      .select('name phone email avatar lastLoginAt')
      .lean();
    const byId = new Map(users.map((u) => [String(u._id), u]));

    return rows.map((row) => {
      if (row.status === 'pending') {
        const { userId: _userId, ...rest } = row;
        return rest;
      }
      return { ...row, userId: byId.get(String(row.userId)) ?? null };
    });
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
   * Invita a alguien que ya tiene cuenta de comercio en ZIPP. Queda `pending`
   * y no da ningún acceso hasta que la persona acepta: el dueño no puede dar
   * acceso a datos de clientes a un tercero que no lo sabe.
   *
   * Solo se puede invitar a una cuenta con rol BUSINESS: es la única que
   * puede abrir el panel y aceptar. Un cliente, un domiciliario o un admin de
   * plataforma nunca podrían responder, y buscarlos por teléfono era un
   * oráculo de cuentas ajenas (auditoría 2026-10-09, ALTO 2).
   *
   * Devuelve `null` cuando no hay a quién invitar (no hay cuenta, no es de
   * comercio o es el propio dueño). El que llama debe responder lo mismo en
   * los dos casos: que la respuesta no distinga es la defensa.
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

    const business = await Business.findById(businessId).select('ownerId');
    if (!business) throw new AppError('Negocio no encontrado', 404);

    const user = await User.findOne({ phone: input.phone, role: UserRole.BUSINESS }).select('_id');
    if (!user || business.ownerId.toString() === user._id.toString()) return null;

    const existing = await BusinessStaff.findOne({ businessId, userId: user._id });
    if (existing) {
      // Un administrador no puede pisar la fila de otro administrador.
      this.assertCanGrant(actor, normalizeStaffRole(existing.role));
      // Reinvitar a un suspendido del propietario sería levantarle la suspensión.
      this.assertNotOwnerSuspended(actor, existing);
      // Reinvitar a quien ya trabajó aquí es el caso normal, no un error. Vuelve
      // a `pending`: debe aceptar otra vez, y mientras tanto no conserva acceso.
      existing.role = input.role;
      existing.isActive = false;
      existing.status = 'pending';
      existing.invitedName = input.name;
      existing.invitedEmail = input.email;
      existing.invitedPhone = input.phone;
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
      invitedPhone: input.phone,
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
    // Repartir poder es del propietario: el permiso se comprueba aquí y no
    // solo en el controlador, para que ninguna otra puerta lo salte.
    await this.assertCan(actorId, businessId, BusinessPermission.TEAM_CHANGE_ROLE, 'Solo el propietario puede cambiar roles.');
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

  /**
   * Una suspensión del propietario solo la levanta el propietario. Sin esto el
   * dueño suspendía a un cajero sospechoso y un administrador lo reactivaba al
   * momento (auditoría 2026-10-09, MEDIO 3). Vale por las tres puertas que
   * dejarían a la persona otra vez dentro: reactivar, reinvitar y retirar la
   * fila para invitar de nuevo.
   */
  private assertNotOwnerSuspended(
    actor: BusinessRole,
    staff: { status?: string; suspendedByRole?: BusinessRole }
  ): void {
    if (actor === BusinessRole.OWNER) return;
    if (staff.status === 'suspended' && staff.suspendedByRole === BusinessRole.OWNER) {
      throw new AppError(
        'Esta persona fue suspendida por el propietario y solo él puede reactivarla.',
        403,
        'SUSPENDED_BY_OWNER'
      );
    }
  }

  /**
   * Suspender conserva la fila (y el historial); reactivar la devuelve a
   * `active`. Ambas escrituras llevan su condición en el filtro: una carrera
   * con un cambio de rol o con otra suspensión no puede pisar el resultado.
   */
  async setSuspended(businessId: string, staffId: string, suspended: boolean, actorId: string) {
    const actor = await this.actorRole(actorId, businessId);
    const staff = await this.loadMember(businessId, staffId);
    this.assertCanGrant(actor, normalizeStaffRole(staff.role));
    if (staff.status === 'pending') throw new AppError('Esa invitación aún no fue aceptada', 409);

    if (suspended) {
      // Solo desde `active`: volver a suspender a quien ya lo está no puede
      // cambiar quién lo suspendió (si no, un administrador "adoptaría" la
      // suspensión del propietario y luego podría levantarla).
      const updated = await BusinessStaff.findOneAndUpdate(
        { _id: staff._id, businessId, status: 'active' },
        { $set: { status: 'suspended', isActive: false, suspendedBy: actorId, suspendedByRole: actor } },
        { new: true }
      );
      disconnectUserSockets(staff.userId.toString());
      return updated ?? (await this.loadMember(businessId, staffId));
    }

    this.assertNotOwnerSuspended(actor, staff);
    const updated = await BusinessStaff.findOneAndUpdate(
      {
        _id: staff._id,
        businessId,
        status: 'suspended',
        // El filtro repite la regla: entre la lectura y la escritura el
        // propietario pudo suspenderlo.
        ...(actor === BusinessRole.OWNER ? {} : { suspendedByRole: { $ne: BusinessRole.OWNER } }),
      },
      { $set: { status: 'active', isActive: true }, $unset: { suspendedBy: '', suspendedByRole: '' } },
      { new: true }
    );
    if (updated) return updated;

    // Sin coincidencia: o ya estaba activo (nada que hacer) o lo suspendió el
    // propietario justo ahora.
    const current = await this.loadMember(businessId, staffId);
    this.assertNotOwnerSuspended(actor, current);
    return current;
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
    // Retirar la fila de un suspendido del propietario y reinvitarlo la saltaría.
    this.assertNotOwnerSuspended(actor, staff);

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
  message?: string,
  scope?: SessionScope
): Promise<void> {
  if (user.role === 'admin') return;
  await businessStaffService.assertCan(user._id.toString(), businessId, permission, message, scope);
}
