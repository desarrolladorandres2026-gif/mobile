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
  /** De `sales`, lo cobrado contra entrega: lo que debería haber en efectivo. */
  cashSales: number;
  onlineSales: number;

  /** Lo que el empleado dice tener en efectivo. `null` si no lo contó. */
  declaredCash: number | null;
  /** `declaredCash - cashSales`; negativo es faltante. `null` sin conteo. */
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
    declaredCash: { type: Number, default: null, min: 0 },
    difference: { type: Number, default: null },
    note: { type: String, default: '', trim: true, maxlength: 300 },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

shiftClosingSchema.index({ businessId: 1, date: 1, createdAt: -1 });

export const ShiftClosing = mongoose.model<IShiftClosing>('ShiftClosing', shiftClosingSchema);
