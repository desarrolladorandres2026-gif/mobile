import { Request } from 'express';
import { Position, IPosition, IUser, User, Role } from '../models';
import { AppError } from '../middlewares/errorHandler';
import { logAudit, AuditAction, AuditSeverity } from '../security';
import { assertCanAssignRoles, assertNotOwnPosition } from './authorization.service';
import { disconnectSocketsOfPosition } from './authzSockets.service';
import { escapeRegex } from '../utils';

function slugify(name: string): string {
  return name
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export class PositionService {
  async list(filters: { search?: string; isActive?: boolean; page?: number; limit?: number } = {}) {
    const { search, isActive, page = 1, limit = 50 } = filters;
    const filter: Record<string, unknown> = {};
    if (typeof isActive === 'boolean') filter.isActive = isActive;
    if (search) filter.name = { $regex: escapeRegex(search), $options: 'i' };

    const skip = (page - 1) * limit;
    const [positions, total] = await Promise.all([
      Position.find(filter).populate('roleIds', 'name slug isActive').sort({ name: 1 }).skip(skip).limit(limit),
      Position.countDocuments(filter),
    ]);
    return { positions, meta: { page, limit, total, totalPages: Math.ceil(total / limit) } };
  }

  async getById(id: string): Promise<IPosition> {
    const position = await Position.findById(id).populate('roleIds', 'name slug isActive');
    if (!position) throw new AppError('Cargo no encontrado', 404);
    return position;
  }

  private async validateRoleIds(roleIds: string[] = []): Promise<string[]> {
    if (roleIds.length === 0) return [];
    const found = await Role.find({ _id: { $in: roleIds } }).select('_id');
    if (found.length !== new Set(roleIds).size) {
      throw new AppError('Uno o más roles seleccionados no existen', 400);
    }
    return roleIds;
  }

  async create(
    data: { name: string; description?: string; roleIds?: string[]; isActive?: boolean },
    actor: IUser,
    req?: Request
  ): Promise<IPosition> {
    const name = data.name?.trim();
    if (!name) throw new AppError('El nombre del cargo es requerido', 400);

    const roleIds = await this.validateRoleIds(data.roleIds);
    // Otorgar un Cargo transitivamente otorga sus Roles: la misma guarda
    // de escalamiento aplica aquí que al asignar Roles directamente.
    await assertCanAssignRoles(actor, roleIds);

    const slug = slugify(name);
    const existing = await Position.findOne({ slug });
    if (existing) throw new AppError('Ya existe un cargo con ese nombre', 409);

    const position = await Position.create({
      name,
      slug,
      description: data.description?.trim() || '',
      roleIds,
      isActive: data.isActive ?? true,
      createdBy: actor._id,
      updatedBy: actor._id,
    });

    if (req) {
      await logAudit(req, {
        action: AuditAction.POSITION_CREATED,
        entity: 'position',
        entityId: position._id.toString(),
        severity: AuditSeverity.MEDIUM,
        description: `Cargo "${position.name}" creado`,
        metadata: { roleIds },
      });
    }

    return this.getById(position._id.toString());
  }

  async update(
    id: string,
    data: { name?: string; description?: string; roleIds?: string[]; isActive?: boolean },
    actor: IUser,
    req?: Request
  ): Promise<IPosition> {
    const position = await Position.findById(id);
    if (!position) throw new AppError('Cargo no encontrado', 404);

    // No se edita el Cargo que uno mismo tiene: sería autoescalada por otra vía.
    await assertNotOwnPosition(actor, id);

    if (data.roleIds) {
      const roleIds = await this.validateRoleIds(data.roleIds);
      await assertCanAssignRoles(actor, roleIds);
      position.roleIds = roleIds as any;
    } else if (data.isActive === true && !position.isActive) {
      // Reactivar un Cargo vuelve a otorgar sus Roles a quien lo tiene: mismo tope.
      await assertCanAssignRoles(actor, position.roleIds);
    }
    if (data.name !== undefined) {
      const name = data.name.trim();
      if (!name) throw new AppError('El nombre del cargo es requerido', 400);
      position.name = name;
    }
    if (data.description !== undefined) position.description = data.description.trim();
    if (typeof data.isActive === 'boolean') position.isActive = data.isActive;
    position.updatedBy = actor._id;

    await position.save();
    // Quienes tienen este Cargo deben recalcular sus salas de socket.
    await disconnectSocketsOfPosition(position._id);

    if (req) {
      await logAudit(req, {
        action: AuditAction.POSITION_UPDATED,
        entity: 'position',
        entityId: id,
        severity: AuditSeverity.MEDIUM,
        description: `Cargo "${position.name}" actualizado`,
        metadata: { changes: data },
      });
    }

    return this.getById(id);
  }

  async delete(id: string, req?: Request): Promise<void> {
    const position = await Position.findById(id);
    if (!position) throw new AppError('Cargo no encontrado', 404);

    const usersWithPosition = await User.countDocuments({ positionId: id });
    if (usersWithPosition > 0) {
      throw new AppError(
        `No se puede eliminar: el cargo está asignado a ${usersWithPosition} usuario(s). Reasígnalos primero.`,
        409
      );
    }

    await Position.findByIdAndDelete(id);

    if (req) {
      await logAudit(req, {
        action: AuditAction.POSITION_DELETED,
        entity: 'position',
        entityId: id,
        severity: AuditSeverity.MEDIUM,
        description: `Cargo "${position.name}" eliminado`,
      });
    }
  }

  async getUsersInPosition(id: string, page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    const [users, total] = await Promise.all([
      User.find({ positionId: id }).select('name phone email role isActive isBlocked').skip(skip).limit(limit),
      User.countDocuments({ positionId: id }),
    ]);
    return { users, meta: { page, limit, total, totalPages: Math.ceil(total / limit) } };
  }
}

export const positionService = new PositionService();
