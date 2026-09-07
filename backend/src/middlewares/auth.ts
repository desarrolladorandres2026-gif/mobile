import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { User, IUser } from '../models';
import { AppError } from './errorHandler';
import { UserRole } from '../types';
import { Permission, logAudit, AuditAction, AuditSeverity } from '../security';
import { getEffectivePermissions, getEffectiveRoleSlugs } from '../services/authorization.service';

// Extend Express Request. `declare global { namespace Express {...} } ` is
// the idiomatic — and only — way to augment a third-party module's ambient
// types in TypeScript; there is no ES module syntax for it, so the usual
// no-namespace rule is disabled for this one declaration rather than for
// the file or the project.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: IUser;
      sessionId?: string;
      deviceId?: string;
      /**
       * Permisos efectivos del usuario autenticado (legacy por `role` +
       * RBAC dinámico por Cargo/Roles), resueltos una sola vez por request
       * en `authenticate` — ver `services/authorization.service.ts`. Todo
       * middleware de autorización de este archivo lee de aquí en vez de
       * recalcular, así que un cambio de rol/permiso se refleja en la
       * siguiente request sin necesidad de reemitir el token.
       */
      permissions?: Permission[];
      roleSlugs?: string[];
    }
  }
}

interface JwtPayload {
  id: string;
  role: UserRole;
  sessionId?: string;
}

export const authenticate = async (
  req: Request,
  _res: Response,
  next: NextFunction
) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      throw new AppError('No autorizado. Token no proporcionado.', 401);
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, config.jwt.secret) as JwtPayload;

    const user = await User.findById(decoded.id);
    if (!user) {
      throw new AppError('Usuario no encontrado o desactivado', 401);
    }

    // Un usuario BLOQUEADO o INACTIVO no puede autenticarse ni usar
    // sesiones existentes: aunque el token sea válido, cada request pasa
    // por aquí y vuelve a comprobar el estado actual en base de datos.
    if (user.isBlocked) {
      throw new AppError('Tu cuenta está bloqueada. Contacta a soporte.', 401);
    }
    if (!user.isActive) {
      throw new AppError('Usuario no encontrado o desactivado', 401);
    }

    // Check if password was changed after token was issued.
    //
    // A JWT's `iat` has one-second resolution, so it is always rounded DOWN,
    // while passwordChangedAt keeps milliseconds. Comparing them directly
    // made every token minted right after a password write look stale —
    // which invalidated the tokens returned by register, reset-password and
    // change-password the instant they were used. Truncate both to seconds.
    const issuedAt = (decoded as any).iat as number | undefined;
    if (user.passwordChangedAt && typeof issuedAt === 'number') {
      const changedAtSeconds = Math.floor(user.passwordChangedAt.getTime() / 1000);
      if (changedAtSeconds > issuedAt) {
        throw new AppError('Contraseña cambiada recientemente. Inicia sesión nuevamente.', 401);
      }
    }

    req.user = user;
    req.sessionId = decoded.sessionId;

    // Resueltos una vez por request; ver el comentario en la declaración
    // de tipos más arriba.
    const [permissions, roleSlugs] = await Promise.all([
      getEffectivePermissions(user),
      getEffectiveRoleSlugs(user),
    ]);
    req.permissions = permissions;
    req.roleSlugs = roleSlugs;

    next();
  } catch (error) {
    if (error instanceof AppError) return next(error);
    next(new AppError('Token inválido o expirado', 401));
  }
};

export const authorize = (...roles: UserRole[]) => {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) {
      return next(new AppError('No autorizado', 401));
    }
    if (!roles.includes(req.user.role as UserRole)) {
      return next(new AppError('No tienes permisos para esta acción', 403));
    }
    next();
  };
};

/**
 * Gate for money-moving operations: editing pricing, verifying cash
 * remittances, settling payouts and issuing refunds.
 *
 * Deliberately narrower than `authorize(ADMIN)`. Every operations admin can
 * see finance; only a designated finance admin can change what the platform
 * charges or declare that money arrived. Denials are audited, because an
 * attempt to reach these endpoints is worth knowing about.
 */
export const requireFinanceAdmin = (
  req: Request,
  _res: Response,
  next: NextFunction
) => {
  if (!req.user) return next(new AppError('No autorizado', 401));

  const isAdmin = req.user.role === UserRole.ADMIN;
  if (isAdmin && req.user.isFinanceAdmin) return next();

  logAudit(req, {
    action: AuditAction.SUSPICIOUS_ACTIVITY,
    entity: 'finance',
    severity: AuditSeverity.HIGH,
    description: 'Intento de acceso a operaciones financieras sin rol de admin financiero',
    metadata: { userRole: req.user.role, isFinanceAdmin: req.user.isFinanceAdmin },
  });

  return next(
    new AppError(
      'Esta operación requiere permisos de administrador financiero',
      403
    )
  );
};

/**
 * Permission-based authorization middleware (RBAC)
 *
 * Más granular que `authorize`: en vez de comparar contra `role`, exige
 * TODOS los permisos dados de la lista efectiva calculada en
 * `authenticate` (legacy `role` + Cargo/Roles de RBAC). Nunca confía en
 * nada que venga del cliente.
 */
export const requirePermission = (...permissions: Permission[]) => {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) {
      return next(new AppError('No autorizado', 401));
    }

    const granted = req.permissions || [];
    const hasAll = permissions.every((p) => granted.includes(p));

    if (!hasAll) {
      // Log unauthorized access attempt
      logAudit(req, {
        action: AuditAction.SUSPICIOUS_ACTIVITY,
        entity: 'permission',
        severity: AuditSeverity.MEDIUM,
        description: `Intento de acceso sin permisos: ${permissions.join(', ')}`,
        metadata: { requiredPermissions: permissions, userRole: req.user.role },
      });

      return next(new AppError('No tienes permisos suficientes para esta acción', 403));
    }
    next();
  };
};

/**
 * Require any one of the specified permissions
 */
export const requireAnyPermission = (...permissions: Permission[]) => {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) {
      return next(new AppError('No autorizado', 401));
    }

    const granted = req.permissions || [];
    const hasAny = permissions.some((p) => granted.includes(p));

    if (!hasAny) {
      logAudit(req, {
        action: AuditAction.SUSPICIOUS_ACTIVITY,
        entity: 'permission',
        severity: AuditSeverity.MEDIUM,
        description: `Intento de acceso sin ninguno de los permisos: ${permissions.join(', ')}`,
        metadata: { requiredPermissions: permissions, userRole: req.user.role },
      });
      return next(new AppError('No tienes permisos suficientes para esta acción', 403));
    }
    next();
  };
};

/**
 * Require a specific RBAC role by slug (p. ej. `super_admin`). Distinto de
 * `authorize`, que compara contra el tipo de cuenta legacy (`role`).
 */
export const requireRole = (...slugs: string[]) => {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) {
      return next(new AppError('No autorizado', 401));
    }
    const granted = req.roleSlugs || [];
    if (!slugs.some((s) => granted.includes(s))) {
      return next(new AppError('No tienes permisos suficientes para esta acción', 403));
    }
    next();
  };
};
