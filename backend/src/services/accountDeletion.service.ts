import crypto from 'crypto';
import { Types } from 'mongoose';
import {
  User, IUser, Order, Address, Favorite, Notification, Driver, DriverDebt, Business,
  SavedCard, ProSubscription, ProSubscriptionStatus,
} from '../models';
import { AppError } from '../middlewares/errorHandler';
import { DebtStatus, OrderStatus, UserRole } from '../types';
import { sessionManager, DeviceFingerprint, logSystemAudit, AuditAction, AuditSeverity } from '../security';

/**
 * Supresión de datos personales de una cuenta (Ley 1581 de 2012, y el
 * requisito de borrado de cuenta de App Store 5.1.1(v) y Google Play).
 *
 * Un único camino para las dos entradas que existen:
 * - el propio usuario desde la app (`DELETE /auth/account`), y
 * - un administrador que atiende una solicitud de supresión
 *   (`PATCH /legal/admin/data-requests/:id` con `anonymize: true`).
 *
 * Antes solo existía la segunda, escrita en línea en el controlador, y dejaba
 * vivos `googleId`, `appleId`, la contraseña, los tokens de push, las sesiones
 * y las huellas de dispositivo: el titular "anonimizado" podía volver a entrar
 * con Google y encontrarse su cuenta.
 *
 * Se anonimiza, no se borra: los pedidos, pagos y asientos contables se
 * conservan porque son registro financiero, pero dejan de apuntar a una
 * persona identificable.
 */

const ACTIVE_ORDER_STATUSES = [
  OrderStatus.PENDING,
  OrderStatus.ACCEPTED,
  OrderStatus.PREPARING,
  OrderStatus.READY,
  OrderStatus.PICKED_UP,
  OrderStatus.ON_WAY,
];

export const ANONYMIZED_NAME = 'Titular anonimizado';

/**
 * Teléfono sustituto: único por cuenta, de 10 dígitos (pasa la validación del
 * modelo) y que no es un celular real porque empieza por 9. La versión
 * anterior del panel dejaba letras del hash hexadecimal dentro del campo; esta
 * las traduce a dígitos, así que no coincide con ninguna de aquellas.
 */
export function anonymizedPhoneFor(userId: string): string {
  const token = crypto.createHash('sha256').update(userId).digest('hex').slice(0, 12);
  return `9${token.slice(0, 9)}`.replace(/[a-f]/g, (c) => String(c.charCodeAt(0) % 10));
}

/**
 * Lo que impide suprimir la cuenta ahora mismo. Devuelve el motivo apto para
 * el cliente, o `null` si se puede.
 */
export async function deletionBlocker(user: Pick<IUser, '_id' | 'role'>): Promise<string | null> {
  const userId = user._id;

  if (user.role === UserRole.ADMIN) {
    return 'Las cuentas administrativas se dan de baja desde el panel, por otro Super Administrador.';
  }

  if (await Order.exists({ clientId: userId, status: { $in: ACTIVE_ORDER_STATUSES } })) {
    return 'Tienes un pedido en curso. Podrás eliminar tu cuenta cuando termine.';
  }

  if (user.role === UserRole.BUSINESS && (await Business.exists({ ownerId: userId }))) {
    return 'Tu cuenta administra un comercio. Escríbenos por Solicitudes de datos para cerrarlo antes de eliminar la cuenta.';
  }

  const driver = await Driver.findOne({ userId }).select('_id');
  if (driver) {
    if (await Order.exists({ driverId: driver._id, status: { $in: ACTIVE_ORDER_STATUSES } })) {
      return 'Tienes una entrega en curso. Podrás eliminar tu cuenta cuando termine.';
    }
    if (await DriverDebt.exists({ driverId: driver._id, status: DebtStatus.PENDING })) {
      return 'Tienes efectivo pendiente por liquidar. Liquídalo antes de eliminar tu cuenta.';
    }
  }

  return null;
}

/**
 * Anonimiza la cuenta. Idempotente: sobre una cuenta ya anonimizada no hace
 * nada y lo dice.
 */
export async function anonymizeAccount(userId: Types.ObjectId | string): Promise<{ alreadyAnonymized: boolean }> {
  const id = userId.toString();
  const user = await User.findById(id).select('role anonymizedAt');
  if (!user) throw new AppError('Usuario no encontrado', 404);
  if (user.anonymizedAt) return { alreadyAnonymized: true };

  const blocker = await deletionBlocker(user);
  if (blocker) throw new AppError(blocker, 409, 'ACCOUNT_DELETION_BLOCKED');

  const now = new Date();

  await User.updateOne(
    { _id: id },
    {
      $set: {
        name: ANONYMIZED_NAME,
        phone: anonymizedPhoneFor(id),
        isActive: false,
        isVerified: false,
        phoneVerified: false,
        emailVerified: false,
        twoFactorEnabled: false,
        marketingConsent: false,
        marketingChannels: [],
        pushTokens: [],
        trustedDevices: [],
        anonymizedAt: now,
        deactivatedAt: now,
      },
      $unset: {
        email: 1,
        avatar: 1,
        password: 1,
        // Datos de Mi cuenta: el nombre visible ya queda como ANONYMIZED_NAME.
        firstName: 1,
        lastName: 1,
        documentType: 1,
        documentNumber: 1,
        birthDate: 1,
        // Sin esto, entrar otra vez con Google/Apple recuperaba la cuenta.
        googleId: 1,
        appleId: 1,
        facebookId: 1,
        otpCode: 1, otpExpires: 1, otpAttempts: 1,
        emailOtpCode: 1, emailOtpExpires: 1, emailOtpAttempts: 1,
        pendingPhone: 1, pendingPhoneOtpCode: 1, pendingPhoneOtpExpires: 1, pendingPhoneOtpAttempts: 1,
        twoFactorSecret: 1, recoveryCodes: 1, twoFactorVerifiedAt: 1, twoFactorLastStep: 1,
        mfaChallengeHash: 1, mfaChallengeExpires: 1, mfaChallengeAttempts: 1, mfaChallengeMethod: 1,
        lastLoginIp: 1,
        lastDeviceId: 1,
        referralCode: 1,
        // Campo previo a la migración 004, por si el documento aún lo trae.
        refreshToken: 1,
      },
    }
  );

  await sessionManager.revokeAllSessions(id, { reason: 'account_deleted' });

  await Promise.all([
    DeviceFingerprint.deleteMany({ userId: id }),
    Address.deleteMany({ userId: id }),
    Favorite.deleteMany({ userId: id }),
    Notification.deleteMany({ userId: id }),
  ]);

  // S13: anonimizar dejaba vivas las tarjetas guardadas (tokenizadas en
  // Wompi, pero el vínculo con la persona ya no debería existir) y una
  // membresía Pro activa seguía cobrando a una cuenta que ya no puede
  // entrar a usarla. Sin reembolso automático aquí a propósito —eso es
  // dinero, pasa por `zipp-finance`—, pero sí queda cancelada y auditada
  // para que alguien la revise.
  const [{ deletedCount: cardsDeleted }, activeSubscription] = await Promise.all([
    SavedCard.deleteMany({ userId: id }),
    ProSubscription.findOne({
      userId: id,
      status: { $in: [ProSubscriptionStatus.ACTIVE, ProSubscriptionStatus.PENDING] },
    }),
  ]);

  if (activeSubscription) {
    activeSubscription.status = ProSubscriptionStatus.CANCELLED;
    activeSubscription.autoRenew = false;
    activeSubscription.cancelledAt = now;
    await activeSubscription.save();
  }

  if (cardsDeleted > 0 || activeSubscription) {
    void logSystemAudit({
      userId: id.toString(),
      action: AuditAction.ACCOUNT_DELETED,
      entity: 'user',
      entityId: id.toString(),
      severity: AuditSeverity.HIGH,
      description: `Anonimización: ${cardsDeleted} tarjeta(s) guardada(s) eliminada(s)` +
        (activeSubscription ? '; membresía Zipp Pro cancelada sin reembolso automático (revisar)' : ''),
      metadata: { cardsDeleted, proSubscriptionCancelled: !!activeSubscription },
    });
  }

  // Pedidos: se conservan (registro financiero) sin la dirección exacta. Las
  // coordenadas quedan a dos decimales (~1 km), útil para estadística de
  // zonas y ya no para ubicar una casa.
  const orders = await Order.find({ clientId: id }).select('_id deliveryLocation');
  if (orders.length > 0) {
    await Order.bulkWrite(
      orders.map((order) => {
        const [lng, lat] = order.deliveryLocation?.coordinates ?? [0, 0];
        return {
          updateOne: {
            filter: { _id: order._id },
            update: {
              $set: {
                deliveryAddress: 'Dirección anonimizada',
                deliveryDetails: '',
                'deliveryLocation.coordinates': [Math.round(lng * 100) / 100, Math.round(lat * 100) / 100],
              },
            },
          },
        };
      })
    );
  }

  const driver = await Driver.findOne({ userId: id }).select('_id');
  if (driver) {
    await Driver.updateOne(
      { _id: driver._id },
      { $set: { isActive: false, licensePlate: 'ANONIMIZADA' }, $unset: { emergencyContact: 1, currentLocation: 1 } }
    );
  }

  return { alreadyAnonymized: false };
}
