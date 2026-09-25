import { Types } from 'mongoose';
import {
  CashReconciliation,
  ICashReconciliation,
  CASH_RECONCILIATION_TRANSITIONS,
  Driver,
  IOrder,
  Payment,
} from '../models';
import { AppError } from '../middlewares';
import { CashReconciliationStatus, PaymentStatus } from '../types';
import { ledgerService } from './ledger.service';
import { assertMoney } from '../utils';

/** How long a driver has to remit collected cash. */
const DEFAULT_DUE_HOURS = 24;

/**
 * Cash the driver collected on ZIPP's behalf.
 *
 * The one rule this service exists to enforce: **a driver cannot settle
 * their own debt.** The old flow let them flip a status to "paid" with no
 * money attached, which made the platform's only real revenue channel
 * self-declared. Here a driver may only *report* a remittance; moving to
 * VERIFIED requires either a gateway transaction the platform can
 * independently see, or a finance admin. SETTLED is reachable only from
 * VERIFIED.
 */
export class CashReconciliationService {
  /**
   * Opens the obligation when a cash order is delivered.
   *
   * The amount is the platform's share only — commission, service fee,
   * delivery margin and tax. The driver's own fee and the customer's tip
   * are never part of it, because that money is already theirs.
   */
  async open(order: IOrder, dueHours = DEFAULT_DUE_HOURS): Promise<ICashReconciliation> {
    const existing = await CashReconciliation.findOne({ orderId: order._id });
    if (existing) return existing;

    const f = order.finance;
    const amount =
      f.merchantCommission +
      f.customerServiceFee +
      Math.max(0, f.deliveryMargin) +
      f.taxPayable -
      f.platformPromotionExpense;

    const owed = Math.max(0, amount);
    assertMoney(owed, 'efectivo por rendir');

    const dueAt = new Date(Date.now() + dueHours * 3600_000);

    try {
      return await CashReconciliation.create({
        driverId: order.driverId,
        orderId: order._id,
        amount: owed,
        breakdown: {
          merchantCommission: f.merchantCommission,
          customerServiceFee: f.customerServiceFee,
          deliveryMargin: Math.max(0, f.deliveryMargin),
          taxPayable: f.taxPayable,
        },
        currency: f.currency,
        status: CashReconciliationStatus.PENDING,
        dueAt,
      });
    } catch (error: any) {
      if (error?.code === 11000) {
        const raced = await CashReconciliation.findOne({ orderId: order._id });
        if (raced) return raced;
      }
      throw error;
    }
  }

  private assertTransition(
    current: CashReconciliationStatus,
    next: CashReconciliationStatus
  ): void {
    const allowed = CASH_RECONCILIATION_TRANSITIONS[current] ?? [];
    if (!allowed.includes(next)) {
      throw new AppError(`Transición inválida: ${current} → ${next}`, 400);
    }
  }

  /**
   * A driver declares they deposited the money.
   *
   * This is the *only* status change a driver may make, and it settles
   * nothing: the balance stays outstanding until someone who is not the
   * debtor confirms it.
   */
  async report(
    userId: string,
    reconciliationIds: string[],
    reference: string
  ): Promise<{ reportedCount: number; totalReported: number }> {
    const driver = await Driver.findOne({ userId });
    if (!driver) throw new AppError('Domiciliario no encontrado', 404);

    if (!reference || reference.trim().length < 4) {
      throw new AppError(
        'Indica la referencia del depósito o transferencia (mínimo 4 caracteres)',
        400
      );
    }

    const filter: Record<string, unknown> = {
      driverId: driver._id,
      status: {
        $in: [CashReconciliationStatus.PENDING, CashReconciliationStatus.OVERDUE],
      },
    };
    if (reconciliationIds?.length) {
      filter._id = { $in: reconciliationIds.map((id) => new Types.ObjectId(id)) };
    }

    const pending = await CashReconciliation.find(filter);
    if (pending.length === 0) {
      throw new AppError('No tienes efectivo pendiente por reportar', 400);
    }

    for (const record of pending) {
      this.assertTransition(record.status, CashReconciliationStatus.REPORTED);
      record.status = CashReconciliationStatus.REPORTED;
      record.reportedAt = new Date();
      record.reportedReference = reference.trim();
      await record.save();
    }

    return {
      reportedCount: pending.length,
      totalReported: pending.reduce((sum, r) => sum + r.amount, 0),
    };
  }

  /**
   * Confirms a remittance against a payment the platform can actually see.
   *
   * Used by the automated path: the driver pays through the gateway, the
   * webhook lands, and the transaction — not the driver's word — moves the
   * record to VERIFIED.
   */
  async verifyByTransaction(
    reconciliationId: string,
    transactionId: string
  ): Promise<ICashReconciliation> {
    const record = await CashReconciliation.findById(reconciliationId);
    if (!record) throw new AppError('Registro de conciliación no encontrado', 404);

    const payment = await Payment.findOne({ transactionId });
    if (!payment || payment.status !== PaymentStatus.PAID) {
      throw new AppError(
        'No existe una transacción aprobada con esa referencia',
        422
      );
    }
    // ── Una transacción, un saldo (o varios, hasta agotarla) ──
    //
    // Comprobar solo `payment.amount >= record.amount` deja la puerta
    // abierta a aplicar el MISMO pago a cuantas conciliaciones se quiera:
    // una transferencia de $50.000 saldaba diez pedidos de $10.000 y ZIPP
    // daba por cobrados $100.000 que nunca entraron. Lo que hay que
    // comparar no es el saldo de este registro, sino todo lo que esa
    // transacción ya está respaldando.
    //
    // Permitir varias no es un descuido: un domiciliario rinde de una vez
    // el efectivo de la jornada, y una transferencia por varios pedidos es
    // el caso normal. Lo que no puede es cubrir más de lo que vale.
    const yaRespaldadas = await CashReconciliation.find({
      transactionId,
      _id: { $ne: record._id },
      status: {
        $in: [CashReconciliationStatus.VERIFIED, CashReconciliationStatus.SETTLED],
      },
    }).select('amount');

    const yaCubierto = yaRespaldadas.reduce((total, r) => total + r.amount, 0);

    if (payment.amount < yaCubierto + record.amount) {
      const disponible = Math.max(0, payment.amount - yaCubierto);
      throw new AppError(
        yaCubierto > 0
          ? `Esa transacción ya respalda $${yaCubierto.toLocaleString('es-CO')} de ` +
            `otras conciliaciones. Le quedan $${disponible.toLocaleString('es-CO')} ` +
            `disponibles y este saldo es de $${record.amount.toLocaleString('es-CO')}.`
          : `La transacción ($${payment.amount.toLocaleString('es-CO')}) no cubre ` +
            `el saldo ($${record.amount.toLocaleString('es-CO')})`,
        422
      );
    }

    this.assertTransition(record.status, CashReconciliationStatus.VERIFIED);
    record.status = CashReconciliationStatus.VERIFIED;
    record.verifiedAt = new Date();
    record.verificationMethod = 'gateway_transaction';
    record.transactionId = transactionId;
    await record.save();

    return record;
  }

  /**
   * A finance admin confirms a remittance manually (cash deposited at the
   * office, bank transfer seen on a statement, etc.).
   */
  async verifyByAdmin(
    reconciliationIds: string[],
    adminUserId: string,
    reference: string,
    receiptUrl: string,
    amount: number
  ): Promise<{ verifiedCount: number; totalVerified: number }> {
    // Verificar efectivo sin consignación real y sin comprobante es lo mismo
    // que darle crédito a la palabra del domiciliario, que es exactamente lo
    // que este servicio existe para no hacer.
    if (!reference || reference.trim().length < 4) {
      throw new AppError('Indica la referencia de la consignación (mínimo 4 caracteres)', 400);
    }
    if (!receiptUrl || !receiptUrl.trim()) {
      throw new AppError('Adjunta el comprobante de la consignación', 400);
    }
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new AppError('Indica el monto que de verdad consignó, en pesos enteros', 400);
    }

    const normalizedReference = reference.trim().slice(0, 200);
    const ids = reconciliationIds.map((id) => new Types.ObjectId(id));

    const records = await CashReconciliation.find({ _id: { $in: ids } });
    if (records.length !== ids.length) {
      throw new AppError('Alguno de los registros no existe', 404);
    }

    const eligible = [
      CashReconciliationStatus.PENDING,
      CashReconciliationStatus.REPORTED,
      CashReconciliationStatus.OVERDUE,
    ];
    const ineligible = records.filter((r) => !eligible.includes(r.status));
    if (ineligible.length > 0) {
      throw new AppError(
        'Alguno de los registros ya está verificado o liquidado; no se puede verificar dos veces',
        409
      );
    }

    const total = records.reduce((sum, r) => sum + r.amount, 0);
    if (total !== amount) {
      throw new AppError(
        `El monto no coincide con lo pendiente: la suma de los registros seleccionados es ` +
          `$${total.toLocaleString('es-CO')}`,
        422
      );
    }

    // Una consignación es una transacción única: la misma referencia no
    // puede respaldar dos verificaciones distintas, o un solo depósito
    // bancario terminaría cubriendo dos rendiciones de efectivo diferentes.
    const reused = await CashReconciliation.findOne({
      _id: { $nin: ids },
      verificationMethod: 'admin_confirmation',
      reportedReference: normalizedReference,
    });
    if (reused) {
      throw new AppError(
        'Esa referencia de consignación ya se usó para verificar otro lote de efectivo',
        409
      );
    }

    // Atómico y condicionado al estado, no `find` → validar → `save()`: si
    // alguno de estos registros cambió de estado entre la lectura de arriba
    // y este `updateMany` (otra verificación, una liquidación concurrente),
    // ese documento no matchea el filtro y `modifiedCount` queda corto —
    // nunca hay una verificación a medias ni una doble verificación.
    const result = await CashReconciliation.updateMany(
      { _id: { $in: ids }, status: { $in: eligible } },
      {
        $set: {
          status: CashReconciliationStatus.VERIFIED,
          verifiedAt: new Date(),
          verifiedBy: new Types.ObjectId(adminUserId),
          verificationMethod: 'admin_confirmation',
          reportedReference: normalizedReference,
          receiptUrl: receiptUrl.trim(),
        },
      }
    );

    if (result.modifiedCount !== ids.length) {
      throw new AppError(
        'Alguno de los registros cambió de estado justo antes de verificar. Vuelve a intentarlo.',
        409
      );
    }

    return { verifiedCount: result.modifiedCount, totalVerified: total };
  }

  /**
   * Closes verified remittances and posts them to the ledger.
   *
   * Only reachable from VERIFIED, so no path exists from "the driver said
   * so" to "the books say it is paid".
   */
  async settle(
    reconciliationIds: string[],
    adminUserId: string
  ): Promise<{ settledCount: number; totalSettled: number }> {
    const records = await CashReconciliation.find({
      _id: { $in: reconciliationIds.map((id) => new Types.ObjectId(id)) },
      status: CashReconciliationStatus.VERIFIED,
    }).populate<{ orderId: IOrder }>('orderId');

    if (records.length === 0) {
      throw new AppError(
        'No hay registros verificados para liquidar. Verifícalos primero.',
        400
      );
    }

    let totalSettled = 0;

    for (const record of records) {
      const order = record.orderId as unknown as IOrder;

      // Transición atómica: la condición `status: VERIFIED` va en el filtro,
      // no en un `if` después de leer. Dos liquidaciones concurrentes sobre
      // el mismo registro solo dejan pasar a una; la otra ve `null` aquí y
      // se salta sin volver a postear el asiento.
      const claimed = await CashReconciliation.findOneAndUpdate(
        { _id: record._id, status: CashReconciliationStatus.VERIFIED },
        {
          $set: {
            status: CashReconciliationStatus.SETTLED,
            settledAt: new Date(),
            ...(record.verifiedBy ? {} : { verifiedBy: new Types.ObjectId(adminUserId) }),
          },
        },
        { new: true }
      );
      if (!claimed) continue;

      await ledgerService.recordCashSettled({
        orderId: order._id,
        amount: record.amount,
        pricingConfigVersion: order.finance?.pricingConfigVersion ?? 0,
        driverId: record.driverId,
        reference: record.transactionId ?? record.reportedReference ?? String(record._id),
        currency: record.currency,
      });

      totalSettled += record.amount;
    }

    return { settledCount: records.length, totalSettled };
  }

  /** Voids the obligation when the order is cancelled or fully refunded. */
  async void(orderId: string | Types.ObjectId): Promise<void> {
    const record = await CashReconciliation.findOne({ orderId });
    if (!record) return;
    if (record.status === CashReconciliationStatus.SETTLED) return;

    record.voidedAt = new Date();
    record.amount = 0;
    record.status = CashReconciliationStatus.VERIFIED;
    await record.save();
  }

  /** Flags overdue balances. Intended for a scheduled job. */
  async markOverdue(): Promise<number> {
    const result = await CashReconciliation.updateMany(
      {
        status: CashReconciliationStatus.PENDING,
        dueAt: { $lt: new Date() },
      },
      { $set: { status: CashReconciliationStatus.OVERDUE } }
    );
    return result.modifiedCount ?? 0;
  }

  /**
   * Efectivo de ZIPP que un domiciliario tiene sin rendir, por `Driver._id`.
   *
   * Misma definición que `forDriver` —lo pendiente es lo que nadie ha
   * verificado todavía, incluido lo que el domiciliario dice haber
   * consignado— pero partiendo del identificador que tiene a mano quien
   * asigna un pedido, que no conoce el `userId`.
   *
   * Es una lectura, no un sistema de saldo nuevo: la deuda sigue siendo la
   * suma de las conciliaciones de siempre.
   */
  async outstandingFor(driverId: string | Types.ObjectId): Promise<number> {
    const records = await CashReconciliation.find({
      driverId,
      status: {
        $in: [
          CashReconciliationStatus.PENDING,
          CashReconciliationStatus.REPORTED,
          CashReconciliationStatus.OVERDUE,
        ],
      },
    }).select('amount');

    return records.reduce((sum, record) => sum + record.amount, 0);
  }

  async forDriver(userId: string) {
    const driver = await Driver.findOne({ userId });
    if (!driver) throw new AppError('Domiciliario no encontrado', 404);

    const records = await CashReconciliation.find({
      driverId: driver._id,
      status: { $ne: CashReconciliationStatus.SETTLED },
    })
      .populate('orderId', 'orderNumber total createdAt')
      .sort({ dueAt: 1 });

    const outstanding = records
      .filter((r) => r.status !== CashReconciliationStatus.VERIFIED)
      .reduce((sum, r) => sum + r.amount, 0);

    const reported = records
      .filter((r) => r.status === CashReconciliationStatus.REPORTED)
      .reduce((sum, r) => sum + r.amount, 0);

    const overdue = records
      .filter((r) => r.status === CashReconciliationStatus.OVERDUE)
      .reduce((sum, r) => sum + r.amount, 0);

    return { outstanding, reported, overdue, records };
  }

  async list(status?: string, page = 1, limit = 20) {
    const filter: Record<string, unknown> = {};
    if (status) filter.status = status;

    const skip = (page - 1) * limit;
    const [records, total] = await Promise.all([
      CashReconciliation.find(filter)
        .skip(skip)
        .limit(limit)
        .sort({ dueAt: 1 })
        .populate({ path: 'driverId', populate: { path: 'userId', select: 'name phone' } })
        .populate('orderId', 'orderNumber total'),
      CashReconciliation.countDocuments(filter),
    ]);

    return { records, meta: { page, limit, total, totalPages: Math.ceil(total / limit) } };
  }

  /**
   * Totales por estado, calculados en el servidor sobre TODA la colección.
   *
   * El panel sumaba en el navegador lo que había en la página cargada, así
   * que "liquidado hoy" solo contaba los 20 registros visibles. Esta
   * agregación no pagina: es la única fuente confiable para un total.
   */
  async totals(): Promise<Record<string, { count: number; amount: number }>> {
    const rows = await CashReconciliation.aggregate([
      { $group: { _id: '$status', count: { $sum: 1 }, amount: { $sum: '$amount' } } },
    ]);
    const byStatus: Record<string, { count: number; amount: number }> = {};
    for (const row of rows) {
      byStatus[row._id] = { count: row.count, amount: row.amount };
    }
    return byStatus;
  }

  /**
   * Lo que cada domiciliario tiene sin rendir (pendiente, reportado o
   * vencido), de mayor deuda a menor: la pantalla de Efectivo empieza por
   * "a quién le tengo que cobrar", no por una lista de pedidos.
   * `reported` ya lo declaró el domiciliario pero nadie lo ha verificado.
   */
  async outstandingByDriver() {
    const open = [CashReconciliationStatus.PENDING, CashReconciliationStatus.REPORTED, CashReconciliationStatus.OVERDUE];
    const now = new Date();
    const rows = await CashReconciliation.aggregate([
      { $match: { status: { $in: open } } },
      {
        $group: {
          _id: '$driverId',
          count: { $sum: 1 },
          amount: { $sum: '$amount' },
          reportedAmount: { $sum: { $cond: [{ $eq: ['$status', CashReconciliationStatus.REPORTED] }, '$amount', 0] } },
          overdueCount: { $sum: { $cond: [{ $or: [{ $eq: ['$status', CashReconciliationStatus.OVERDUE] }, { $lt: ['$dueAt', now] }] }, 1, 0] } },
          overdueAmount: { $sum: { $cond: [{ $or: [{ $eq: ['$status', CashReconciliationStatus.OVERDUE] }, { $lt: ['$dueAt', now] }] }, '$amount', 0] } },
          oldestDueAt: { $min: '$dueAt' },
        },
      },
      { $sort: { amount: -1 } },
      { $limit: 200 },
    ]);

    const drivers = await Driver.find({ _id: { $in: rows.map((r) => r._id) } })
      .select('userId')
      .populate('userId', 'name')
      .lean();
    const nameOf = new Map(drivers.map((d: any) => [String(d._id), (d.userId?.name as string) ?? null]));

    return rows.map((r) => ({
      driverId: String(r._id),
      name: nameOf.get(String(r._id)) ?? null,
      count: r.count as number,
      amount: r.amount as number,
      reportedAmount: r.reportedAmount as number,
      overdueCount: r.overdueCount as number,
      overdueAmount: r.overdueAmount as number,
      oldestDueAt: r.oldestDueAt as Date,
    }));
  }
}

export const cashReconciliationService = new CashReconciliationService();

// ── Barrido de vencidos ──────────────────────────────────────────────
//
// `markOverdue()` existía pero nadie la llamaba: un saldo PENDING se
// quedaba PENDING para siempre aunque llevara semanas vencido. Un
// `setInterval` de proceso —no un cron externo— porque PM2 corre esta app
// en una sola instancia `fork`; dos instancias duplicarían el barrido pero
// `updateMany` es idempotente, así que tampoco sería grave.
let overdueSweepTimer: ReturnType<typeof setInterval> | null = null;

export function startCashOverdueSweeper(intervalMs = 15 * 60_000): void {
  if (overdueSweepTimer) return;
  overdueSweepTimer = setInterval(() => {
    cashReconciliationService.markOverdue().catch((error) => {
      console.error('[cash-overdue-sweep]', error);
    });
  }, intervalMs);
  overdueSweepTimer.unref?.();
}

export function stopCashOverdueSweeper(): void {
  if (overdueSweepTimer) {
    clearInterval(overdueSweepTimer);
    overdueSweepTimer = null;
  }
}
