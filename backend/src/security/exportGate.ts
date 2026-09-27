import { Request } from 'express';
import { AppError } from '../middlewares';
import { AuditAction, AuditSeverity, logAudit } from './audit';
import { clientIp } from '../utils';

/**
 * Puerta común de los exportes (S9, S14): un motivo escrito y el código TOTP
 * de la petición verificado — no basta con haber pasado ya el 2FA de la
 * sesión, porque descargar datos de miles de personas o el libro contable es
 * una acción puntual que merece su propia confirmación, igual que aprobar un
 * pago grande.
 *
 * `superAdminOnly` (por defecto sí) es para los exportes con datos
 * personales (decisión 10). Los exportes contables de Finanzas no llevan
 * teléfonos ni documentos: los hace quien tenga `reports:export` +
 * `finance:view` (la ruta lo exige), pero con la misma prueba de motivo y TOTP.
 */
export async function assertExportAuthorized(
  req: Request,
  reason: unknown,
  totpToken: unknown,
  options: { superAdminOnly?: boolean } = {}
): Promise<void> {
  const { superAdminOnly = true } = options;

  if (superAdminOnly) {
    const { actorIsSuperAdmin } = await import('../services/authorization.service');
    if (!(await actorIsSuperAdmin(req.user!))) {
      throw new AppError('Solo un Super Administrador puede exportar estos datos', 403, 'PRIVILEGE_ESCALATION_BLOCKED');
    }
  }
  await assertStepUpAuthorized(req, reason, totpToken, 'del exporte', 'en un exporte');
}

/**
 * La misma prueba —motivo escrito y TOTP de la petición, con tope de
 * intentos— para cualquier acción puntual de alto impacto, no solo exportes:
 * p. ej. cerrar todas las sesiones de un comercio desde el centro de
 * seguridad. Comparte contador con los exportes a propósito: probar códigos
 * en una acción no regala cinco intentos más en la otra.
 */
export async function assertStepUpAuthorized(
  req: Request,
  reason: unknown,
  totpToken: unknown,
  /** "del exporte", "de la revocación"… */
  what = 'de la acción',
  /** Para la auditoría: "en un exporte", "al revocar sesiones"… */
  where = 'en una acción sensible'
): Promise<void> {
  if (typeof reason !== 'string' || reason.trim().length < 5) {
    throw new AppError(`Indica el motivo ${what} (mínimo 5 caracteres)`, 400);
  }
  if (typeof totpToken !== 'string' || !totpToken.trim()) {
    throw new AppError('Confirma con tu código de verificación en dos pasos', 401, 'MFA_CODE_REQUIRED');
  }

  // M2: el TOTP de un exporte no tenía tope de intentos — se podía probar
  // el código a fuerza bruta contra un endpoint que, si acierta, entrega
  // datos masivos. Reutiliza el mismo contador que el login (5 fallos por
  // cuenta) y, al llegar al tope, además revoca la sesión actual: un TOTP
  // fallando repetido aquí huele más a sesión robada que a una persona que
  // se equivocó de dígito.
  const { checkBruteForce, recordFailedAttempt, clearAttempts } = await import('./bruteforce');
  const actorId = req.user!._id.toString();
  const bruteKey = `export:${actorId}`;
  const ip = clientIp(req);
  const bruteCheck = await checkBruteForce(ip, bruteKey);
  if (!bruteCheck.allowed) {
    throw new AppError(bruteCheck.reason || 'Demasiados intentos. Intenta más tarde.', 429);
  }

  const { verifySecondFactor } = await import('../services/mfa.service');
  if (!(await verifySecondFactor(req.user!._id, totpToken.trim()))) {
    const attempt = await recordFailedAttempt(ip, bruteKey);
    if (!attempt.allowed) {
      const { sessionManager } = await import('./sessions');
      const sessionId = req.sessionId;
      if (sessionId) await sessionManager.revokeSession(sessionId, actorId, 'reuse_detected');
      await logAudit(req, {
        action: AuditAction.TOTP_FAILED,
        entity: 'user',
        entityId: actorId,
        severity: AuditSeverity.CRITICAL,
        description: `5 códigos TOTP inválidos seguidos ${where} — sesión revocada`,
      });
    }
    throw new AppError('Código de verificación en dos pasos inválido', 401, 'MFA_CODE_INVALID');
  }
  await clearAttempts(ip, bruteKey);
}
