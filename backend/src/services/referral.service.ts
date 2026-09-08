import { randomBytes } from 'crypto';
import { User, IUser, Order } from '../models';
import { OrderStatus } from '../types';
import {
  antiFraudService,
  FraudAlertType,
  RiskLevel,
  IdentityLink,
} from '../security';
import { AppError } from '../middlewares/errorHandler';
import { loyaltyService } from './loyalty.service';
import { pricingConfigService } from './pricingConfig.service';

/**
 * Invitaciones.
 *
 * Antes la app compartía el código fijo `BIENVENIDO` para todo el mundo, así
 * que la función se llamaba "referidos" y no refería a nadie: no había forma
 * de saber quién trajo a quién ni, por tanto, a quién premiar.
 *
 * Un programa de invitaciones sin defensas es dinero regalado: crear cuentas
 * es gratis y la recompensa no. Por eso la mitad de este archivo son
 * comprobaciones, y por eso el premio se paga cuando el invitado *compra* y
 * no cuando se registra.
 */

/** Puntos para quien invita. Cero desactiva el programa. */
const REFERRER_POINTS = 5000;
/** Puntos para quien llega invitado, al completar su primera compra. */
const INVITEE_POINTS = 3000;

/**
 * Cuántas invitaciones puede cobrar una persona.
 *
 * No es desconfianza hacia el usuario normal —nadie tiene cincuenta amigos
 * que se instalen la app el mismo mes— sino el techo que convierte un fraude
 * rentable en uno que no compensa el esfuerzo.
 */
const MAX_REWARDED_REFERRALS = 20;

export class ReferralService {
  /**
   * Devuelve el código del usuario, generándolo si aún no tiene.
   *
   * Se genera al pedirlo y no en el registro para no tocar el alta de todo
   * el mundo por una función que la mayoría no usa.
   */
  async codeFor(userId: string): Promise<string> {
    const user = await User.findById(userId).select('name referralCode');
    if (!user) throw new AppError('Usuario no encontrado', 404);
    if (user.referralCode) return user.referralCode;

    // Se reintenta ante colisión en vez de confiar en la suerte: con miles
    // de usuarios, un choque deja de ser improbable y pasa a ser cuestión
    // de tiempo.
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = `Z${randomBytes(3).toString('hex').toUpperCase()}`;
      try {
        await User.updateOne({ _id: userId }, { $set: { referralCode: code } });
        return code;
      } catch (error: unknown) {
        if ((error as { code?: number }).code !== 11000) throw error;
      }
    }

    throw new AppError('No pudimos generar tu código. Inténtalo de nuevo.', 500);
  }

  /**
   * Atribuye un registro nuevo a quien lo invitó.
   *
   * Solo apunta quién trajo a quién: el premio se paga después, cuando el
   * invitado compra. Pagar al registrarse convierte el programa en una
   * máquina de crear cuentas vacías.
   */
  async attribute(newUserId: string, code: string): Promise<void> {
    const normalized = code.trim().toUpperCase();
    if (!normalized) return;

    const referrer = await User.findOne({ referralCode: normalized }).select('_id');
    if (!referrer) throw new AppError('Ese código de invitación no existe', 404);

    if (referrer._id.toString() === newUserId) {
      throw new AppError('No puedes invitarte a ti mismo', 400);
    }

    const invitee = await User.findById(newUserId).select('referredBy createdAt');
    if (!invitee) throw new AppError('Usuario no encontrado', 404);

    // Se fija una vez. Sin esto, alguien podría ir cambiando de padrino
    // hasta encontrar uno que le convenga.
    if (invitee.referredBy) {
      throw new AppError('Ya usaste un código de invitación', 409);
    }

    await User.updateOne({ _id: newUserId }, { $set: { referredBy: referrer._id } });
  }

  /**
   * ¿Esta invitación huele a cuenta falsa?
   *
   * Devuelve el motivo cuando lo hay, para poder registrarlo y explicarlo.
   * Las tres señales son las que de verdad aparecen: el mismo teléfono
   * creando cuentas, un padrino con demasiados ahijados, y una invitación
   * cobrada por alguien que nunca ha comprado nada.
   */
  private async abuseReason(
    referrerId: string,
    inviteeId: string
  ): Promise<string | null> {
    const [referrerDevices, inviteeDevices] = await Promise.all([
      IdentityLink.find({ kind: 'device', userId: referrerId }).distinct('key'),
      IdentityLink.find({ kind: 'device', userId: inviteeId }).distinct('key'),
    ]);

    const shared = referrerDevices.filter((d) => inviteeDevices.includes(d));
    if (shared.length) {
      return 'El invitado y quien invita usan el mismo dispositivo';
    }

    const rewarded = await User.countDocuments({
      referredBy: referrerId,
      referralRewardedAt: { $ne: null },
    });
    if (rewarded >= MAX_REWARDED_REFERRALS) {
      return `Superó el máximo de ${MAX_REWARDED_REFERRALS} invitaciones premiadas`;
    }

    const referrerOrders = await Order.countDocuments({
      clientId: referrerId,
      status: OrderStatus.DELIVERED,
    });
    if (referrerOrders === 0) {
      // Quien nunca ha pedido nada no está recomendando ZIPP: está
      // fabricando cuentas.
      return 'Quien invita nunca ha completado un pedido';
    }

    return null;
  }

  /**
   * Paga la recompensa cuando el invitado completa su primera compra.
   *
   * Es el único momento en que la invitación vale algo de verdad: hay un
   * pedido entregado y cobrado detrás. Idempotente por `referralRewardedAt`.
   */
  async rewardIfFirstOrder(order: { clientId: unknown; _id: unknown }): Promise<boolean> {
    const invitee = (await User.findById(order.clientId).select(
      'referredBy referralRewardedAt'
    )) as IUser | null;

    if (!invitee?.referredBy || invitee.referralRewardedAt) return false;

    const delivered = await Order.countDocuments({
      clientId: order.clientId,
      status: OrderStatus.DELIVERED,
    });
    if (delivered !== 1) return false;

    const referrerId = invitee.referredBy.toString();
    const reason = await this.abuseReason(referrerId, String(order.clientId));

    if (reason) {
      // No se paga, pero se deja constancia: una invitación bloqueada en
      // silencio es indistinguible de una que nadie usó, y así no se puede
      // saber si el programa está siendo atacado.
      await antiFraudService.raiseAlertOnce({
        userId: referrerId,
        type: FraudAlertType.PROMOTION_ABUSE,
        riskLevel: RiskLevel.HIGH,
        riskScore: 70,
        description: `Invitación no premiada: ${reason}`,
        evidence: { inviteeId: String(order.clientId), orderId: String(order._id), reason },
      });

      await User.updateOne({ _id: order.clientId }, { $set: { referralRewardedAt: new Date() } });
      return false;
    }

    // Se marca antes de pagar: si el pago falla, es mejor una recompensa
    // perdida que una pagada dos veces.
    const claimed = await User.findOneAndUpdate(
      { _id: order.clientId, referralRewardedAt: null },
      { $set: { referralRewardedAt: new Date() } },
      { new: true }
    );
    if (!claimed) return false;

    const cfg = await pricingConfigService.getCurrent();
    if (!cfg.loyaltyEarnBps && !REFERRER_POINTS) return false;

    await Promise.all([
      loyaltyService.grantPoints(
        referrerId,
        REFERRER_POINTS,
        'Recompensa por invitar a un amigo'
      ),
      loyaltyService.grantPoints(
        String(order.clientId),
        INVITEE_POINTS,
        'Bienvenida por venir invitado'
      ),
    ]);

    return true;
  }

  /** Cuántas invitaciones lleva y cuántas se le premiaron. */
  async statsFor(userId: string) {
    const [total, rewarded, code] = await Promise.all([
      User.countDocuments({ referredBy: userId }),
      User.countDocuments({ referredBy: userId, referralRewardedAt: { $ne: null } }),
      this.codeFor(userId),
    ]);

    return { code, invited: total, rewarded, pointsPerReferral: REFERRER_POINTS };
  }
}

export const referralService = new ReferralService();
