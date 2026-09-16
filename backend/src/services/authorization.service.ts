import { Types } from 'mongoose';
import { IUser, Position, Role } from '../models';
import { AppError } from '../middlewares/errorHandler';
import { UserRole } from '../types';
import {
  Permission,
  getPermissionsForRole,
  mapToExtendedRole,
  SUPER_ADMIN_ROLE_SLUG,
} from '../security/rbac';
import { logSystemAudit, AuditAction, AuditSeverity } from '../security/audit';

/**
 * Servicio central de autorización — el único lugar que responde
 * "¿qué puede hacer este usuario?".
 *
 * Jerarquía: Usuario → Cargo (opcional) → Roles → Permisos.
 *   effectiveRoles      = user.roleIds ∪ (roles del Cargo del usuario)
 *   effectivePermissions = permisos legacy de `user.role`
 *                           ∪ permisos de todos los effectiveRoles activos
 *
 * La unión con los permisos "legacy" (el mapa estático de rbac.ts, resuelto
 * a partir de `user.role`) es deliberada: es lo que hace este cambio
 * aditivo. Ninguna cuenta existente pierde acceso por no tener todavía un
 * Cargo/Rol de RBAC asignado — ver migrations/002-rbac.ts, que solo AÑADE
 * roles a la cuenta principal, no le quita nada.
 */

async function resolveEffectiveRoleIds(
  user: Pick<IUser, 'roleIds' | 'positionId'>
): Promise<Types.ObjectId[]> {
  const ids = new Set<string>((user.roleIds || []).map((id) => id.toString()));

  if (user.positionId) {
    const position = await Position.findById(user.positionId)
      .select('roleIds isActive')
      .lean();
    if (position?.isActive) {
      for (const roleId of position.roleIds || []) ids.add(roleId.toString());
    }
  }

  return Array.from(ids).map((id) => new Types.ObjectId(id));
}

/** Roles de RBAC efectivos de un usuario (documentos activos, con slug). */
export async function getEffectiveRoles(
  user: Pick<IUser, 'roleIds' | 'positionId'>
): Promise<Array<{ _id: Types.ObjectId; slug: string; name: string; permissions: Permission[] }>> {
  const roleIds = await resolveEffectiveRoleIds(user);
  if (roleIds.length === 0) return [];

  const roles = await Role.find({ _id: { $in: roleIds }, isActive: true })
    .select('slug name permissions')
    .lean();

  return roles as any;
}

/** Lista de permisos efectivos (legacy + RBAC dinámico), sin duplicados. */
export async function getEffectivePermissions(user: IUser): Promise<Permission[]> {
  const legacy = getPermissionsForRole(mapToExtendedRole(user.role));
  const roles = await getEffectiveRoles(user);
  const dynamic = roles.flatMap((r) => r.permissions || []);
  return Array.from(new Set<Permission>([...legacy, ...dynamic]));
}

/** Slugs de los roles efectivos (incluye SUPER_ADMIN_ROLE_SLUG si aplica). */
export async function getEffectiveRoleSlugs(user: IUser): Promise<string[]> {
  const roles = await getEffectiveRoles(user);
  return roles.map((r) => r.slug);
}

export function hasPermission(permissions: Permission[], permission: Permission): boolean {
  return permissions.includes(permission);
}

export function hasAnyPermission(permissions: Permission[], required: Permission[]): boolean {
  return required.some((p) => permissions.includes(p));
}

export function hasAllPermissions(permissions: Permission[], required: Permission[]): boolean {
  return required.every((p) => permissions.includes(p));
}

export function hasRole(roleSlugs: string[], slug: string): boolean {
  return roleSlugs.includes(slug);
}

// ── Guardas contra escalamiento de privilegios ──
//
// Backend-only por diseño: ninguna de estas reglas depende de lo que envíe
// o esconda el cliente. Ver sección 11 de la especificación.

/**
 * Ningún usuario puede modificar su propia autorización (rol, cargo,
 * permisos, ni su propio estado de cuenta). Evita que un ADMIN con
 * `users:update` se autoescale o se "desbloquee" a sí mismo.
 */
export function assertNotSelfTarget(
  actorId: string,
  targetId: string,
  message = 'No puedes modificar tu propia asignación de acceso'
): void {
  if (actorId === targetId) {
    void logSystemAudit({
      userId: actorId,
      action: AuditAction.PRIVILEGE_ESCALATION_BLOCKED,
      entity: 'user',
      entityId: targetId,
      severity: AuditSeverity.HIGH,
      description: `Intento de auto-modificación de autorización bloqueado: ${message}`,
    });
    throw new AppError(message, 403);
  }
}

/**
 * Solo una cuenta que YA tiene el rol SUPER_ADMIN puede otorgárselo a otra.
 * Cualquier otro intento de incluir SUPER_ADMIN en una asignación de roles
 * se rechaza, sin importar qué otros permisos tenga quien lo solicita.
 */
export async function assertCanAssignRoles(
  actor: IUser,
  roleIdsToAssign: Array<Types.ObjectId | string>
): Promise<void> {
  if (!roleIdsToAssign.length) return;

  const roles = await Role.find({ _id: { $in: roleIdsToAssign } }).select('slug').lean();
  const grantsSuperAdmin = roles.some((r) => r.slug === SUPER_ADMIN_ROLE_SLUG);
  if (!grantsSuperAdmin) return;

  const actorRoleSlugs = await getEffectiveRoleSlugs(actor);
  if (!actorRoleSlugs.includes(SUPER_ADMIN_ROLE_SLUG)) {
    void logSystemAudit({
      userId: actor._id.toString(),
      role: actor.role,
      action: AuditAction.PRIVILEGE_ESCALATION_BLOCKED,
      entity: 'role',
      severity: AuditSeverity.CRITICAL,
      description: `${actor.name} intentó otorgar el rol Super Administrador sin poseerlo`,
    });
    throw new AppError(
      'Solo un Super Administrador puede otorgar el rol Super Administrador',
      403
    );
  }
}

/** El rol SUPER_ADMIN (isSystem) no se edita, ni se le quitan permisos, ni se elimina. */
export function assertRoleMutable(role: { isSystem: boolean; slug?: string }): void {
  if (role.isSystem || role.slug === SUPER_ADMIN_ROLE_SLUG) {
    throw new AppError('Este rol es de sistema: no puede editarse ni eliminarse', 403);
  }
}

type PrivilegeTarget = Pick<IUser, 'roleIds' | 'positionId'> & Partial<Pick<IUser, '_id' | 'role' | 'isFinanceAdmin'>>;

async function actorIsSuperAdmin(actor: IUser): Promise<boolean> {
  return (await getEffectiveRoleSlugs(actor)).includes(SUPER_ADMIN_ROLE_SLUG);
}

function blockEscalation(actor: IUser, target: PrivilegeTarget, description: string, message: string): never {
  void logSystemAudit({
    userId: actor._id.toString(),
    role: actor.role,
    action: AuditAction.PRIVILEGE_ESCALATION_BLOCKED,
    entity: 'user',
    entityId: target._id?.toString(),
    severity: AuditSeverity.CRITICAL,
    description,
  });
  throw new AppError(message, 403, 'PRIVILEGE_ESCALATION_BLOCKED');
}

/**
 * Nadie por debajo de SUPER_ADMIN puede tocar una cuenta privilegiada:
 * bloquearla, desactivarla, cambiarle el rol/cargo/roles, ni resetearle la
 * contraseña. Sin esto, un ADMIN normal con `users:block` podría bloquear
 * o tomar la cuenta principal — justamente lo que la sección 10 de la
 * especificación pide impedir.
 *
 * Privilegiada es una cuenta con el rol `super_admin` **o** con
 * `isFinanceAdmin`: antes solo contaba lo primero, así que un administrador
 * operativo podía modificar a quien fija precios y liquida dinero.
 */
export async function assertCanModifyPrivilegedUser(
  actor: IUser,
  target: PrivilegeTarget,
  message = 'Esta cuenta tiene privilegios de Super Administrador: solo otro Super Administrador puede modificarla'
): Promise<void> {
  const targetIsSuper = (await getEffectiveRoleSlugs(target as IUser)).includes(SUPER_ADMIN_ROLE_SLUG);
  const targetIsFinance = target.isFinanceAdmin === true;
  if (!targetIsSuper && !targetIsFinance) return;

  if (await actorIsSuperAdmin(actor)) return;

  blockEscalation(
    actor,
    target,
    `${actor.name} intentó modificar una cuenta ${targetIsSuper ? 'Super Administrador' : 'de administración financiera'} sin ser Super Administrador`,
    targetIsSuper
      ? message
      : 'Esta cuenta administra dinero de la plataforma: solo un Super Administrador puede modificarla'
  );
}

/**
 * Guarda para las dos acciones que equivalen a tomar una cuenta ajena:
 * sobrescribir su contacto (teléfono/correo, que es por donde llega el OTP)
 * y restablecer su contraseña (el panel ve la contraseña temporal).
 *
 * Sobre cualquier cuenta administrativa exige ser Super Administrador. Antes
 * un administrador operativo —que ya trae `users:update`— podía poner su
 * propio número en la cuenta del Super Administrador y entrar por OTP.
 */
export async function assertCanTakeOverAccount(actor: IUser, target: PrivilegeTarget & Pick<IUser, '_id'>): Promise<void> {
  assertNotSelfTarget(actor._id.toString(), target._id.toString(), 'Usa tu perfil para cambiar los datos de tu propia cuenta');
  await assertCanModifyPrivilegedUser(actor, target);

  if (target.role === UserRole.ADMIN && !(await actorIsSuperAdmin(actor))) {
    blockEscalation(
      actor,
      target,
      `${actor.name} intentó tomar el control de una cuenta administrativa (contacto o contraseña) sin ser Super Administrador`,
      'Solo un Super Administrador puede cambiar el contacto o la contraseña de una cuenta administrativa'
    );
  }
}
