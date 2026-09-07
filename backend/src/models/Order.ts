import mongoose, { Schema, Document, Types } from 'mongoose';
import { OrderStatus, PaymentMethod, PaymentStatus, GeoPoint, SelectedExtra } from '../types';
import { getNextSequence } from './Counter';

export interface IOrderItem {
  productId: Types.ObjectId;
  productName: string;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
  selectedExtras: SelectedExtra[];
  notes?: string;
}

/**
 * Immutable per-order financial snapshot.
 *
 * Persisted at creation from the quote and never recomputed. A later
 * pricing-config change produces a new `pricingConfigVersion` for new
 * orders and leaves every historical order exactly as it was priced —
 * these numbers are what we owe merchants and drivers, so they cannot be
 * allowed to drift.
 */
export interface IOrderFinance {
  productSubtotal: number;
  merchantCommission: number;
  customerServiceFee: number;
  deliveryCustomerFee: number;
  driverDeliveryPayout: number;
  deliveryMargin: number;
  tip: number;
  merchantFundedDiscount: number;
  platformFundedDiscount: number;
  taxPayable: number;
  businessPayout: number;
  driverPayout: number;
  platformGrossRevenue: number;
  platformPromotionExpense: number;
  platformNetRevenueBeforeOperatingCosts: number;
  /** What the customer is charged. */
  customerTotal: number;
  currency: string;
  pricingConfigVersion: number;
  /** Commission rate actually applied, in basis points. */
  appliedCommissionBps: number;
}

export interface IOrder extends Document {
  orderNumber: string;
  clientId: Types.ObjectId;
  businessId: Types.ObjectId;
  driverId?: Types.ObjectId;
  items: IOrderItem[];
  status: OrderStatus;
  paymentMethod: PaymentMethod;
  paymentStatus: PaymentStatus;
  deliveryAddress: string;
  deliveryDetails?: string;
  deliveryLocation: GeoPoint;
  subtotal: number;
  deliveryFee: number;
  /** Straight-line distance business → customer, used to price delivery. */
  deliveryDistanceKm?: number;
  zoneId?: Types.ObjectId | null;
  /** Discount applied by a coupon. Always >= 0. */
  discount: number;
  couponId?: Types.ObjectId | null;
  couponCode?: string;
  /** Goes entirely to the driver, on top of driverPayout. */
  tip: number;
  tax: number;
  platformCommission: number;
  businessPayout: number;
  driverPayout: number;
  total: number;
  /** Authoritative money for this order. Legacy fields above mirror it. */
  finance: IOrderFinance;
  pricingConfigVersion: number;
  notes?: string;
  estimatedDelivery?: Date;
  acceptedAt?: Date;
  preparedAt?: Date;
  pickedUpAt?: Date;
  deliveredAt?: Date;
  cancelledAt?: Date;
  cancellationReason?: string;
  city: string;
  idempotencyKey?: string;
  createdAt: Date;
  updatedAt: Date;
}

const selectedExtraSchema = new Schema(
  { name: { type: String, required: true }, price: { type: Number, required: true }, quantity: { type: Number, default: 1 } },
  { _id: false }
);

const orderItemSchema = new Schema(
  {
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    productName: { type: String, required: true },
    quantity: { type: Number, required: true, min: 1 },
    unitPrice: { type: Number, required: true, min: 0 },
    totalPrice: { type: Number, required: true, min: 0 },
    selectedExtras: { type: [selectedExtraSchema], default: [] },
    notes: { type: String, default: '' },
  },
  { _id: true }
);

const intMoney = {
  type: Number,
  default: 0,
  min: 0,
  validate: { validator: Number.isInteger, message: 'Debe ser un entero en COP' },
};

const orderFinanceSchema = new Schema<IOrderFinance>(
  {
    productSubtotal: intMoney,
    merchantCommission: intMoney,
    customerServiceFee: intMoney,
    deliveryCustomerFee: intMoney,
    driverDeliveryPayout: intMoney,
    // Margin is the only line allowed to be negative: a promotional
    // delivery price below the driver's guaranteed fee is a real business
    // decision, and it must show up as a loss rather than be clamped away.
    deliveryMargin: { type: Number, default: 0, validate: Number.isInteger },
    tip: intMoney,
    merchantFundedDiscount: intMoney,
    platformFundedDiscount: intMoney,
    taxPayable: intMoney,
    businessPayout: intMoney,
    driverPayout: intMoney,
    platformGrossRevenue: { type: Number, default: 0, validate: Number.isInteger },
    platformPromotionExpense: intMoney,
    platformNetRevenueBeforeOperatingCosts: { type: Number, default: 0, validate: Number.isInteger },
    customerTotal: intMoney,
    currency: { type: String, default: 'COP' },
    pricingConfigVersion: { type: Number, default: 0 },
    appliedCommissionBps: { type: Number, default: 0, min: 0, max: 10_000 },
  },
  { _id: false }
);

const orderSchema = new Schema<IOrder>(
  {
    orderNumber: { type: String, unique: true },
    clientId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true },
    driverId: { type: Schema.Types.ObjectId, ref: 'Driver', default: null },
    items: { type: [orderItemSchema], required: true },
    status: { type: String, enum: Object.values(OrderStatus), default: OrderStatus.PENDING },
    paymentMethod: { type: String, enum: Object.values(PaymentMethod), required: true },
    paymentStatus: { type: String, enum: Object.values(PaymentStatus), default: PaymentStatus.PENDING },
    deliveryAddress: { type: String, required: true },
    deliveryDetails: { type: String, default: '' },
    deliveryLocation: { type: { type: String, enum: ['Point'], default: 'Point' }, coordinates: { type: [Number], required: true } },
    subtotal: { type: Number, required: true, min: 0 },
    deliveryFee: { type: Number, required: true, min: 0 },
    deliveryDistanceKm: { type: Number, default: null, min: 0 },
    zoneId: { type: Schema.Types.ObjectId, ref: 'Zone', default: null },
    discount: { type: Number, default: 0, min: 0 },
    couponId: { type: Schema.Types.ObjectId, ref: 'Coupon', default: null },
    couponCode: { type: String, default: null, uppercase: true, trim: true },
    tip: { type: Number, default: 0, min: 0 },
    tax: { type: Number, default: 0, min: 0 },
    platformCommission: { type: Number, required: true, min: 0 },
    businessPayout: { type: Number, required: true, min: 0 },
    driverPayout: { type: Number, required: true, min: 0 },
    total: { type: Number, required: true, min: 0 },
    finance: { type: orderFinanceSchema, required: true, default: () => ({}) },
    pricingConfigVersion: { type: Number, default: 0, index: true },
    notes: { type: String, default: '' },
    estimatedDelivery: Date,
    acceptedAt: Date,
    preparedAt: Date,
    pickedUpAt: Date,
    deliveredAt: Date,
    cancelledAt: Date,
    cancellationReason: String,
    city: { type: String, default: 'Garzón' },
    idempotencyKey: { type: String, unique: true, sparse: true },
  },
  { timestamps: true }
);

orderSchema.pre('save', async function (next) {
  if (!this.orderNumber) {
    const seq = await getNextSequence('orderNumber');
    const d = new Date();
    this.orderNumber = `ZP${String(d.getFullYear()).slice(-2)}${String(d.getMonth() + 1).padStart(2, '0')}-${String(seq).padStart(5, '0')}`;
  }
  next();
});

orderSchema.index({ clientId: 1, createdAt: -1 });
orderSchema.index({ businessId: 1, status: 1 });
orderSchema.index({ driverId: 1, status: 1 });
orderSchema.index({ status: 1, city: 1 });
// `orderNumber` already declares `unique: true` on the path.
orderSchema.index({ createdAt: -1 });

export const Order = mongoose.model<IOrder>('Order', orderSchema);
