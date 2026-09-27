import { Request, Response, NextFunction } from 'express';
import { User, IUser } from '../models';
import { AppError } from './errorHandler';
import { UserRole } from '../types';
import { Permission, logAudit, AuditAction, AuditSeverity, sessionManager } from '../security';
import { verifyAccessToken, isLegacyTokenAcceptable } from '../utils/token';
import {
  resolveAuthorization,
  type ResolvedAuthorization,
} from '../services/authorization.service';
import { twoFactorSetupPending } from '../services/mfa.service';
import { cache } from '../cache';

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
      /**
       * Autorización completa (Fase 1): `strict` = lo que puede hacer de
       * verdad, `legacyUnion` = cálculo anterior, `mode` = observe|enforce.
       * `can()` decide con esto; nada más debería leer `permissions`.
       */
      authz?: ResolvedAuthorization;
      /**
       * Administrador sin 2FA con `TOTP_REQUIRED_ADMINS` activo: solo puede
       * llegar a las rutas para configurarlo. Ver `authenticate`.
       */
      twoFactorSetupRequired?: boolean;
    }
  }
}

/**
 * Rutas que un administrador sin 2FA puede usar mientras lo configura. Todo
 * lo demás responde 403 `TWO_FACTOR_SETUP_REQUIRED` hasta que lo active.
 */
const TWO_FACTOR_SETUP_PATHS = new Set([
  '/api/v1/auth/me',
  '/api/v1/auth/logout',
  '/api/v1/auth/2fa/setup',
  '/api/v1/auth/2fa/verify',
]);

const requestPath = (req: Request) => (req.originalUrl || req.url || '').split('?')[0].replace(/\/+$/, '');

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
    const decoded = verifyAccessToken(token);

    // El token pertenece a una sesión (`sid`) y esa sesión tiene que seguir
    // viva: cerrar sesión, revocarla desde "mis dispositivos", un cambio de
    // contraseña o un bloqueo cortan también el access token vigente, en vez
    // de dejarlo útil hasta que caduque.
    if (!decoded.sid && !isLegacyTokenAcceptable(decoded)) {
      // Sin `sid` solo se aceptan tokens emitidos antes de este despliegue,
      // hasta que caduquen solos. Ver `LEGACY_ACCESS_TOKEN_CUTOFF`.
      throw new AppError('Token inválido o expirado', 401);
    }

    // La sesión y el usuario se piden a la vez: son independientes, y en
    // serie cada petición autenticada pagaba dos viajes a la base antes de
    // llegar al controlador. Los resultados se comprueban en el mismo orden
    // de antes (sesión primero), así que los códigos de error no cambian.
    const [active, user] = await Promise.all([
      decoded.sid ? sessionManager.isSessionActive(decoded.sid, decoded.id) : Promise.resolve(true),
      User.findById(decoded.id).catch(() => null),
    ]);
    if (!active) {
      throw new AppError('Tu sesión se cerró. Inicia sesión nuevamente.', 401, 'SESSION_REVOKED');
    }
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
    const issuedAt = decoded.iat;
    if (user.passwordChangedAt && typeof issuedAt === 'number') {
      const changedAtSeconds = Math.floor(user.passwordChangedAt.getTime() / 1000);
      if (changedAtSeconds > issuedAt) {
        throw new AppError('Contraseña cambiada recientemente. Inicia sesión nuevamente.', 401);
      }
    }

    req.user = user;
    req.sessionId = decoded.sid;

    // `TOTP_REQUIRED_ADMINS` existía en la configuración y nada lo aplicaba:
    // un administrador con permisos sobre dinero y usuarios entraba solo con
    // contraseña. Ahora, sin 2FA, solo alcanza las rutas para configurarlo.
    // Lo mismo para comercios con `TOTP_REQUIRED_BUSINESS`.
    if (twoFactorSetupPending(user)) {
      req.twoFactorSetupRequired = true;
      if (!TWO_FACTOR_SETUP_PATHS.has(requestPath(req))) {
        throw new AppError(
          user.role === UserRole.BUSINESS
            ? 'Activa la verificación en dos pasos para usar el panel de comercios.'
            : 'Activa la verificación en dos pasos para usar el panel de administración.',
          403,
          'TWO_FACTOR_SETUP_REQUIRED'
        );
      }
    }

    // Resueltos una vez por request; ver el comentario en la declaración
    // de tipos más arriba.
    const authz = await resolveAuthorization(user);
    req.authz = authz;
    // `req.permissions` es lo que leen los controladores que aún no usan
    // `can()`: en modo observación un admin conserva el conjunto legacy (nadie
    // pierde acceso); en bloqueo, y para cualquier otra cuenta, es `strict`.
    req.permissions =
      user.role === UserRole.ADMIN && authz.mode === 'observe' ? authz.legacyUnion : authz.strict;
    req.roleSlugs = authz.roleSlugs;

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

type Verdict = 'allow' | 'shadow' | 'deny';

/** Decide sin efectos secundarios. */
function evaluatePermission(req: Request, permission: Permission): Verdict {
  const authz = req.authz;
  if (!authz) return (req.permissions || []).includes(permission) ? 'allow' : 'deny';
  if (authz.strict.includes(permission)) return 'allow';
  if (authz.mode === 'observe' && authz.legacyUnion.includes(permission)) return 'shadow';
  return 'deny';
}

const SHADOW_DEDUPE_TTL_SECONDS = 3600;

/**
 * Modo observación: deja rastro de que el admin habría sido bloqueado.
 * Una línea por (usuario, permiso, ruta) y hora. La clave NO usa el prefijo
 * `authz:` porque el plugin de `Role` lo borra al editar un rol. Si la caché
 * falla se registra igual: una línea repetida es aceptable, perder el
 * registro no.
 */
async function recordShadowDenied(req: Request, permission: Permission): Promise<void> {
  const route = `${req.baseUrl || ''}${req.route?.path ?? ''}`;
  try {
    const key = `authzshadow:${req.user?._id?.toString()}:${permission}:${route}`;
    if (await cache.get<number>(key)) return;
    await cache.set(key, 1, SHADOW_DEDUPE_TTL_SECONDS);
  } catch {
    // seguimos y registramos
  }
  await logAudit(req, {
    action: AuditAction.PERMISSION_SHADOW_DENIED,
    entity: 'permission',
    severity: AuditSeverity.LOW,
    description: `Modo observación: se bloquearía por falta de ${permission}`,
    metadata: { permission, method: req.method, route, roleSlugs: req.roleSlugs || [] },
    pathOverride: route,
  });
}

/**
 * Única función que decide si la request puede ejercer un permiso.
 *   - en `strict`                                  → true
 *   - falta en `strict`, está en `legacyUnion` y modo 'observe' → registra y true
 *   - otro caso                                    → false (el llamador responde 403)
 * Úsala también desde los controladores que comprueban permisos por dentro.
 */
export function can(req: Request, permission: Permission): boolean {
  if (!req.user) return false;
  const verdict = evaluatePermission(req, permission);
  if (verdict === 'shadow') void recordShadowDenied(req, permission);
  return verdict !== 'deny';
}

type PermissionMiddleware = ((req: Request, res: Response, next: NextFunction) => void) & {
  /** Permisos que exige, para que una meta-prueba recorra el router. */
  __permissions: string[];
};

function tag(mw: (req: Request, res: Response, next: NextFunction) => void, permissions: string[]): PermissionMiddleware {
  return Object.assign(mw, { __permissions: permissions });
}

function denyAndAudit(req: Request, next: NextFunction, description: string, permissions: Permission[]) {
  logAudit(req, {
    action: AuditAction.SUSPICIOUS_ACTIVITY,
    entity: 'permission',
    severity: AuditSeverity.MEDIUM,
    description,
    metadata: { requiredPermissions: permissions, userRole: req.user?.role },
  });
  return next(new AppError('No tienes permisos suficientes para esta acción', 403));
}

/**
 * Gate for money-moving operations: editing pricing, verifying cash
 * remittances, settling payouts. Exige `finance:manage` (rol Finanzas o
 * Super Administrador); ya no lee la marca `isFinanceAdmin`. Denials are
 * audited, because an attempt to reach these endpoints is worth knowing about.
 */
export const requireFinanceAdmin = tag((req, _res, next) => {
  if (!req.user) return next(new AppError('No autorizado', 401));

  if (req.user.role === UserRole.ADMIN && can(req, Permission.FINANCE_MANAGE)) return next();

  logAudit(req, {
    action: AuditAction.SUSPICIOUS_ACTIVITY,
    entity: 'finance',
    severity: AuditSeverity.HIGH,
    description: 'Intento de acceso a operaciones financieras sin el permiso finance:manage',
    metadata: { userRole: req.user.role },
  });

  return next(
    new AppError('Esta operación requiere permisos de administrador financiero', 403)
  );
}, [Permission.FINANCE_MANAGE]);

/**
 * Permission-based authorization (RBAC): exige TODOS los permisos dados, con
 * la lógica de `can()` (estricto / observación). Ojo: NO restringe por tipo
 * de cuenta y comercios/domiciliarios comparten algunos permisos con el
 * staff; en rutas compartidas usa `adminRequires`.
 */
export const requirePermission = (...permissions: Permission[]) =>
  tag((req, _res, next) => {
    if (!req.user) return next(new AppError('No autorizado', 401));
    if (permissions.every((p) => can(req, p))) return next();
    return denyAndAudit(req, next, `Intento de acceso sin permisos: ${permissions.join(', ')}`, permissions);
  }, permissions);

/**
 * Require any one of the specified permissions
 */
export const requireAnyPermission = (...permissions: Permission[]) =>
  tag((req, _res, next) => {
    if (!req.user) return next(new AppError('No autorizado', 401));

    const verdicts = permissions.map((p) => evaluatePermission(req, p));
    if (verdicts.includes('allow')) return next();
    const shadowIdx = verdicts.indexOf('shadow');
    if (shadowIdx >= 0) {
      void recordShadowDenied(req, permissions[shadowIdx]);
      return next();
    }
    return denyAndAudit(req, next, `Intento de acceso sin ninguno de los permisos: ${permissions.join(', ')}`, permissions);
  }, permissions);

/**
 * Para rutas COMPARTIDAS con comercio o domiciliario: el permiso solo se
 * exige cuando quien llama es admin. Cualquier otro rol pasa sin más (sus
 * propias comprobaciones siguen en el controlador): nunca abre la ruta a
 * otros roles ni la cierra para ellos.
 */
export const adminRequires = (permission: Permission) => {
  const gate = requirePermission(permission);
  return tag((req, res, next) => {
    if (req.user && req.user.role !== UserRole.ADMIN) return next();
    return gate(req, res, next);
  }, [permission]);
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
