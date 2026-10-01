import { realtimeInvalidatePlugin } from '../realtime/invalidate';
import mongoose, { Schema, Document, Types } from 'mongoose';
import {
  CashIncidentType,
  CashIncidentStatus,
  CashIncidentResolution,
} from '../types';

/**
 * Una disputa sobre efectivo que el domiciliario dice no haber recibido.
 *
 * No es un segundo sistema de deuda: la obligación sigue viviendo, entera,
 * en la `CashReconciliation` del pedido — de ahí `reconciliationId`. Esto
 * es solo el expediente de la discusión sobre esa obligación: quién la
 * abrió, qué dijo, quién decidió y qué decidió.
 *
 * Existe porque sin ella el faltante solo dejaba rastro en la auditoría, y
 * un registro de auditoría no tiene estado: nadie puede "trabajar" una
 * lista de eventos, ni saber cuáles quedan por revisar. Se buscó primero
 * algo reutilizable y no lo había — `Pqrs` es del consumidor final (sin
 * pedido, sin monto, sin domiciliario) y `DriverDebt` es el modelo que
 * `CashReconciliation` ya reemplazó.
 *
 * **Nunca se borra.** Borrarla dejaría un saldo modificado sin nada que
 * explique por qué, que es justo lo que hay que poder reconstruir meses
 * después ante un reclamo.
 */
export interface ICashPaymentIncident extends Document {
  orderId: Types.ObjectId;
  paymentId: Types.ObjectId;
  driverId: Types.ObjectId;
  /**
   * El registro financiero que esta incidencia discute. Es el vínculo con
   * el sistema de saldo existente, y lo que evita que la deuda se
   * represente dos veces.
   */
  reconciliationId?: Types.ObjectId | null;
  /**
   * Lo que el cliente debía pagar. Calculado en el servidor desde el
   * pedido; nunca llega de la petición del domiciliario.
   */
  amount: number;
  /**
   * Lo que ZIPP acabó dando por perdido, si se resolvió a su costa.
   *
   * No es lo mismo que `amount` y por eso se guarda aparte: `amount` es el
   * total que el cliente debía, mientras que la pérdida real de ZIPP es
   * solo su parte —el comercio ya cobró de la mano del domiciliario y el
   * domiciliario ya se quedó con su tarifa—. Se toma del saldo vivo en
   * `CASH_IN_TRANSIT`, así que es la cifra exacta que se dio de baja.
   */
  writtenOffAmount?: number;
  currency: string;
  type: CashIncidentType;
  status: CashIncidentStatus;
  resolution?: CashIncidentResolution | null;
  /** Lo que escribió el domiciliario al declarar el faltante. */
  driverNote?: string;
  /** Lo que escribió quien lo resolvió. */
  adminNote?: string;
  resolvedAt?: Date | null;
  resolvedBy?: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Transiciones admitidas.
 *
 * `OPEN → RESOLVED` directo está permitido a propósito: obligar a pasar por
 * "en revisión" un caso obvio solo añade un clic que nadie da, y entonces
 * el estado deja de significar nada. Los dos estados finales no vuelven
 * atrás: reabrir una decisión sobre dinero es una decisión nueva, y merece
 * su propio registro.
 */
export const CASH_INCIDENT_TRANSITIONS: Record<CashIncidentStatus, CashIncidentStatus[]> = {
  [CashIncidentStatus.OPEN]: [
    CashIncidentStatus.UNDER_REVIEW,
    CashIncidentStatus.RESOLVED,
    CashIncidentStatus.REJECTED,
  ],
  [CashIncidentStatus.UNDER_REVIEW]: [
    CashIncidentStatus.RESOLVED,
    CashIncidentStatus.REJECTED,
  ],
  [CashIncidentStatus.RESOLVED]: [],
  [CashIncidentStatus.REJECTED]: [],
};

const cashPaymentIncidentSchema = new Schema<ICashPaymentIncident>(
  {
    orderId: { type: Schema.Types.ObjectId, ref: 'Order', required: true },
    paymentId: { type: Schema.Types.ObjectId, ref: 'Payment', required: true },
    driverId: { type: Schema.Types.ObjectId, ref: 'Driver', required: true },
    reconciliationId: {
      type: Schema.Types.ObjectId,
      ref: 'CashReconciliation',
      default: null,
    },
    amount: {
      type: Number,
      required: true,
      min: 0,
      validate: { validator: Number.isInteger, message: 'El monto debe ser un entero en COP' },
    },
    writtenOffAmount: { type: Number, default: 0, min: 0 },
    currency: { type: String, default: 'COP' },
    type: {
      type: String,
      enum: Object.values(CashIncidentType),
      default: CashIncidentType.CASH_NOT_RECEIVED,
    },
    status: {
      type: String,
      enum: Object.values(CashIncidentStatus),
      default: CashIncidentStatus.OPEN,
    },
    resolution: {
      type: String,
      enum: [...Object.values(CashIncidentResolution), null],
      default: null,
    },
    driverNote: { type: String, default: '', maxlength: 500 },
    adminNote: { type: String, default: '', maxlength: 500 },
    resolvedAt: { type: Date, default: null },
    resolvedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

// Una incidencia por pedido y tipo. El índice *es* la idempotencia: dos
// declaraciones simultáneas del mismo faltante chocan en la base en vez de
// depender de que alguien se acordara de comprobarlo antes de insertar.
cashPaymentIncidentSchema.index({ orderId: 1, type: 1 }, { unique: true });
cashPaymentIncidentSchema.index({ status: 1, createdAt: -1 });
cashPaymentIncidentSchema.index({ driverId: 1, status: 1 });

cashPaymentIncidentSchema.plugin(realtimeInvalidatePlugin, { resource: 'finance' });
export const CashPaymentIncident = mongoose.model<ICashPaymentIncident>(
  'CashPaymentIncident',
  cashPaymentIncidentSchema
);
