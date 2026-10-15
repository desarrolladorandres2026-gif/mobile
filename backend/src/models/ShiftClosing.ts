import mongoose, { Schema, Document, Types } from 'mongoose';

/**
 * El cierre de caja de un turno: lo vendido en el día hasta ese momento, a
 * nombre de quien lo cerró.
 *
 * ── Por qué no va en el libro mayor ──
 *
 * No mueve dinero: es un acta. `LedgerEntry` registra quién le debe qué a
 * quién; esto registra qué cifras vio y declaró una persona al irse. Vive
 * aparte, igual que `AdInvoice`, para que ningún total de aquí pueda
 * contaminar liquidaciones.
 *
 * Los importes se congelan en el momento de cerrar: un pedido que cambie
 * mañana no reescribe lo que el empleado firmó hoy.
 */
export interface IShiftClosing extends Document {
  businessId: Types.ObjectId;
  /** Quién cerró. */
  closedBy: Types.ObjectId;
  closedByName: string;
  closedByRole: string;
  /** Día de Bogotá (`YYYY-MM-DD`) al que pertenece el cierre. */
  date: string;

  /** Ventas de producto entregadas en el día, sin domicilio ni propina. */
  sales: number;
  ordersDelivered: number;
  ordersCancelled: number;
  /**
   * De `sales`, lo vendido contra entrega (valor de producto). Es un dato
   * informativo: NO es lo que debe haber en la caja, porque el domiciliario
   * paga al comercio su neto (sin comisión ni descuento asumido), no el
   * valor del producto.
   */
  cashSales: number;
  onlineSales: number;

  /**
   * Lo que debe haber en efectivo en este corte: la suma de lo que los
   * domiciliarios pagaron al comercio por pedidos contra entrega recogidos
   * desde el cierre anterior del día (o desde que empezó) hasta este cierre.
   * `null` en los cierres anteriores a este campo: eran actas firmadas contra
   * `cashSales` y no se reescriben; se distinguen por `expectedCash === null`.
   */
  expectedCash: number | null;
  /** Contra entrega ya recogidos y aún sin entregar al cliente; ya están dentro de `expectedCash`. */
  inTransit: { count: number; amount: number } | null;
  /** Cancelados tras recoger: el sistema repone al domiciliario, no suman a `expectedCash`. */
  cancelledAfterPickup: { count: number; amount: number } | null;
  /** Inicio del corte que cubre `expectedCash`. `null` en los cierres viejos. */
  coversFrom: Date | null;

  /** Lo que el empleado dice tener en efectivo. `null` si no lo contó. */
  declaredCash: number | null;
  /**
   * `declaredCash - expectedCash`; negativo es faltante. `null` sin conteo.
   * En cierres con `expectedCash === null` se calculó contra `cashSales`.
   */
  difference: number | null;
  note: string;
  createdAt: Date;
}

const shiftClosingSchema = new Schema<IShiftClosing>(
  {
    businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true },
    closedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    closedByName: { type: String, required: true, trim: true, maxlength: 160 },
    closedByRole: { type: String, required: true },
    date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    sales: { type: Number, required: true, min: 0 },
    ordersDelivered: { type: Number, required: true, min: 0 },
    ordersCancelled: { type: Number, required: true, min: 0 },
    cashSales: { type: Number, required: true, min: 0 },
    onlineSales: { type: Number, required: true, min: 0 },
    expectedCash: { type: Number, default: null, min: 0, validate: Number.isInteger },
    inTransit: { type: new Schema({ count: Number, amount: Number }, { _id: false }), default: null },
    cancelledAfterPickup: { type: new Schema({ count: Number, amount: Number }, { _id: false }), default: null },
    coversFrom: { type: Date, default: null },
    declaredCash: { type: Number, default: null, min: 0 },
    difference: { type: Number, default: null },
    note: { type: String, default: '', trim: true, maxlength: 300 },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

shiftClosingSchema.index({ businessId: 1, date: 1, createdAt: -1 });

export const ShiftClosing = mongoose.model<IShiftClosing>('ShiftClosing', shiftClosingSchema);
