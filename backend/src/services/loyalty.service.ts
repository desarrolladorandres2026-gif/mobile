import { Types } from 'mongoose';
import { LoyaltyMovement, LoyaltyBalance, LoyaltyMovementKind, Coupon, IOrder } from '../models';
import {
  LedgerAccount,
  LedgerDirection,
  LedgerEventType,
  CouponType,
  CouponFundedBy,
  CouponScope,
} from '../types';
import { ledgerService } from './ledger.service';
import { pricingConfigService } from './pricingConfig.service';
import { AppError } from '../middlewares/errorHandler';
import { applyBps } from '../utils';

/**
 * Puntos ZIPP.
 *
 * Antes eran ficción: `useUsual.ts` los derivaba del historial local del
 * teléfono, así que cambiaban de dispositivo a dispositivo y desaparecían
 * al reinstalar. Nadie los debía porque no existían en ninguna parte.
 *
 * Ahora sí existen, y por eso pasan por el libro mayor. Un punto emitido es
 * una promesa de descuento futuro: dinero que ZIPP debe. Contarlo solo como
 * un número en el perfil del cliente sería tener un pasivo sin registrar,
 * que es exactamente cómo un programa de fidelización se come un margen sin
 * que nadie lo vea venir.
 *
 * Un punto vale un peso al canjearlo. La equivalencia es deliberadamente
 * trivial: los programas donde "1000 puntos son 12.500 pesos" existen para
 * que el cliente no sepa cuánto tiene.
 */

/** Un punto, un peso. Ver el comentario de arriba. */
export const POINT_VALUE_COP = 1;

export class LoyaltyService {
  /** Saldo disponible. Sale del documento materializado, no de la suma. */
  async balanceOf(userId: string): Promise<number> {
    const account = await LoyaltyBalance.findOne({ userId }).lean();
    return account?.balance ?? 0;
  }

  /**
   * Recalcula el saldo desde el libro de movimientos.
   *
   * El libro es la verdad; el saldo es un derivado que existe para poder
   * debitarlo de forma atómica. Esta función es la que permite comprobar
   * que los dos coinciden —y repararlo si algún día no— sin tener que
   * confiar en que nunca se desincronizaron.
   */
  async recomputeBalance(userId: string): Promise<number> {
    const [row] = await LoyaltyMovement.aggregate([
      { $match: { userId: new Types.ObjectId(userId) } },
      { $group: { _id: null, points: { $sum: '$points' } } },
    ]);

    const balance = Math.max(0, row?.points ?? 0);
    await LoyaltyBalance.updateOne({ userId }, { $set: { balance } }, { upsert: true });
    return balance;
  }

  async historyOf(userId: string, limit = 50) {
    return LoyaltyMovement.find({ userId }).sort({ createdAt: -1 }).limit(limit).lean();
  }

  /**
   * Otorga los puntos de un pedido entregado.
   *
   * Idempotente por el índice único de `(orderId, kind: earned)`: el evento
   * de entrega puede llegar dos veces —una pasarela que reintenta, un
   * despliegue a mitad— y el cliente no puede cobrar dos veces por la misma
   * compra.
   */
  async earnForOrder(order: IOrder): Promise<number> {
    const cfg = await pricingConfigService.getCurrent();
    if (!cfg.loyaltyEarnBps) return 0;

    // Sobre el subtotal de productos, no sobre el total: no tiene sentido
    // premiar al cliente por lo que se paga el domicilio ni por el impuesto.
    const base = order.finance?.productSubtotal ?? order.subtotal;
    const points = Math.floor(applyBps(base, cfg.loyaltyEarnBps) / POINT_VALUE_COP);
    if (points <= 0) return 0;

    const expiresAt = cfg.loyaltyExpiryDays
      ? new Date(Date.now() + cfg.loyaltyExpiryDays * 24 * 60 * 60 * 1000)
      : null;

    try {
      await LoyaltyMovement.create({
        userId: order.clientId,
        kind: LoyaltyMovementKind.EARNED,
        points,
        orderId: order._id,
        description: `Puntos por el pedido ${order.orderNumber}`,
        expiresAt,
      });
    } catch (error: unknown) {
      // Ya se otorgaron. No es un fallo: es el índice haciendo su trabajo.
      if ((error as { code?: number }).code === 11000) return 0;
      throw error;
    }

    // El saldo sube después del movimiento y nunca antes: si el proceso se
    // cae en medio, es preferible un saldo que se queda corto —y que
    // `recomputeBalance` repara— a uno que promete puntos sin respaldo en
    // el libro.
    await LoyaltyBalance.updateOne(
      { userId: order.clientId },
      { $inc: { balance: points } },
      { upsert: true }
    );

    // El gasto se reconoce al prometer, no al pagar. Si se esperara al
    // canje, los meses de captación parecerían baratos y la factura
    // llegaría toda junta el día que la gente empezara a usar sus puntos.
    await ledgerService.post(
      {
        orderId: order._id,
        event: LedgerEventType.LOYALTY_EARNED,
        pricingConfigVersion: cfg.version,
        reference: `loyalty:${order._id}`,
      },
      [
        {
          account: LedgerAccount.PROMOTION_EXPENSE,
          direction: LedgerDirection.DEBIT,
          amount: points * POINT_VALUE_COP,
          memo: `Puntos otorgados por el pedido ${order.orderNumber}`,
        },
        {
          account: LedgerAccount.LOYALTY_PAYABLE,
          direction: LedgerDirection.CREDIT,
          amount: points * POINT_VALUE_COP,
          memo: 'Puntos pendientes de canje',
        },
      ]
    );

    return points;
  }

  /**
   * Otorga puntos que no vienen de una compra.
   *
   * Recompensas por invitar, compensaciones de soporte, ajustes. Va por su
   * propia puerta y no por `earnForOrder` porque no hay pedido detrás: sin
   * `orderId` el índice de idempotencia no aplica, y quien llame aquí es
   * responsable de no hacerlo dos veces.
   *
   * Contabiliza igual que los puntos de compra: sigue siendo un pasivo.
   */
  async grantPoints(userId: string, points: number, description: string): Promise<void> {
    if (!Number.isInteger(points) || points <= 0) return;

    await LoyaltyMovement.create({
      userId,
      kind: LoyaltyMovementKind.ADJUSTED,
      points,
      description,
    });

    await LoyaltyBalance.updateOne(
      { userId },
      { $inc: { balance: points } },
      { upsert: true }
    );

    const cfg = await pricingConfigService.getCurrent();

    // Se usa el id del usuario como referencia del asiento: no hay pedido
    // al que colgarlo, y el libro exige que cada grupo tenga uno.
    await ledgerService.post(
      {
        orderId: new Types.ObjectId(userId),
        event: LedgerEventType.LOYALTY_EARNED,
        pricingConfigVersion: cfg.version,
        reference: `loyalty:grant:${userId}:${Date.now()}`,
      },
      [
        {
          account: LedgerAccount.PROMOTION_EXPENSE,
          direction: LedgerDirection.DEBIT,
          amount: points * POINT_VALUE_COP,
          memo: description,
        },
        {
          account: LedgerAccount.LOYALTY_PAYABLE,
          direction: LedgerDirection.CREDIT,
          amount: points * POINT_VALUE_COP,
          memo: 'Puntos pendientes de canje',
        },
      ]
    );
  }

  /**
   * Cambia puntos por un cupón de descuento.
   *
   * Se genera un cupón en vez de aplicar el descuento directamente porque
   * toda la validación difícil —vigencia, pedido mínimo, límite por
   * usuario, presupuesto, margen— ya vive en `coupon.service.ts`. Escribir
   * una segunda vía de descuento sería escribir una segunda vía por la que
   * se escapa dinero.
   */
  async redeem(userId: string, points: number) {
    const cfg = await pricingConfigService.getCurrent();

    if (!Number.isInteger(points) || points <= 0) {
      throw new AppError('Indica cuántos puntos quieres canjear', 400);
    }
    if (points < cfg.loyaltyMinRedeem) {
      throw new AppError(
        `El canje mínimo es de ${cfg.loyaltyMinRedeem} puntos`,
        400,
        'LOYALTY_BELOW_MINIMUM'
      );
    }

    // ── Débito atómico ──
    //
    // La condición viaja dentro de la escritura, igual que en la reserva
    // del fondo del domiciliario y en el reclamo de un pedido. Leer el
    // saldo, decidir y escribir son tres pasos, y entre ellos cabe otro
    // canje: dos peticiones simultáneas leerían lo mismo, las dos pasarían
    // la comprobación y el cliente se llevaría dos cupones habiendo pagado
    // una vez.
    //
    // Se debita ANTES de crear el cupón. Si algo falla después, los puntos
    // se devuelven; al revés, un fallo dejaría un cupón regalado.
    const debited = await LoyaltyBalance.findOneAndUpdate(
      { userId, balance: { $gte: points } },
      { $inc: { balance: -points } },
      { new: true }
    );

    if (!debited) {
      const balance = await this.balanceOf(userId);
      throw new AppError(
        `Solo tienes ${balance} puntos disponibles`,
        400,
        'LOYALTY_INSUFFICIENT'
      );
    }

    const value = points * POINT_VALUE_COP;
    const code = `PTS${Date.now().toString(36).toUpperCase()}`;

    let coupon;
    try {
      coupon = await Coupon.create({
      code,
      title: `Canje de ${points} puntos`,
      description: `Descuento de $${value.toLocaleString('es-CO')} por tus puntos ZIPP`,
      type: CouponType.FIXED,
      scope: CouponScope.PRODUCT,
      fundedBy: CouponFundedBy.PLATFORM,
      value,
      // De un solo uso y solo para quien lo canjeó: un cupón de puntos que
      // circula por WhatsApp deja de ser un canje y pasa a ser un agujero,
      // porque quien lo usa no gastó ningún punto.
      usageLimit: 1,
      perUserLimit: 1,
      restrictedToUserId: userId,
      isPublic: false,
      validUntil: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      // Ya está provisionado al emitirse: no puede volver a gastar margen.
      campaignApproved: true,
      });

      await LoyaltyMovement.create({
        userId,
        kind: LoyaltyMovementKind.REDEEMED,
        points: -points,
        couponId: coupon._id,
        description: `Canje por cupón ${code}`,
      });
    } catch (error) {
      // El débito ya ocurrió: devolverlo es obligatorio. Sin esto, un fallo
      // creando el cupón le cobraría los puntos al cliente sin darle nada.
      await LoyaltyBalance.updateOne({ userId }, { $inc: { balance: points } });
      throw error;
    }

    // Se extingue el pasivo y se revierte la provisión: el gasto real lo
    // registrará el pedido cuando el cupón se aplique. Sin esta reversión,
    // el mismo descuento se contaría dos veces.
    await ledgerService.post(
      {
        orderId: coupon._id,
        event: LedgerEventType.LOYALTY_REDEEMED,
        pricingConfigVersion: cfg.version,
        reference: `loyalty:redeem:${coupon._id}`,
      },
      [
        {
          account: LedgerAccount.LOYALTY_PAYABLE,
          direction: LedgerDirection.DEBIT,
          amount: value,
          memo: `Canje de ${points} puntos`,
        },
        {
          account: LedgerAccount.PROMOTION_EXPENSE,
          direction: LedgerDirection.CREDIT,
          amount: value,
          memo: 'Provisión revertida: el gasto lo registra el pedido',
        },
      ]
    );

    return { coupon, points, value };
  }

  /**
   * Devuelve los puntos de un pedido que se reembolsó.
   *
   * Sin esto, reembolsar una compra le dejaría al cliente los puntos que
   * ganó con ella: el pedido se deshace y el premio se queda.
   */
  async reverseForOrder(order: IOrder): Promise<number> {
    const earned = await LoyaltyMovement.findOne({
      orderId: order._id,
      kind: LoyaltyMovementKind.EARNED,
    });

    if (!earned) return 0;

    const already = await LoyaltyMovement.findOne({
      orderId: order._id,
      kind: LoyaltyMovementKind.REVERSED,
    });
    if (already) return 0;

    await LoyaltyMovement.create({
      userId: order.clientId,
      kind: LoyaltyMovementKind.REVERSED,
      points: -earned.points,
      orderId: order._id,
      description: `Puntos revertidos del pedido ${order.orderNumber}`,
    });

    // El saldo puede haber bajado ya por otros canjes, así que se descuenta
    // solo lo que quede: dejarlo en negativo sería peor que perdonar la
    // diferencia, porque un saldo negativo bloquea al cliente para siempre
    // por un pedido que ZIPP le reembolsó.
    const account = await LoyaltyBalance.findOne({ userId: order.clientId });
    const deduct = Math.min(earned.points, account?.balance ?? 0);
    if (deduct > 0) {
      await LoyaltyBalance.updateOne(
        { userId: order.clientId },
        { $inc: { balance: -deduct } }
      );
    }

    return earned.points;
  }
}

export const loyaltyService = new LoyaltyService();
