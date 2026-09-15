import { Request } from 'express';
import { Role, IRole, IUser, User, Position } from '../models';
import { AppError } from '../middlewares/errorHandler';
import { logAudit, AuditAction, AuditSeverity, Permission } from '../security';
import { SUPER_ADMIN_ROLE_SLUG } from '../security/rbac';
import { escapeRegex } from '../utils';
import { assertRoleMutable, hasPermission } from './authorization.service';

function slugify(name: string): string {
  return name
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // strip accents
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export class RoleService {
  async list(filters: { search?: string; isActive?: boolean; page?: number; limit?: number } = {}) {
    const { search, isActive, page = 1, limit = 50 } = filters;
    const filter: Record<string, unknown> = {};
    if (typeof isActive === 'boolean') filter.isActive = isActive;
    if (search) filter.name = { $regex: escapeRegex(search), $options: 'i' };

    const skip = (page - 1) * limit;
    const [roles, total] = await Promise.all([
      Role.find(filter).sort({ isSystem: -1, name: 1 }).skip(skip).limit(limit),
      Role.countDocuments(filter),
    ]);
    return { roles, meta: { page, limit, total, totalPages: Math.ceil(total / limit) } };
  }

  async getById(id: string): Promise<IRole> {
    const role = await Role.findById(id);
    if (!role) throw new AppError('Rol no encontrado', 404);
    return role;
  }

  /**
   * Un actor solo puede otorgar (crear un rol con, o añadir a un rol
   * existente) permisos que él mismo ya posee. Sin esto, alguien con
   * `roles:create` pero sin `finance:manage` podría crear un rol con
   * `finance:manage` y luego asignárselo a sí mismo por otra vía.
   */
  private assertGrantable(actor: IUser, actorPermissions: Permission[], permissions: Permission[]) {
    const notOwned = permissions.filter((p) => !hasPermission(actorPermissions, p));
    if (notOwned.length > 0) {
      throw new AppError(
        `No puedes otorgar permisos que no posees: ${notOwned.join(', ')}`,
        403
      );
    }
  }

  async create(
    data: { name: string; description?: string; permissions?: Permission[]; isActive?: boolean },
    actor: IUser,
    actorPermissions: Permission[],
    req?: Request
  ): Promise<IRole> {
    const name = data.name?.trim();
    if (!name) throw new AppError('El nombre del rol es requerido', 400);

    const permissions = Array.from(new Set(data.permissions || []));
    this.assertGrantable(actor, actorPermissions, permissions);

    const slug = slugify(name);
    if (slug === SUPER_ADMIN_ROLE_SLUG) {
      throw new AppError('Ese nombre está reservado para el rol de sistema', 400);
    }
    const existing = await Role.findOne({ slug });
    if (existing) throw new AppError('Ya existe un rol con ese nombre', 409);

    const role = await Role.create({
      name,
      slug,
      description: data.description?.trim() || '',
      permissions,
      isActive: data.isActive ?? true,
      isSystem: false,
      createdBy: actor._id,
      updatedBy: actor._id,
    });

    if (req) {
      await logAudit(req, {
        action: AuditAction.RBAC_ROLE_CREATED,
        entity: 'role',
        entityId: role._id.toString(),
        severity: AuditSeverity.HIGH,
        description: `Rol "${role.name}" creado con ${permissions.length} permiso(s)`,
        metadata: { permissions },
      });
    }

    return role;
  }

  async update(
    id: string,
    data: { name?: string; description?: string; permissions?: Permission[]; isActive?: boolean },
    actor: IUser,
    actorPermissions: Permission[],
    req?: Request
  ): Promise<IRole> {
    const role = await this.getById(id);
    assertRoleMutable(role);

    if (data.permissions) {
      const permissions = Array.from(new Set(data.permissions));
      this.assertGrantable(actor, actorPermissions, permissions);
      role.permissions = permissions;
    }
    if (data.name !== undefined) {
      const name = data.name.trim();
      if (!name) throw new AppError('El nombre del rol es requerido', 400);
      role.name = name;
    }
    if (data.description !== undefined) role.description = data.description.trim();
    if (typeof data.isActive === 'boolean') role.isActive = data.isActive;
    role.updatedBy = actor._id;

    await role.save();

    if (req) {
      await logAudit(req, {
        action: data.permissions
          ? AuditAction.RBAC_ROLE_PERMISSIONS_CHANGED
          : AuditAction.RBAC_ROLE_UPDATED,
        entity: 'role',
        entityId: role._id.toString(),
        severity: AuditSeverity.HIGH,
        description: `Rol "${role.name}" actualizado`,
        metadata: { changes: data },
      });
    }

    return role;
  }

  async delete(id: string, actor: IUser, req?: Request): Promise<void> {
    const role = await this.getById(id);
    assertRoleMutable(role);

    const [usersWithRole, positionsWithRole] = await Promise.all([
      User.countDocuments({ roleIds: role._id }),
      Position.countDocuments({ roleIds: role._id }),
    ]);
    if (usersWithRole > 0 || positionsWithRole > 0) {
      throw new AppError(
        `No se puede eliminar: el rol está asignado a ${usersWithRole} usuario(s) y ${positionsWithRole} cargo(s). Desactívalo o quítalo de esas asignaciones primero.`,
        409
      );
    }

    await Role.findByIdAndDelete(id);

    if (req) {
      await logAudit(req, {
        action: AuditAction.RBAC_ROLE_DELETED,
        entity: 'role',
        entityId: id,
        severity: AuditSeverity.HIGH,
        description: `Rol "${role.name}" eliminado`,
      });
    }
  }

  async getUsersWithRole(id: string, page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    const [users, total] = await Promise.all([
      User.find({ roleIds: id }).select('name phone email role isActive isBlocked').skip(skip).limit(limit),
      User.countDocuments({ roleIds: id }),
    ]);
    return { users, meta: { page, limit, total, totalPages: Math.ceil(total / limit) } };
  }
}

export const roleService = new RoleService();
