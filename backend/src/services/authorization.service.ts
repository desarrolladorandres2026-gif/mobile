import { Types } from 'mongoose';
import { IUser, Position, Role, User } from '../models';
import { AppError } from '../middlewares/errorHandler';
import { UserRole } from '../types';
import {
  Permission,
  getPermissionsForRole,
  mapToExtendedRole,
  SUPER_ADMIN_ROLE_SLUG,
} from '../security/rbac';
import { logSystemAudit, AuditAction, AuditSeverity } from '../security/audit';
import { cache, CachePrefix } from '../cache';
import { isEnabled as isFlagEnabled, RBAC_ENFORCE_FLAG } from './featureFlag.service';

export { RBAC_ENFORCE_FLAG };

/**
 * Servicio central de autorización — el único lugar que responde
 * "¿qué puede hacer este usuario?".
 *
 * Jerarquía: Usuario → Cargo (opcional) → Roles → Permisos.
 *   effectiveRoles = user.roleIds ∪ (roles del Cargo del usuario)
 *
 * Desde la Fase 1 (2026-09-24) hay DOS conjuntos y un modo:
 *   - `strict`: lo que la persona puede hacer de verdad. Para una cuenta
 *     `admin` es `admin:panel` + los permisos de sus roles (el Super
 *     Administrador recibe todo el enum calculado en tiempo de ejecución).
 *     Para clientes, comercios y domiciliarios es su set legacy de siempre.
 *   - `legacyUnion`: el cálculo anterior (legacy por `role` ∪ roles). Sirve
 *     para el modo observación: lo que está aquí y no en `strict` es lo que
 *     el admin dejaría de poder hacer al activar el bloqueo.
 *   - `mode`: 'observe' (registra y deja pasar) o 'enforce' (bloquea), según
 *     el feature flag `rbac_enforce`. Sin flag o apagado = 'observe'.
 * Esto reemplaza la decisión "aditiva" del módulo RBAC original.
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

/** Lista de permisos efectivos estrictos (lo que la persona puede hacer de verdad). */
export async function getEffectivePermissions(user: IUser): Promise<Permission[]> {
  return (await computeSets(user)).strict;
}

/** Slugs de los roles efectivos (incluye SUPER_ADMIN_ROLE_SLUG si aplica). */
export async function getEffectiveRoleSlugs(user: IUser): Promise<string[]> {
  const roles = await getEffectiveRoles(user);
  return roles.map((r) => r.slug);
}

/** Cuánto se recuerdan los roles resueltos de una combinación cargo/roles. */
const AUTHZ_CACHE_TTL_SECONDS = 60;

/**
 * Permisos y slugs de una sola vez, para `authenticate`.
 *
 * Antes el middleware llamaba a `getEffectivePermissions` y a
 * `getEffectiveRoleSlugs` en paralelo, y cada una resolvía los roles por su
 * cuenta: el mismo Cargo y los mismos Roles se leían dos veces en cada
 * petición del panel.
 *
 * Lo que se cachea son los roles de una COMBINACIÓN (cargo + roles
 * asignados), no los de un usuario: cambiarle el cargo o los roles a
 * alguien produce otra clave, así que se refleja en su siguiente petición
 * sin invalidar nada. Lo que sí invalida es editar un Rol o un Cargo (el
 * plugin de caché de esos modelos borra `authz:`); una escritura hecha
 * fuera del proceso, como una migración, tarda como mucho el TTL.
 *
 * Las cuentas sin Cargo ni Roles —clientes, domiciliarios, comercios— no
 * tocan ni la base ni la caché: solo tienen los permisos de su `role`.
 */
export type AuthzMode = 'observe' | 'enforce';

export interface ResolvedAuthorization {
  /** Permisos reales. Admin: `admin:panel` + roles (super_admin = todo). */
  strict: Permission[];
  /** Cálculo anterior a la Fase 1 (legacy ∪ roles). Solo para el modo observación. */
  legacyUnion: Permission[];
  mode: AuthzMode;
  roleSlugs: string[];
}

/** Permisos que la marca vieja `isFinanceAdmin` daba de hecho; solo cuentan en `legacyUnion`. */
const LEGACY_FINANCE_ADMIN_PERMISSIONS = [
  Permission.FINANCE_MANAGE,
  Permission.COMMISSIONS_MANAGE,
  Permission.PAYOUTS_PROCESS,
  Permission.PAYOUTS_REVEAL_ACCOUNT,
  Permission.REFUNDS_CREATE,
];

/**
 * Permisos nuevos de la Fase 1 que cubren rutas que antes solo pedían
 * authorize(ADMIN). Lista explícita a propósito: dinero (reembolsar, ver
 * cuentas), roles, cargos y seguridad NO estaban abiertos a cualquier admin.
 */
const LEGACY_OPEN_ADMIN_PERMISSIONS = [
  Permission.USERS_VIEW_SENSITIVE,
  Permission.EVIDENCES_VIEW,
  Permission.REFUNDS_VIEW,
  Permission.COUPONS_VIEW,
  Permission.COUPONS_MANAGE,
  Permission.ADS_VIEW,
  Permission.ADS_MANAGE,
  Permission.REVIEWS_VIEW,
  Permission.REVIEWS_MODERATE,
  Permission.CONTENT_VIEW,
  Permission.CONTENT_MANAGE,
  Permission.SUPPORT_VIEW,
  Permission.SUPPORT_MANAGE,
  Permission.LEGAL_VIEW,
  Permission.LEGAL_MANAGE,
  Permission.SOS_VIEW,
  Permission.SOS_MANAGE,
  Permission.ZONES_VIEW,
  Permission.ZONES_MANAGE,
  Permission.ORDERS_VIEW_ALL,
  Permission.ORDERS_UPDATE,
  Permission.ORDERS_CANCEL,
  Permission.ORDERS_MODIFY,
  Permission.ORDERS_ASSIGN_DRIVER,
  Permission.DRIVERS_TRACK,
  Permission.NOTIFICATIONS_SEND,
  Permission.SETTINGS_VIEW,
  Permission.SETTINGS_UPDATE,
  Permission.REPORTS_VIEW,
  Permission.BUSINESSES_UPDATE_ALL,
  Permission.BUSINESSES_APPROVE,
  Permission.FINANCE_VIEW,
  Permission.COMMISSIONS_VIEW,
  // `POST /businesses` solo pedía authorize(BUSINESS, ADMIN): cualquier admin podía crear comercios.
  Permission.BUSINESSES_CREATE,
];

async function computeSets(
  user: IUser
): Promise<{ strict: Permission[]; legacyUnion: Permission[]; roleSlugs: string[] }> {
  const isAdmin = user.role === UserRole.ADMIN;
  const legacy = getPermissionsForRole(mapToExtendedRole(user.role));
  const roleIds = (user.roleIds || []).map((id) => id.toString()).sort();

  // Roles/Cargo dinámicos solo cuentan para cuentas admin. En una cuenta de
  // cliente/comercio/domiciliario (aunque tenga `roleIds` guardados) se
  // ignoran por completo: si no, un rol o el slug super_admin asignado a una
  // cuenta no admin le abriría permisos —y `actorIsSuperAdmin`— en rutas que
  // solo comprueban permiso.
  let roles: Array<{ slug: string; permissions: Permission[] }> = [];
  if (isAdmin && (user.positionId || roleIds.length > 0)) {
    const key = `${CachePrefix.AUTHZ}${user.positionId ? user.positionId.toString() : '-'}:${roleIds.join(',')}`;
    roles = await cache.wrap(key, AUTHZ_CACHE_TTL_SECONDS, async () =>
      (await getEffectiveRoles(user)).map((r) => ({ slug: r.slug, permissions: r.permissions || [] }))
    );
  }

  const roleSlugs = roles.map((r) => r.slug);
  const dynamic = roles.flatMap((r) => r.permissions);

  const legacyUnion = new Set<Permission>([...legacy, ...dynamic]);
  if (isAdmin) {
    // Antes de la Fase 1 cualquier admin podía todo lo que solo exigía `authorize(ADMIN)`;
    // lo único restringido era el dinero (marca `isFinanceAdmin`).
    for (const p of LEGACY_OPEN_ADMIN_PERMISSIONS) legacyUnion.add(p);
    if (user.isFinanceAdmin === true) {
      for (const p of LEGACY_FINANCE_ADMIN_PERMISSIONS) legacyUnion.add(p);
    }
  }

  let strict: Set<Permission>;
  if (isAdmin) {
    // El Super Administrador se calcula en tiempo de ejecución: no depende de
    // lo que tenga guardado su documento de rol (una migración pudo quedarse
    // atrás respecto al enum).
    strict = roleSlugs.includes(SUPER_ADMIN_ROLE_SLUG)
      ? new Set<Permission>(Object.values(Permission))
      : new Set<Permission>([Permission.ADMIN_PANEL, ...dynamic]);
    if (roleSlugs.includes(SUPER_ADMIN_ROLE_SLUG)) {
      for (const p of Object.values(Permission)) legacyUnion.add(p);
    }
  } else {
    strict = new Set<Permission>([...legacy, ...dynamic]);
  }

  return { strict: Array.from(strict), legacyUnion: Array.from(legacyUnion), roleSlugs };
}

/**
 * Último valor leído del flag `rbac_enforce` en este proceso. Con audiencias
 * limitadas a `all`/`staff`/`off` es idéntico para todos los admins, así que
 * un valor global basta. Si la lectura falla (base caída) se conserva el
 * último valor conocido —un fallo transitorio no debe apagar un bloqueo ya
 * activo— y solo sin valor previo (arranque) se cae a `observe`, con log.
 */
let lastKnownEnforce: boolean | null = null;

async function resolveMode(user: IUser): Promise<AuthzMode> {
  // Solo las cuentas admin dependen del interruptor: para el resto `strict`
  // y `legacyUnion` coinciden y no hay nada que observar.
  if (user.role !== UserRole.ADMIN) return 'enforce';
  try {
    const on = await isFlagEnabled(RBAC_ENFORCE_FLAG, { userId: user._id?.toString(), role: user.role });
    lastKnownEnforce = on;
    return on ? 'enforce' : 'observe';
  } catch (error) {
    console.error('[AUTHZ_SECURITY] No se pudo leer el flag rbac_enforce', {
      error: error instanceof Error ? error.message : String(error),
      usingLastKnown: lastKnownEnforce !== null,
    });
    return lastKnownEnforce ? 'enforce' : 'observe';
  }
}

/**
 * Autorización de una cuenta, resuelta una vez por request en `authenticate`.
 *
 * Las cuentas sin Cargo ni Roles —clientes, domiciliarios, comercios— no
 * tocan ni la base ni la caché: solo tienen los permisos de su `role`. Lo que
 * sí se cachea son los roles de una COMBINACIÓN (cargo + roles asignados):
 * cambiar el cargo o los roles produce otra clave y se refleja al instante;
 * editar un Rol o Cargo lo invalida el plugin de caché (`authz:`), y una
 * escritura externa (migración) tarda como mucho el TTL.
 */
export async function resolveAuthorization(user: IUser): Promise<ResolvedAuthorization> {
  const [sets, mode] = await Promise.all([computeSets(user), resolveMode(user)]);
  return { ...sets, mode };
}

/**
 * Forma que ven los clientes (login, 2FA, /auth/me): `permissions` es siempre
 * `strict`; `observedPermissions` = legacyUnion − strict, solo para admin y
 * solo en modo observación.
 */
export function authzContract(authz: ResolvedAuthorization, role: string) {
  const isAdmin = role === UserRole.ADMIN;
  const strictSet = new Set(authz.strict);
  return {
    permissions: authz.strict,
    authzMode: authz.mode,
    observedPermissions:
      isAdmin && authz.mode === 'observe' ? authz.legacyUnion.filter((p) => !strictSet.has(p)) : [],
  };
}

/** Administradores activos cuyo `strict` incluye el permiso (p. ej. a quién avisar de un faltante de efectivo). */
export async function usersWithPermission(permission: Permission): Promise<IUser[]> {
  const admins = await User.find({ role: UserRole.ADMIN, isActive: true, isBlocked: { $ne: true } });
  const out: IUser[] = [];
  for (const admin of admins) {
    const { strict } = await computeSets(admin);
    if (strict.includes(permission)) out.push(admin);
  }
  return out;
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
 * Guarda de asignación de roles (directa, por Cargo o al crear cuentas):
 *   1. Solo un Super Administrador puede otorgar el rol SUPER_ADMIN.
 *   2. "No otorgar más de lo que posees": la unión de permisos de los roles
 *      que se otorgan debe ser subconjunto del `strict` del actor. Siempre
 *      contra `strict`, nunca contra `legacyUnion`: en modo observación un
 *      admin sin rol conserva permisos heredados que no debe poder delegar.
 *      El Super Administrador queda exento (posee todo el enum).
 * Se evalúan los roles aunque estén inactivos: reactivarlos después no debe
 * ser una puerta trasera.
 */
export async function assertCanAssignRoles(
  actor: IUser,
  roleIdsToAssign: Array<Types.ObjectId | string>
): Promise<void> {
  if (!roleIdsToAssign.length) return;

  const roles = await Role.find({ _id: { $in: roleIdsToAssign } }).select('slug permissions').lean();
  const grantsSuperAdmin = roles.some((r) => r.slug === SUPER_ADMIN_ROLE_SLUG);

  if (await actorIsSuperAdmin(actor)) return;

  if (grantsSuperAdmin) {
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

  const owned = new Set<Permission>(await getEffectivePermissions(actor));
  const notOwned = new Set<Permission>();
  for (const role of roles) {
    for (const p of (role.permissions || []) as Permission[]) {
      if (!owned.has(p)) notOwned.add(p);
    }
  }
  if (notOwned.size > 0) {
    void logSystemAudit({
      userId: actor._id.toString(),
      role: actor.role,
      action: AuditAction.PRIVILEGE_ESCALATION_BLOCKED,
      entity: 'role',
      severity: AuditSeverity.CRITICAL,
      description: `${actor.name} intentó otorgar permisos que no posee: ${Array.from(notOwned).join(', ')}`,
    });
    throw new AppError(
      `No puedes otorgar permisos que no posees: ${Array.from(notOwned).join(', ')}`,
      403,
      'PRIVILEGE_ESCALATION_BLOCKED'
    );
  }
}

/** Roles y Cargos solo se asignan a cuentas administrativas: en el resto serían inertes o, peor, engañosos. */
export function assertTargetIsAdmin(target: Pick<IUser, 'role'>): void {
  if (target.role !== UserRole.ADMIN) {
    throw new AppError('Los roles y cargos solo se asignan a cuentas administrativas', 400);
  }
}

/**
 * Un actor no edita un Cargo que él mismo tiene asignado: sería otra vía de
 * autoescalada (cambiar los roles del cargo que ya lo cubre). El Super
 * Administrador queda exento porque ya posee todo.
 */
export async function assertNotOwnPosition(actor: IUser, positionId: string): Promise<void> {
  if (!actor.positionId || actor.positionId.toString() !== positionId) return;
  if (await actorIsSuperAdmin(actor)) return;
  void logSystemAudit({
    userId: actor._id.toString(),
    role: actor.role,
    action: AuditAction.PRIVILEGE_ESCALATION_BLOCKED,
    entity: 'position',
    entityId: positionId,
    severity: AuditSeverity.HIGH,
    description: `${actor.name} intentó editar el Cargo que tiene asignado`,
  });
  throw new AppError('No puedes editar el Cargo que tienes asignado', 403, 'PRIVILEGE_ESCALATION_BLOCKED');
}

/** El rol SUPER_ADMIN (isSystem) no se edita, ni se le quitan permisos, ni se elimina. */
export function assertRoleMutable(role: { isSystem: boolean; slug?: string }): void {
  if (role.isSystem || role.slug === SUPER_ADMIN_ROLE_SLUG) {
    throw new AppError('Este rol es de sistema: no puede editarse ni eliminarse', 403);
  }
}

type PrivilegeTarget = Pick<IUser, 'roleIds' | 'positionId'> & Partial<Pick<IUser, '_id' | 'role'>>;

export async function actorIsSuperAdmin(actor: IUser): Promise<boolean> {
  // Un rol/cargo guardado en una cuenta no admin no cuenta (ver `computeSets`).
  if (actor.role !== UserRole.ADMIN) return false;
  return (await getEffectiveRoleSlugs(actor)).includes(SUPER_ADMIN_ROLE_SLUG);
}

/**
 * Exige que quien actúa sea Super Administrador. Ver decisión del
 * 2026-09-23: crear o ascender cuentas administrativas, y exportar datos
 * personales, son solo del Super Administrador — no basta con
 * `users:create`/`users:role_change`, que cualquier ADMIN legacy trae.
 */
export async function assertIsSuperAdmin(actor: IUser, message: string): Promise<void> {
  if (await actorIsSuperAdmin(actor)) return;
  void logSystemAudit({
    userId: actor._id.toString(),
    role: actor.role,
    action: AuditAction.PRIVILEGE_ESCALATION_BLOCKED,
    entity: 'user',
    severity: AuditSeverity.CRITICAL,
    description: `${actor.name} intentó una acción reservada al Super Administrador: ${message}`,
  });
  throw new AppError(message, 403, 'PRIVILEGE_ESCALATION_BLOCKED');
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
 * Privilegiada es una cuenta con el rol `super_admin` **o** una cuenta admin
 * con `finance:manage` en `strict` (Finanzas): quien fija precios y liquida
 * dinero no la modifica un administrador operativo. Ya no se lee la marca
 * `isFinanceAdmin`.
 */
export async function assertCanModifyPrivilegedUser(
  actor: IUser,
  target: PrivilegeTarget,
  message = 'Esta cuenta tiene privilegios de Super Administrador: solo otro Super Administrador puede modificarla'
): Promise<void> {
  const targetIsSuper = (await getEffectiveRoleSlugs(target as IUser)).includes(SUPER_ADMIN_ROLE_SLUG);
  const targetIsFinance =
    target.role === UserRole.ADMIN &&
    (await computeSets(target as IUser)).strict.includes(Permission.FINANCE_MANAGE);
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
