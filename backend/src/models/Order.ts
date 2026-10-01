import { realtimeInvalidatePlugin } from '../realtime/invalidate';
import mongoose, { Schema, Document, Types } from 'mongoose';
import {
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
  GeoPoint,
  SelectedExtra,
  OrderKind,
  CancellationReason,
  CancelledBy,
} from '../types';
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
  /**
   * Lo que Zipp Pro le quitó a este pedido. Ya está DENTRO de
   * `platformFundedDiscount` (no se suma otra vez): se guarda aparte para
   * poder decir cuánto cuestan los beneficios frente a lo que se cobra de
   * membresía. Pedidos anteriores a este campo no lo tienen.
   */
  proDeliveryDiscount?: number;
  proServiceFeeDiscount?: number;
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

/**
 * Cómo va la búsqueda de domiciliario para este pedido.
 *
 * Vive en el pedido y no en memoria del proceso a propósito: una oferta que
 * caduca en cuarenta y cinco segundos no puede depender de que el servidor
 * siga siendo el mismo dentro de cuarenta y cinco segundos. Reiniciar el
 * backend con pedidos en la calle es normal; perder por eso todas las
 * ofertas en vuelo, no.
 */
export interface IOrderDispatch {
  /** Ronda actual de la cascada. 0 = todavía no se ha ofrecido. */
  round: number;
  /** Vueltas completas dadas a la lista sin que nadie aceptara. */
  cycle: number;
  /** A quién se le está ofreciendo ahora mismo. */
  offeredDriverIds: Types.ObjectId[];
  /** Quién dijo que no. No se les vuelve a ofrecer en el mismo ciclo. */
  declinedDriverIds: Types.ObjectId[];
  /** Cuándo deja de valer la ronda actual. */
  expiresAt?: Date | null;
  lastOfferedAt?: Date | null;
}

export interface IOrder extends Document {
  orderNumber: string;
  clientId: Types.ObjectId;
  kind: OrderKind;
  /** Ausente solo en mandados: ahí no hay comercio afiliado detrás. */
  businessId?: Types.ObjectId;

  /**
   * Los datos propios de un mandado.
   *
   * Un mandado no tiene catálogo: tiene una descripción escrita por el
   * cliente y un sitio del que recoger. El tope de gasto existe porque el
   * cliente autoriza una compra que todavía no ha visto — sin techo, está
   * firmando un cheque en blanco.
   */
  errand?: {
    description: string;
    pickupAddress: string;
    pickupLocation: GeoPoint;
    /** Lo que el cliente cree que costará. Orientativo. */
    estimatedCost: number;
    /** Lo máximo que autoriza gastar. Esto sí es un límite duro. */
    maxCost: number;
    /** Lo que costó de verdad, cuando se sabe. */
    actualCost?: number | null;
  };
  driverId?: Types.ObjectId;
  items: IOrderItem[];
  status: OrderStatus;
  paymentMethod: PaymentMethod;
  paymentStatus: PaymentStatus;
  /**
   * Para quién es el pedido, cuando no es para quien lo paga.
   *
   * Un regalo, un almuerzo a los padres, algo a un amigo enfermo. Sin esto
   * el domiciliario llamaba al número de quien pagó, que estaba en otra
   * ciudad, y el pedido se quedaba en la puerta.
   *
   * El código de entrega no cambia: sigue siendo del pedido, y quien lo
   * recibe es quien lo tiene. Lo que cambia es a quién llamar.
   */
  recipient?: { name: string; phone: string; note?: string };

  /**
   * Solo cuando `paymentMethod` es efectivo. El cliente decide, al
   * confirmar el pedido, si va a pagar con un billete que necesita vuelto
   * o si entrega el valor exacto — es lo que el domiciliario necesita
   * saber para llevar cambio suficiente, y lo que antes no se preguntaba
   * en ningún momento del flujo.
   */
  cashPayment?: {
    needsChange: boolean;
    /** Con cuánto paga, cuando `needsChange` es true. */
    payingWith?: number;
  };

  /**
   * Cuándo quiere el cliente que llegue, si no es cuanto antes.
   *
   * Ausente en la inmensa mayoría de pedidos. Cuando está, el pedido
   * espera: no se le ofrece a ningún domiciliario hasta que se acerca su
   * hora.
   */
  /**
   * El pedido lleva algo que no se le puede vender a un menor.
   *
   * Se calcula al crearlo y se congela: si el comercio quita la marca del
   * producto mañana, este pedido siguió necesitando la cédula hoy.
   */
  requiresAgeVerification: boolean;

  scheduledFor?: Date | null;
  /**
   * Cuándo se le enseñó al negocio.
   *
   * Un pedido programado existe desde que se paga, pero no aparece en la
   * cocina hasta que toca: enseñarlo doce horas antes solo sirve para que
   * lo preparen doce horas antes.
   */
  scheduledActivatedAt?: Date | null;

  deliveryAddress: string;
  deliveryDetails?: string;
  deliveryLocation: GeoPoint;
  subtotal: number;
  deliveryFee: number;
  /** Straight-line distance business → customer, used to price delivery. */
  deliveryDistanceKm?: number;
  zoneId?: Types.ObjectId | null;
  /**
   * Versión de la tarifa de la zona con la que se cotizó este pedido (D9).
   * Junto a `zoneId` permite explicar el precio del domicilio meses después,
   * aunque la zona haya cambiado. `null` en pedidos sin zona o anteriores al
   * versionado.
   */
  zoneVersion?: number | null;
  /** Discount applied by a coupon. Always >= 0. */
  discount: number;
  couponId?: Types.ObjectId | null;
  couponCode?: string;
  /**
   * Promociones automáticas por producto que aplicaron a este pedido, sin
   * código. A diferencia de `couponId` (uno solo, el que el cliente
   * escribió), aquí puede haber varias: una por cada producto o grupo de
   * productos distinto que tuviera una promoción activa en el carrito.
   */
  appliedPromotionIds?: Types.ObjectId[];
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
  /** Cuándo se asignó el domiciliario. Sin esto no se puede saber si tarda. */
  assignedAt?: Date;
  /**
   * Devolución de fondo pendiente tras soltar al domiciliario: se escribe en
   * la misma operación atómica que la desasignación y se limpia cuando el
   * `$inc` del fondo ya se aplicó. Un barrido reintenta las que queden.
   */
  fundHoldReleasePending?: { driverId: Types.ObjectId; amount: number; token: string } | null;
  acceptedAt?: Date;
  preparedAt?: Date;
  pickedUpAt?: Date;
  deliveredAt?: Date;
  cancelledAt?: Date;
  /** Texto libre. Se conserva para los pedidos anteriores al catálogo. */
  cancellationReason?: string;
  /** Motivo del catálogo cerrado. Es lo que se puede contar y agrupar. */
  cancellationCode?: CancellationReason;
  /** Quién decidió cancelar. Antes solo quedaba en el registro de eventos. */
  cancelledBy?: CancelledBy;
  cancelledByUserId?: Types.ObjectId;
  /** Estado de la oferta automática. Ausente en pedidos anteriores al reparto. */
  dispatch?: IOrderDispatch;
  city: string;
  idempotencyKey?: string;
  createdAt: Date;
  updatedAt: Date;
}

const selectedExtraSchema = new Schema(
  {
    name: { type: String, required: true },
    price: { type: Number, required: true },
    quantity: { type: Number, default: 1 },
    // Solo cuando la elección salió de un grupo de modificadores. Son
    // cadenas y no `ObjectId` con `ref` a propósito: apuntan a
    // subdocumentos del producto, que Mongoose no puede poblar, y la
    // copia del pedido tiene que sobrevivir a que el comercio borre la
    // opción mañana.
    groupId: { type: String },
    groupName: { type: String },
    optionId: { type: String },
  },
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
    proDeliveryDiscount: intMoney,
    proServiceFeeDiscount: intMoney,
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
    kind: { type: String, enum: Object.values(OrderKind), default: OrderKind.DELIVERY },
    businessId: {
      type: Schema.Types.ObjectId,
      ref: 'Business',
      // Obligatorio salvo en mandados. Se expresa como condición y no como
      // `required: false` porque un pedido normal sin comercio es un
      // documento roto, y el esquema es el único sitio donde se puede
      // impedir que exista.
      required: function (this: { kind?: OrderKind }) {
        return this.kind !== OrderKind.ERRAND;
      },
    },
    errand: {
      type: new Schema(
        {
          description: { type: String, required: true, trim: true, maxlength: 500 },
          pickupAddress: { type: String, required: true, trim: true, maxlength: 300 },
          pickupLocation: {
            type: { type: String, enum: ['Point'], default: 'Point' },
            coordinates: { type: [Number], required: true },
          },
          estimatedCost: { type: Number, default: 0, min: 0 },
          maxCost: { type: Number, required: true, min: 0 },
          actualCost: { type: Number, default: null, min: 0 },
        },
        { _id: false }
      ),
      default: undefined,
    },
    driverId: { type: Schema.Types.ObjectId, ref: 'Driver', default: null },
    items: { type: [orderItemSchema], required: true },
    status: { type: String, enum: Object.values(OrderStatus), default: OrderStatus.PENDING },
    paymentMethod: { type: String, enum: Object.values(PaymentMethod), required: true },
    paymentStatus: { type: String, enum: Object.values(PaymentStatus), default: PaymentStatus.PENDING },
    recipient: {
      type: new Schema(
        {
          name: { type: String, required: true, trim: true, maxlength: 80 },
          phone: { type: String, required: true, trim: true, maxlength: 20 },
          note: { type: String, trim: true, maxlength: 200 },
        },
        { _id: false }
      ),
      default: undefined,
    },
    cashPayment: {
      type: new Schema(
        {
          needsChange: { type: Boolean, required: true },
          payingWith: { type: Number, min: 0, default: null },
        },
        { _id: false }
      ),
      default: undefined,
    },
    requiresAgeVerification: { type: Boolean, default: false },
    scheduledFor: { type: Date, default: null },
    scheduledActivatedAt: { type: Date, default: null },
    deliveryAddress: { type: String, required: true },
    deliveryDetails: { type: String, default: '' },
    deliveryLocation: { type: { type: String, enum: ['Point'], default: 'Point' }, coordinates: { type: [Number], required: true } },
    subtotal: { type: Number, required: true, min: 0 },
    deliveryFee: { type: Number, required: true, min: 0 },
    deliveryDistanceKm: { type: Number, default: null, min: 0 },
    zoneId: { type: Schema.Types.ObjectId, ref: 'Zone', default: null },
    zoneVersion: { type: Number, default: null, min: 1 },
    discount: { type: Number, default: 0, min: 0 },
    couponId: { type: Schema.Types.ObjectId, ref: 'Coupon', default: null },
    couponCode: { type: String, default: null, uppercase: true, trim: true },
    appliedPromotionIds: { type: [Schema.Types.ObjectId], ref: 'Coupon', default: [] },
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
    assignedAt: Date,
    fundHoldReleasePending: {
      type: new Schema({ driverId: { type: Schema.Types.ObjectId, ref: 'Driver' }, amount: { type: Number, min: 0 }, token: String }, { _id: false }),
      select: false,
    },
    acceptedAt: Date,
    preparedAt: Date,
    pickedUpAt: Date,
    deliveredAt: Date,
    cancelledAt: Date,
    cancellationReason: String,
    cancellationCode: { type: String, enum: Object.values(CancellationReason) },
    cancelledBy: { type: String, enum: Object.values(CancelledBy) },
    cancelledByUserId: { type: Schema.Types.ObjectId, ref: 'User' },
    dispatch: {
      type: new Schema<IOrderDispatch>(
        {
          round: { type: Number, default: 0 },
          cycle: { type: Number, default: 0 },
          offeredDriverIds: [{ type: Schema.Types.ObjectId, ref: 'Driver' }],
          declinedDriverIds: [{ type: Schema.Types.ObjectId, ref: 'Driver' }],
          expiresAt: { type: Date, default: null },
          lastOfferedAt: { type: Date, default: null },
        },
        { _id: false }
      ),
      default: undefined,
    },
    city: { type: String, default: 'Garzón' },
    idempotencyKey: { type: String, unique: true, sparse: true },
  },
  { timestamps: true }
);

orderSchema.pre('save', async function (next) {
  if (!this.orderNumber) {
    const seq = await getNextSequence('orderNumber');
    this.orderNumber = String(seq).padStart(6, '0');
  }
  next();
});

orderSchema.index({ clientId: 1, createdAt: -1 });
orderSchema.index({ businessId: 1, status: 1 });
orderSchema.index({ driverId: 1, status: 1 });
orderSchema.index({ status: 1, city: 1 });
// Las colecciones dinámicas del inicio agregan "más pedidos" y "tendencia"
// sobre todo el histórico entregado, sin acotar por negocio: sin este
// índice sería un recorrido completo de la colección en cada petición.
orderSchema.index({ status: 1, deliveredAt: -1 });
// El barrido del reparto pregunta por ofertas vencidas cada pocos segundos.
// Sin índice sería un recorrido completo de la colección varias veces por
// minuto, y crecería con el histórico de pedidos en vez de con los activos.
orderSchema.index({ status: 1, driverId: 1, 'dispatch.expiresAt': 1 });
// El barrido de programados pregunta por lo que ya toca activar.
orderSchema.index({ scheduledFor: 1, status: 1 });
// `orderNumber` already declares `unique: true` on the path.
orderSchema.index({ createdAt: -1 });
// Las listas del panel de comercio y de la app del domiciliario ordenan por
// fecha dentro de cada negocio/domiciliario (y las analíticas filtran por
// rango). Con solo `{businessId, status}`, Mongo trae el histórico entero
// del negocio y lo ordena en memoria en cada página.
orderSchema.index({ businessId: 1, createdAt: -1 });
orderSchema.index({ businessId: 1, status: 1, createdAt: -1 });
orderSchema.index({ driverId: 1, createdAt: -1 });

orderSchema.plugin(realtimeInvalidatePlugin, { resource: 'orders' });
export const Order = mongoose.model<IOrder>('Order', orderSchema);
