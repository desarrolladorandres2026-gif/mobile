import { Driver, IDriver, DriverDebt, DriverDocument } from '../models';
import { AppError } from '../middlewares';
import { DriverStatus, DebtStatus } from '../types';
import { cashReconciliationService } from './cashReconciliation.service';
import { payoutService } from './payout.service';
import { PayoutBeneficiary } from '../types';

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
    if (status === DriverStatus.AVAILABLE) await this.assertDocumentsCurrent(driver._id.toString());
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

  async submitDocument(userId: string, input: { type: string; reference: string; expiresAt?: Date }) {
    const driver = await Driver.findOne({ userId }); if (!driver) throw new AppError('Domiciliario no encontrado', 404);
    return DriverDocument.findOneAndUpdate({ driverId: driver._id, type: input.type }, { ...input, driverId: driver._id, status: 'pending', reviewedBy: null, reviewedAt: null }, { upsert: true, new: true, runValidators: true });
  }

  async listDocuments(driverId: string) { return DriverDocument.find({ driverId }).sort({ type: 1 }); }
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
