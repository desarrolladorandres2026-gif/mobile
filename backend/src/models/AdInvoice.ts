import mongoose, { Schema, Document, Types } from 'mongoose';

/**
 * Lo que una campaña terminada le costó al anunciante.
 *
 * ── Por qué no va en el libro mayor ──
 *
 * `LedgerEntry.orderId` es obligatorio y referencia `Order`, y eso es
 * deliberado: todo asiento del libro se puede reconstruir contra algo que
 * pasó en la calle. Un cobro de publicidad no tiene pedido detrás, así que
 * meterlo ahí exigiría inventarse un `orderId` o hacer el campo opcional —
 * migrar la colección más delicada del sistema para un caso que no es un
 * pedido. El esquema tiene razón y esto vive aparte.
 *
 * ── Por qué el gasto se calcula y no se acumula ──
 *
 * Con CPM, sumar `cpmRate / 1000` en cada impresión redondea mil veces y
 * el error se acumula. Aquí se guarda lo que de verdad pasó —impresiones y
 * clics servidos— y el importe sale de multiplicar una sola vez. La cifra
 * es reproducible: con los mismos contadores y las mismas tarifas siempre
 * da lo mismo, aunque el cálculo cambie mañana.
 */
export interface IAdInvoice extends Document {
  campaignId: Types.ObjectId;
  campaignName: string;
  /** A quién se le cobra. Nulo si la vendió el equipo comercial por fuera. */
  businessId?: Types.ObjectId | null;
  advertiserName: string;

  pricingModel: string;
  cpmRate: number;
  cpcRate: number;

  /** Los contadores en el momento de cerrar, congelados. */
  impressions: number;
  clicks: number;

  /** Importe en pesos, derivado de lo de arriba. */
  amount: number;
  currency: string;

  periodStart: Date;
  periodEnd: Date;

  /**
   * Si se descuenta de la liquidación del comercio o se cobra por fuera.
   *
   * Descontarlo es lo que permite que un comercio compre publicidad sin
   * tarjeta ni pasarela: ya recibe un pago semanal de ZIPP, y esto es una
   * resta sobre él.
   */
  settledAgainstPayout: boolean;
  settledAt?: Date | null;

  createdAt: Date;
  updatedAt: Date;
}

const adInvoiceSchema = new Schema<IAdInvoice>(
  {
    campaignId: { type: Schema.Types.ObjectId, ref: 'Advertisement', required: true },
    campaignName: { type: String, required: true, trim: true },
    businessId: { type: Schema.Types.ObjectId, ref: 'Business', default: null },
    advertiserName: { type: String, default: '', trim: true },

    pricingModel: { type: String, required: true },
    cpmRate: { type: Number, default: 0, min: 0 },
    cpcRate: { type: Number, default: 0, min: 0 },

    impressions: { type: Number, default: 0, min: 0 },
    clicks: { type: Number, default: 0, min: 0 },

    amount: {
      type: Number,
      required: true,
      min: 0,
      validate: { validator: Number.isInteger, message: 'El importe debe ser un entero en COP' },
    },
    currency: { type: String, default: 'COP' },

    periodStart: { type: Date, required: true },
    periodEnd: { type: Date, required: true },

    settledAgainstPayout: { type: Boolean, default: false },
    settledAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// Una campaña se factura una sola vez. El índice es la garantía, no una
// comprobación en el servicio que alguien pueda olvidar reproducir.
adInvoiceSchema.index({ campaignId: 1 }, { unique: true });
adInvoiceSchema.index({ businessId: 1, createdAt: -1 });
adInvoiceSchema.index({ settledAt: 1 });

export const AdInvoice = mongoose.model<IAdInvoice>('AdInvoice', adInvoiceSchema);
