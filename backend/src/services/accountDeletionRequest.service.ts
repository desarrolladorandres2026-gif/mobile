import type { Request } from 'express';
import { User, DataRequest } from '../models';
import { UserRole } from '../types';
import { AuditAction, AuditSeverity, logAudit } from '../security';
import { whatsappService } from './whatsapp.service';
import { publicOtpService } from './publicOtp.service';
import { computeDataRequestLegalDueAt } from './legal.service';

/**
 * Solicitud de eliminación de cuenta SIN sesión (Google Play la exige en una
 * URL pública).
 *
 * Regla de oro: la respuesta es idéntica exista o no la cuenta. Por eso:
 * - `sendOtp` hace siempre el mismo trabajo en base de datos y manda el
 *   WhatsApp sin esperarlo (así la latencia del proveedor no delata nada), y
 *   solo manda el mensaje si la cuenta existe: a un número sin cuenta no se le
 *   escribe.
 * - `confirm` falla igual (`OTP_INVALID`) con un código malo, vencido o de un
 *   número que nunca tuvo código.
 * - Con el código correcto responde lo mismo haya o no cuenta, o ya haya una
 *   solicitud abierta.
 *
 * No borra nada: deja una `DataRequest` de tipo `delete` para que un
 * administrador la atienda con el flujo existente (`accountDeletion.service`,
 * que además comprueba pedidos activos, deudas y cuentas administrativas).
 */

export const DELETION_OTP_MESSAGE = 'Si el número tiene una cuenta en ZIPP, te enviaremos un código por WhatsApp.';
export const DELETION_CONFIRM_MESSAGE =
  'Recibimos tu solicitud. Si el número corresponde a una cuenta, nuestro equipo la revisará y te avisaremos el resultado.';

const WEB_DETAIL = 'Solicitud de eliminación de cuenta hecha desde el sitio web, verificada con un código enviado por WhatsApp.';

/** Cuenta que puede pedir su eliminación por este camino: existe, no está ya anonimizada y no es del equipo. */
async function findEligibleUser(phone: string) {
  const user = await User.findOne({ phone }).select('_id role anonymizedAt');
  if (!user || user.anonymizedAt || user.role === UserRole.ADMIN) return null;
  return user;
}

export const accountDeletionRequestService = {
  async sendOtp(phone: string): Promise<void> {
    const [user, code] = await Promise.all([findEligibleUser(phone), publicOtpService.issue('account_deletion', phone)]);
    if (user && code) {
      void whatsappService.sendOTP(phone, code).catch(() => {
        // El mensaje del error ya viene sin el código; aquí no se dice a quién iba.
        console.error('[OTP] No se pudo entregar un código de eliminación de cuenta.');
      });
    }
  },

  async confirm(input: { phone: string; otp: string; reason?: string }, req: Request): Promise<void> {
    await publicOtpService.verify('account_deletion', input.phone, input.otp, req);

    const user = await findEligibleUser(input.phone);
    if (!user) return;

    // Una solicitud abierta por cuenta: repetir el formulario no apila trabajo.
    const open = await DataRequest.exists({ userId: user._id, type: 'delete', status: { $in: ['received', 'in_review'] } });
    if (open) return;

    const createdAt = new Date();
    const request = await DataRequest.create({
      userId: user._id,
      type: 'delete',
      detail: input.reason ? `${WEB_DETAIL}\nMotivo: ${input.reason}` : WEB_DETAIL,
      legalDueAt: computeDataRequestLegalDueAt('delete', createdAt),
      createdAt,
    });

    await logAudit(req, {
      action: AuditAction.ACCOUNT_DELETION_REQUESTED,
      entity: 'user',
      entityId: user._id.toString(),
      userId: user._id.toString(),
      role: user.role,
      severity: AuditSeverity.HIGH,
      description: 'Solicitud de eliminación de cuenta desde el sitio web (celular verificado por código)',
      metadata: { channel: 'web', dataRequestId: request._id.toString(), hasReason: !!input.reason },
    });
  },
};
