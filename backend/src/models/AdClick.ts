import mongoose, { Schema, Document, Types } from 'mongoose';

/**
 * Por qué un clic no se cobró. Se guarda igual que uno cobrado: la diferencia
 * entre lo que se tocó y lo que se facturó tiene que poder explicarse.
 */
export enum AdClickRejection {
  /** El mismo dispositivo ya generó un clic cobrable en esta campaña dentro de la ventana. */
  DUPLICATE_DEVICE = 'duplicate_device',
  /** Ese dispositivo no vio la campaña poco antes: un clic sin impresión es un script. */
  NO_IMPRESSION = 'no_impression',
  /** Demasiados clics cobrables desde la misma red en el día. */
  IP_LIMIT = 'ip_limit',
  /** El tope de clics que compró el presupuesto ya se alcanzó. */
  BUDGET_EXHAUSTED = 'budget_exhausted',
  /** ZIPP apagó la facturación de publicidad. */
  BILLING_DISABLED = 'billing_disabled',
  /** La campaña dejó de estar viva (cancelada, pausada, vencida) entre la lectura y la escritura. */
  NOT_LIVE = 'not_live',
  /** La misma cuenta ya generó un clic cobrable en esta campaña dentro de la ventana, con otro dispositivo. */
  DUPLICATE_USER = 'duplicate_user',
  /** Señal dura de automatización: no se cobra y queda en cola para que una persona lo mire. */
  SUSPICIOUS = 'suspicious',
}

/**
 * Lo que se observó de un clic, aceptado o no. Las señales *duras* mandan el
 * clic a revisión (`review: true`, sin cobro); las *blandas* solo se anotan
 * para que quien investigue vea el patrón.
 */
export enum AdClickSignal {
  /** Duro: el clic llegó antes de lo que una persona tarda en leer y tocar el anuncio. */
  TOO_FAST = 'too_fast',
  /** Duro: el agente de usuario es el de una herramienta de automatización. */
  AUTOMATION_AGENT = 'automation_agent',
  /** Blando: la petición no trae agente de usuario. */
  NO_AGENT = 'no_agent',
  /** Blando: varios dispositivos distintos tocaron esta campaña desde la misma red en pocos minutos. */
  NETWORK_BURST = 'network_burst',
}

export const HARD_CLICK_SIGNALS: readonly AdClickSignal[] = [AdClickSignal.TOO_FAST, AdClickSignal.AUTOMATION_AGENT];

/**
 * Registro de cada clic sobre una campaña cobrada por clic (CPC).
 *
 * ── Por qué no basta `AdEvent` ──
 *
 * `AdEvent` es una colección *capped*: se poda sola a los 2 millones de
 * documentos. Sirve para analítica; no sirve para defender una factura tres
 * meses después. Esto es la evidencia: cada fila dice qué clic fue, de qué
 * dispositivo, si se cobró, a qué tarifa y, si no, por qué.
 *
 * ── Por qué no va al libro mayor ──
 *
 * Igual que `AdInvoice`: no hay pedido detrás. El cobro real ocurre al cerrar
 * la campaña (`AdInvoice`) y al compensarlo contra una liquidación, que sí se
 * asienta atado a un pedido (ver CLAUDE.md, excepción del 2026-09-23).
 *
 * ── Idempotencia ──
 *
 * - `(campaignId, clickId)` es único: la app manda el mismo `clickId` en un
 *   doble toque o un reintento, y el segundo no vuelve a contar.
 * - `dedupeKey` (`campaña:dispositivo:ventana`) es único SOLO mientras el clic
 *   es cobrable: dos clics simultáneos del mismo dispositivo no pueden pasar
 *   los dos. Un clic rechazado suelta la clave.
 */
export interface IAdClick extends Document {
  campaignId: Types.ObjectId;
  clickId: string;
  deviceId: string;
  userId?: Types.ObjectId | null;
  /** SHA-256 de la IP con secreto del servidor: sirve para contar, no para identificar. */
  ipHash?: string | null;
  billable: boolean;
  rejection?: AdClickRejection | null;
  /** COP cobrados por este clic (la tarifa de la campaña); 0 si no se cobró. */
  amount: number;
  /** Tarifa de la campaña en el momento del clic. */
  rate: number;
  dedupeKey?: string | null;
  /** Igual que `dedupeKey` pero por cuenta: rotar de dispositivo no abre otro clic cobrable. */
  userDedupeKey?: string | null;
  /** Señales observadas (ver `AdClickSignal`). Se guardan también en los clics cobrados. */
  signals: AdClickSignal[];
  /** Un clic con señal dura: no se cobra y espera a que una persona lo investigue. */
  review: boolean;
  /** Primeros 120 caracteres del agente de usuario, para investigar; no identifica a nadie. */
  userAgent?: string | null;
  /** Milisegundos entre la última impresión de ese dispositivo y este clic; null si no hubo. */
  msSinceImpression?: number | null;
  /** Versión de la configuración de publicidad con la que se decidió. */
  configVersion?: number | null;
  createdAt: Date;
}

const adClickSchema = new Schema<IAdClick>(
  {
    campaignId: { type: Schema.Types.ObjectId, ref: 'Advertisement', required: true },
    clickId: { type: String, required: true, maxlength: 64 },
    deviceId: { type: String, required: true, maxlength: 100 },
    userId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    ipHash: { type: String, default: null, maxlength: 64 },
    billable: { type: Boolean, default: false },
    rejection: { type: String, enum: [...Object.values(AdClickRejection), null], default: null },
    amount: { type: Number, default: 0, min: 0, validate: { validator: Number.isInteger, message: 'El importe debe ser un entero en COP' } },
    rate: { type: Number, default: 0, min: 0 },
    dedupeKey: { type: String, default: undefined },
    userDedupeKey: { type: String, default: undefined },
    signals: { type: [{ type: String, enum: Object.values(AdClickSignal) }], default: [] },
    review: { type: Boolean, default: false },
    userAgent: { type: String, default: null, maxlength: 120 },
    msSinceImpression: { type: Number, default: null },
    configVersion: { type: Number, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

adClickSchema.index({ campaignId: 1, clickId: 1 }, { unique: true });
adClickSchema.index(
  { dedupeKey: 1 },
  { unique: true, partialFilterExpression: { dedupeKey: { $type: 'string' } } }
);
adClickSchema.index(
  { userDedupeKey: 1 },
  { unique: true, partialFilterExpression: { userDedupeKey: { $type: 'string' } } }
);
adClickSchema.index({ campaignId: 1, billable: 1, createdAt: -1 });
// La cola de revisión: lo que una persona tiene que mirar.
adClickSchema.index({ review: 1, createdAt: -1 }, { partialFilterExpression: { review: true } });
adClickSchema.index({ campaignId: 1, ipHash: 1, billable: 1, createdAt: -1 });

export const AdClick = mongoose.model<IAdClick>('AdClick', adClickSchema);

/**
 * Cupo diario de clics cobrables por red y campaña.
 *
 * Contar filas de `AdClick` y después insertar deja pasar a dos clics
 * simultáneos que ven «9 de 10». Aquí el cupo se **reserva** con un solo
 * `findOneAndUpdate` condicionado (`count < límite`, con upsert): si el cupo
 * está lleno, el upsert intenta insertar la misma clave y el índice único lo
 * rechaza. Ninguna interleaving supera el límite. Si el clic no llega a
 * cobrarse, el cupo se devuelve (`$inc: -1`).
 *
 * Guarda el hash de la red, nunca la IP. Caduca solo (TTL).
 */
export interface IAdNetworkQuota extends Document {
  /** `campaña:hashDeRed:AAAA-MM-DD` (día en la zona horaria de liquidación). */
  key: string;
  campaignId: Types.ObjectId;
  count: number;
  expiresAt: Date;
}

const adNetworkQuotaSchema = new Schema<IAdNetworkQuota>(
  {
    key: { type: String, required: true },
    campaignId: { type: Schema.Types.ObjectId, ref: 'Advertisement', required: true },
    count: { type: Number, default: 0, min: 0 },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: false }
);

adNetworkQuotaSchema.index({ key: 1 }, { unique: true });
adNetworkQuotaSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const AdNetworkQuota = mongoose.model<IAdNetworkQuota>('AdNetworkQuota', adNetworkQuotaSchema);
