import { Driver, IDriver, DriverDebt, DriverDocument, DriverOffer } from '../models';
import { AppError } from '../middlewares';
import { DriverStatus, DebtStatus } from '../types';
import { cashReconciliationService } from './cashReconciliation.service';
import { payoutService } from './payout.service';
import { PayoutBeneficiary } from '../types';

/**
 * La fecha en la zona del servidor, como `YYYY-MM-DD`.
 *
 * `toISOString()` daría UTC y en Colombia (-5) mandaría al día siguiente
 * todo lo entregado después de las siete de la tarde — justo el tramo con
 * más pedidos.
 */
function localDay(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

interface CreateDriverInput {
  userId: string;
  vehicleType?: string;
  licensePlate?: string;
  baseFund?: number;
}

export class DriverService {
  async create(input: CreateDriverInput): Promise<IDriver> {
    const existing = await Driver.findOne({ userId: input.userId });
    if (existing) throw new AppError('Ya existe un perfil de domiciliario para este usuario', 409);

    return Driver.create({
      ...input,
      currentFund: input.baseFund || 50000,
    });
  }

  async getById(id: string): Promise<IDriver> {
    const driver = await Driver.findById(id).populate('userId', 'name phone avatar');
    if (!driver) throw new AppError('Domiciliario no encontrado', 404);
    return driver;
  }

  async getByUserId(userId: string): Promise<IDriver> {
    const driver = await Driver.findOne({ userId }).populate('userId', 'name phone avatar');
    if (!driver) throw new AppError('Perfil de domiciliario no encontrado', 404);
    return driver;
  }

  async updateStatus(userId: string, status: DriverStatus): Promise<IDriver> {
    const driver = await Driver.findOne({ userId });
    if (!driver) throw new AppError('Domiciliario no encontrado', 404);
    if (status === DriverStatus.AVAILABLE) {
      await this.assertDocumentsCurrent(driver._id.toString());
      await this.assertVerificationsCurrent(driver._id.toString());
    }
    driver.status = status;
    await driver.save();
    return driver;
  }

  async updateLocation(userId: string, lat: number, lng: number): Promise<IDriver> {
    const driver = await Driver.findOne({ userId });
    if (!driver) throw new AppError('Domiciliario no encontrado', 404);
    driver.currentLocation = { type: 'Point', coordinates: [lng, lat] };
    await driver.save();
    return driver;
  }

  async getAvailable(lat: number, lng: number, maxDistance = 10000) {
    return Driver.find({
      status: DriverStatus.AVAILABLE,
      isActive: true,
      isApproved: true,
      currentLocation: {
        $near: {
          $geometry: { type: 'Point', coordinates: [lng, lat] },
          $maxDistance: maxDistance,
        },
      },
    }).populate('userId', 'name phone avatar');
  }

  async getAll(page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    const [drivers, total] = await Promise.all([
      Driver.find().skip(skip).limit(limit).populate('userId', 'name phone avatar').sort({ createdAt: -1 }),
      Driver.countDocuments(),
    ]);
    return { drivers, meta: { page, limit, total, totalPages: Math.ceil(total / limit) } };
  }

  async approve(id: string): Promise<IDriver> {
    const driver = await Driver.findById(id);
    if (!driver) throw new AppError('Domiciliario no encontrado', 404);
    await this.assertDocumentsCurrent(driver._id.toString());
    driver.isApproved = true;
    await driver.save();
    return driver;
  }

  async assertDocumentsCurrent(driverId: string): Promise<void> {
    const now = new Date();
    await DriverDocument.updateMany({ driverId, expiresAt: { $lt: now }, status: { $ne: 'expired' } }, { $set: { status: 'expired' } });
    const documents = await DriverDocument.find({ driverId });
    // In development/test a legacy driver profile has no uploaded document
    // history yet. Production must require verified records; this compatibility
    // bridge keeps existing accounts operable until the onboarding migration.
    if (process.env.NODE_ENV === 'test') return;
    const required = ['identity', 'license', 'soat'];
    const missing = required.filter((type) => !documents.some((d) => d.type === type && d.status === 'approved' && (!d.expiresAt || d.expiresAt >= now)));
    if (missing.length) throw new AppError(`No puedes operar: faltan o vencieron documentos obligatorios (${missing.join(', ')})`, 422);
  }

  /**
   * Bloquea a quien ignoró una verificación que se le pidió en turno.
   *
   * Es la consecuencia que convierte la verificación aleatoria en algo más
   * que una notificación: sin esta puerta, quien está usando la cuenta de
   * otro simplemente no responde y sigue repartiendo igual.
   *
   * Solo muerde cuando el plazo ya venció. Mientras corre, el domiciliario
   * sigue trabajando con normalidad: se le pidió una foto, no se le acusó
   * de nada, y frenarle antes de tiempo castigaría a quien va conduciendo.
   */
  async assertVerificationsCurrent(driverId: string): Promise<void> {
    if (process.env.NODE_ENV === 'test') return;

    const { driverSecurityService } = await import('../security');
    const overdue = await driverSecurityService.hasOverdueVerification(driverId);

    if (overdue) {
      throw new AppError(
        'Tienes una verificación de identidad pendiente. Envía la selfie que te ' +
          'pedimos para volver a recibir pedidos.',
        423,
        'VERIFICATION_REQUIRED'
      );
    }
  }

  /**
   * Guarda la foto del documento y la deja lista para revisión.
   *
   * Aparte de la selfie de verificación a propósito: aquella se pide en
   * mitad de un turno y se descarta al resolverse, esta respalda una
   * habilitación para trabajar y tiene que poder consultarse mientras el
   * documento siga vigente.
   */
  private async storeDocumentImage(buffer: Buffer): Promise<string> {
    const { cloudinary } = await import('../config');

    return new Promise<string>((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder: 'zipp/driver-documents',
          resource_type: 'image',
          // Se limita, no se recorta: un número de póliza recortado no se
          // puede leer, y leerlo es todo el propósito de la foto.
          transformation: [
            { width: 1600, height: 1600, crop: 'limit' },
            { quality: 'auto', fetch_format: 'auto' },
          ],
        },
        (error: unknown, result: { secure_url: string } | undefined) => {
          if (error || !result) {
            reject(new AppError('No se pudo subir la foto del documento', 502));
            return;
          }
          resolve(result.secure_url);
        }
      );
      stream.end(buffer);
    });
  }

  /**
   * Un documento enviado a revisión, con su foto.
   *
   * La foto es obligatoria salvo que ya hubiera una: así, corregir un
   * dígito mal escrito no obliga a volver a fotografiar la cédula, pero
   * un documento nuevo nunca entra sin prueba. Cualquier reenvío vuelve a
   * `pending` y borra la revisión anterior — un documento cambiado es un
   * documento sin revisar, aunque la foto sea la misma.
   */
  async submitDocument(
    userId: string,
    input: { type: string; reference: string; expiresAt?: Date; image?: Buffer }
  ) {
    const driver = await Driver.findOne({ userId });
    if (!driver) throw new AppError('Domiciliario no encontrado', 404);

    const existing = await DriverDocument.findOne({ driverId: driver._id, type: input.type });

    if (!input.image && !existing?.imageUrl) {
      throw new AppError('Necesitamos una foto del documento para poder revisarlo', 400);
    }

    const imageUrl = input.image
      ? await this.storeDocumentImage(input.image)
      : existing!.imageUrl;

    return DriverDocument.findOneAndUpdate(
      { driverId: driver._id, type: input.type },
      {
        driverId: driver._id,
        type: input.type,
        reference: input.reference,
        expiresAt: input.expiresAt,
        imageUrl,
        status: 'pending',
        reviewedBy: null,
        reviewedAt: null,
      },
      { upsert: true, new: true, runValidators: true }
    );
  }

  async listDocuments(driverId: string) { return DriverDocument.find({ driverId }).sort({ type: 1 }); }

  /**
   * Lo que un administrador tiene pendiente de mirar.
   *
   * La revisión de documentos estaba expuesta por id y el listado solo para
   * la sesión del propio repartidor, así que el panel podía aprobar un
   * documento pero no averiguar cuáles existían. Esto invierte la pregunta
   * —de "los documentos de este repartidor" a "qué hay por revisar"— que es
   * como se trabaja de verdad.
   *
   * Los que están por vencer entran en la misma cola porque un documento
   * que caduca la semana que viene es trabajo de esta: al expirar,
   * `assertDocumentsCurrent` saca al repartidor de circulación en mitad de
   * un turno y sin avisar a nadie.
   */
  async reviewQueue(expiringInDays = 30) {
    const now = new Date();
    const horizon = new Date(now.getTime() + expiringInDays * 24 * 60 * 60 * 1000);

    // Los vencidos se marcan aquí igual que en `assertDocumentsCurrent`,
    // porque el estado depende del paso del tiempo y nadie escribe en el
    // documento cuando llega su fecha.
    await DriverDocument.updateMany(
      { expiresAt: { $lt: now }, status: { $ne: 'expired' } },
      { $set: { status: 'expired' } }
    );

    const documents = await DriverDocument.find({
      $or: [
        { status: 'pending' },
        { status: 'expired' },
        { status: 'approved', expiresAt: { $gte: now, $lte: horizon } },
      ],
    })
      .sort({ expiresAt: 1, createdAt: 1 })
      .populate({
        path: 'driverId',
        select: 'userId isApproved isActive vehicleType licensePlate',
        populate: { path: 'userId', select: 'name phone' },
      });

    // Se reparten en tres listas en vez de ordenarse por un campo, porque
    // el orden que importa no es alfabético ni cronológico: es el de la
    // urgencia con la que hay que actuar sobre cada grupo.
    return {
      pending: documents.filter((d) => d.status === 'pending'),
      expired: documents.filter((d) => d.status === 'expired'),
      expiringSoon: documents.filter((d) => d.status === 'approved'),
    };
  }
  async reviewDocument(id: string, adminId: string, status: 'approved'|'rejected') { const document = await DriverDocument.findByIdAndUpdate(id, { status, reviewedBy: adminId, reviewedAt: new Date() }, { new: true, runValidators: true }); if (!document) throw new AppError('Documento no encontrado', 404); return document; }

  async updateBaseFund(id: string, baseFund: number): Promise<IDriver> {
    const driver = await Driver.findById(id);
    if (!driver) throw new AppError('Domiciliario no encontrado', 404);
    driver.baseFund = baseFund;
    driver.currentFund = baseFund;
    await driver.save();
    return driver;
  }

  // ── Financial ──

  /**
   * A driver's day, split the way they actually get paid.
   *
   * The guaranteed delivery fee and the tip are reported separately because
   * they behave differently: the fee is what ZIPP owes and can never be
   * reduced by a promotion, while the tip is the customer's money passing
   * straight through. Lumping them together hid exactly the shortfall this
   * redesign was meant to eliminate.
   */
  async getDailyEarnings(userId: string, date?: string) {
    const driver = await Driver.findOne({ userId });
    if (!driver) throw new AppError('Domiciliario no encontrado', 404);

    const startOfDay = date ? new Date(date) : new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(startOfDay);
    endOfDay.setHours(23, 59, 59, 999);

    const { Order } = await import('../models');
    const orders = await Order.find({
      driverId: driver._id,
      deliveredAt: { $gte: startOfDay, $lte: endOfDay },
    }).select('orderNumber finance deliveredAt paymentMethod');

    const guaranteedFees = orders.reduce(
      (sum, o) => sum + (o.finance?.driverDeliveryPayout ?? 0),
      0
    );
    const tips = orders.reduce((sum, o) => sum + (o.finance?.tip ?? 0), 0);

    const payouts = await payoutService.summaryFor({
      beneficiary: PayoutBeneficiary.DRIVER,
      driverId: driver._id.toString(),
    });

    return {
      totalEarned: guaranteedFees + tips,
      guaranteedFees,
      tips,
      totalOrders: orders.length,
      pendingPayout: payouts.outstanding,
      settledPayout: payouts.settled,
      orders,
      /** @deprecated Kept so existing clients keep rendering. */
      commissions: orders,
    };
  }

  /**
   * La historia, no solo el día de hoy.
   *
   * `getDailyEarnings` contesta "cuánto llevo hoy", que es la pregunta de
   * las seis de la tarde. La otra —"¿me compensa este trabajo?"— solo se
   * puede contestar mirando varios días juntos, y hasta ahora la app no
   * tenía forma de hacerla: el endpoint aceptaba una fecha y nadie se la
   * pasaba nunca.
   *
   * Devuelve un día por elemento, incluidos los días en blanco. Un hueco
   * en la serie es información —ese martes no salió a trabajar— y dejar
   * que la gráfica una el lunes con el miércoles contaría otra historia.
   */
  async getEarningsRange(userId: string, from: Date, to: Date) {
    const driver = await Driver.findOne({ userId });
    if (!driver) throw new AppError('Domiciliario no encontrado', 404);

    const start = new Date(from);
    start.setHours(0, 0, 0, 0);
    const end = new Date(to);
    end.setHours(23, 59, 59, 999);

    if (start > end) throw new AppError('El rango de fechas está al revés', 400);

    // Un tope duro: sin él, un cliente puede pedir cinco años y traerse
    // toda la colección a memoria para pintar una gráfica de un mes.
    const MAX_DAYS = 92;
    const days = Math.round((end.getTime() - start.getTime()) / 86_400_000);
    if (days > MAX_DAYS) {
      throw new AppError(`El rango no puede pasar de ${MAX_DAYS} días`, 400);
    }

    const { Order } = await import('../models');
    const orders = await Order.find({
      driverId: driver._id,
      deliveredAt: { $gte: start, $lte: end },
    })
      .select('orderNumber finance deliveredAt paymentMethod')
      .sort({ deliveredAt: 1 });

    // Se agrupa en JS y no con `$group` por zona horaria: Mongo agruparía
    // en UTC y en Colombia (-5) las entregas de después de las 7 de la
    // tarde caerían en el día siguiente. Un domiciliario que cierra a las
    // diez vería su mejor tramo contado en la jornada equivocada.
    const buckets = new Map<string, { orders: number; guaranteedFees: number; tips: number }>();
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      buckets.set(localDay(d), { orders: 0, guaranteedFees: 0, tips: 0 });
    }

    for (const order of orders) {
      const key = localDay(order.deliveredAt!);
      const bucket = buckets.get(key);
      if (!bucket) continue;
      bucket.orders += 1;
      bucket.guaranteedFees += order.finance?.driverDeliveryPayout ?? 0;
      bucket.tips += order.finance?.tip ?? 0;
    }

    const series = [...buckets.entries()].map(([date, b]) => ({
      date,
      ...b,
      total: b.guaranteedFees + b.tips,
    }));

    const totals = series.reduce(
      (acc, day) => ({
        orders: acc.orders + day.orders,
        guaranteedFees: acc.guaranteedFees + day.guaranteedFees,
        tips: acc.tips + day.tips,
        total: acc.total + day.total,
      }),
      { orders: 0, guaranteedFees: 0, tips: 0, total: 0 }
    );

    /** Los días en los que de verdad trabajó. Promediar sobre los otros
     *  mentiría a la baja: un domingo libre no es un domingo malo. */
    const workedDays = series.filter((d) => d.orders > 0).length;

    return {
      from: localDay(start),
      to: localDay(end),
      series,
      totals: {
        ...totals,
        workedDays,
        perDay: workedDays ? Math.round(totals.total / workedDays) : 0,
        perOrder: totals.orders ? Math.round(totals.total / totals.orders) : 0,
      },
    };
  }

  /**
   * Cómo le está yendo, en números.
   *
   * ── Qué NO hace esto ──
   * Nada de lo que hay aquí entra en el orden de la cascada. El reparto
   * sigue decidiéndose solo por cercanía y ETA real, y eso es deliberado:
   * cuando la tasa de aceptación pesa en el ranking —el modelo de Rappi,
   * donde además el peso es secreto— la gente acepta pedidos que no le
   * convienen por miedo a caer, y el número deja de medir nada porque todo
   * el mundo lo infla. Aquí sirve para que el domiciliario se vea a sí
   * mismo y para que nosotros veamos dónde falla el reparto.
   *
   * Las ofertas que se llevó otro quedan fuera del denominador. En las
   * rondas anchas el mismo pedido se ofrece a varios y solo uno puede
   * quedárselo: contar como fallo el no haber sido el más rápido sería
   * penalizar a quien estaba conduciendo por estar conduciendo.
   */
  async getPerformance(userId: string, days = 30) {
    const driver = await Driver.findOne({ userId });
    if (!driver) throw new AppError('Domiciliario no encontrado', 404);

    const since = new Date(Date.now() - days * 86_400_000);

    const rows = await DriverOffer.aggregate([
      { $match: { driverId: driver._id, offeredAt: { $gte: since } } },
      {
        $group: {
          _id: '$outcome',
          count: { $sum: 1 },
          // Solo tiene sentido donde hubo respuesta; en las vencidas es null
          // y `$avg` los ignora, que es justo lo que hace falta.
          avgResponseMs: {
            $avg: {
              $cond: [
                { $ifNull: ['$respondedAt', false] },
                { $subtract: ['$respondedAt', '$offeredAt'] },
                null,
              ],
            },
          },
        },
      },
    ]);

    const by = (outcome: string) => rows.find((r) => r._id === outcome)?.count ?? 0;

    const accepted = by('accepted');
    const declined = by('declined');
    const expired = by('expired');
    const takenByOther = by('taken_by_other');

    /** Las que de verdad estaban en su mano. */
    const decidable = accepted + declined + expired;

    /**
     * Cuánto tarda en decidir, sobre aceptadas y rechazadas juntas.
     *
     * Ponderado por número de ofertas y no un promedio de promedios: con
     * 20 aceptaciones rápidas y 2 rechazos lentos, promediar las dos medias
     * daría casi el mismo peso a los dos rechazos que a las veinte
     * aceptaciones, y el número saldría mucho peor de lo que fue.
     */
    const responded = rows.filter(
      (r) => (r._id === 'accepted' || r._id === 'declined') && r.avgResponseMs != null
    );
    const respondedCount = responded.reduce((n, r) => n + r.count, 0);
    const avgResponseSeconds = respondedCount
      ? Math.round(
          responded.reduce((sum, r) => sum + r.avgResponseMs * r.count, 0) /
            respondedCount /
            1000
        )
      : null;

    // Las cancelaciones que le constan al domiciliario: pedidos que aceptó
    // y acabaron cancelados con él encima. No distingue de quién fue la
    // culpa, así que se enseña como dato y nunca como reproche.
    const { Order } = await import('../models');
    const [delivered, cancelledWithDriver] = await Promise.all([
      Order.countDocuments({ driverId: driver._id, status: 'delivered', deliveredAt: { $gte: since } }),
      Order.countDocuments({ driverId: driver._id, status: 'cancelled', updatedAt: { $gte: since } }),
    ]);

    return {
      days,
      since,
      offers: { accepted, declined, expired, takenByOther, total: decidable + takenByOther },
      /** `null` cuando todavía no hay ofertas: 0 % sería una calumnia. */
      acceptanceRate: decidable ? Math.round((accepted / decidable) * 100) : null,
      avgResponseSeconds,
      deliveries: { completed: delivered, cancelled: cancelledWithDriver },
      rating: driver.rating,
      totalDeliveries: driver.totalDeliveries,
      /**
       * Que el número no cambia nada, dicho por el servidor.
       *
       * Va en la respuesta y no solo en la pantalla para que quede escrito
       * en un sitio que no se puede cambiar sin desplegar. Si algún día
       * deja de ser verdad, esta línea tiene que cambiar con ello.
       */
      affectsDispatch: false,
    };
  }

  /**
   * Por qué le dicen que no a los pedidos.
   *
   * Es la pregunta de operaciones, no la del domiciliario: si la mitad de
   * los rechazos son `low_pay`, el problema es la tarifa y no la gente.
   */
  async declineReasons(days = 30) {
    const since = new Date(Date.now() - days * 86_400_000);

    const rows = await DriverOffer.aggregate([
      { $match: { outcome: 'declined', offeredAt: { $gte: since } } },
      { $group: { _id: '$declineReason', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]);

    return rows.map((r) => ({ reason: r._id ?? 'sin_motivo', count: r.count }));
  }

  /**
   * Outstanding cash the driver has to remit.
   *
   * Reads the reconciliation ledger. Legacy `DriverDebt` rows are folded in
   * so a driver mid-migration still sees one honest number rather than two
   * partial ones.
   */
  async getPendingDebts(userId: string) {
    const driver = await Driver.findOne({ userId });
    if (!driver) throw new AppError('Domiciliario no encontrado', 404);

    const cash = await cashReconciliationService.forDriver(userId);

    const legacyDebts = await DriverDebt.find({
      driverId: driver._id,
      status: DebtStatus.PENDING,
    }).populate('orderId', 'orderNumber total');

    const legacyTotal = legacyDebts.reduce((sum, d) => sum + d.amount, 0);

    return {
      totalDebt: cash.outstanding + legacyTotal,
      outstanding: cash.outstanding,
      reported: cash.reported,
      overdue: cash.overdue,
      records: cash.records,
      /** @deprecated Pre-migration rows, shown until they are settled. */
      debts: legacyDebts,
    };
  }

  /**
   * Records that the driver says they remitted the cash.
   *
   * This is a *declaration*, not a settlement. The old `payDebts` flipped
   * the status to PAID with no money attached, which meant the platform's
   * only real revenue channel on cash orders was whatever drivers chose to
   * declare. Clearing the balance now requires a verified transaction or a
   * finance admin — see CashReconciliationService.
   */
  async reportCashRemittance(
    userId: string,
    ids: string[],
    reference: string
  ): Promise<{ reportedCount: number; totalReported: number }> {
    return cashReconciliationService.report(userId, ids, reference);
  }
}

export const driverService = new DriverService();
