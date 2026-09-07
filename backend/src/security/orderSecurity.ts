import mongoose, { Schema, Document, Types } from 'mongoose';
import crypto from 'crypto';
import { config } from '../config';
import { OrderCodeKind, OrderCodeStatus } from '../types';

// ── Order Event Tracking (Audit Trail for Orders) ──

export interface IOrderEvent extends Document {
  orderId: string;
  action: string;
  userId: string;
  userRole: string;
  description: string;
  ip: string;
  deviceId?: string;
  userAgent: string;
  previousValue?: Record<string, any>;
  newValue?: Record<string, any>;
  location?: {
    lat: number;
    lng: number;
  };
  timestamp: Date;
}

const orderEventSchema = new Schema<IOrderEvent>(
  {
    orderId: { type: String, required: true, index: true },
    action: { type: String, required: true },
    userId: { type: String, required: true },
    userRole: { type: String, required: true },
    description: { type: String, required: true },
    ip: { type: String, required: true },
    deviceId: { type: String },
    userAgent: { type: String, default: 'unknown' },
    previousValue: { type: Schema.Types.Mixed },
    newValue: { type: Schema.Types.Mixed },
    location: {
      lat: { type: Number },
      lng: { type: Number },
    },
    timestamp: { type: Date, default: Date.now },
  },
  { timestamps: false }
);

orderEventSchema.index({ orderId: 1, timestamp: -1 });
orderEventSchema.index({ userId: 1, timestamp: -1 });

export const OrderEvent = mongoose.model<IOrderEvent>('OrderEvent', orderEventSchema);

// ── Códigos de seguridad del pedido ──────────────────────────────────
//
// Un pedido tiene dos secretos independientes y de un solo uso:
//
//   PICKUP   el comercio se lo muestra al domiciliario en el mostrador;
//            que el domiciliario pueda teclearlo prueba que estuvo allí.
//   DELIVERY el cliente se lo dice al domiciliario al recibir el pedido;
//            que el domiciliario pueda teclearlo prueba que entregó.
//
// El secreto NO se guarda en claro. De cada código se persisten dos
// derivados con propósitos distintos:
//
//   `hash`   HMAC-SHA256 determinista, ligado al pedido y a la etapa. Es
//            lo único que se compara al verificar, y al ir dentro del
//            filtro de un findOneAndUpdate convierte "consumir el código"
//            en una operación atómica: de dos peticiones simultáneas con
//            el código correcto solo puede ganar una.
//   `secret` AES-256-GCM reversible, porque el flujo exige enseñárselo a
//            exactamente una de las partes (el comercio o el cliente). Se
//            descifra solo en el endpoint que sirve a esa parte, nunca al
//            verificar y nunca para un administrador.
//
// Ligar el HMAC al `orderId` y a la etapa es lo que impide que el código
// de recogida de un pedido sirva como código de entrega, o que el código
// de otro pedido valga aquí: un mismo "583921" produce huellas distintas
// en cada casilla.

export interface IOrderCodeState {
  hash: string;
  secret: string;
  status: OrderCodeStatus;
  attempts: number;
  issuedAt: Date;
  expiresAt: Date | null;
  usedAt: Date | null;
  verifiedBy: Types.ObjectId | null;
  verifiedRole: string | null;
  /** Fin del castigo por intentos fallidos. */
  lockedUntil: Date | null;
  /** Cuándo declaró el domiciliario que llegó al punto de esta etapa. */
  arrivedAt: Date | null;
}

export interface IOrderSecurity extends Document {
  orderId: Types.ObjectId;
  pickup: IOrderCodeState;
  delivery: IOrderCodeState;
  createdAt: Date;
  updatedAt: Date;
}

const codeStateSchema = new Schema<IOrderCodeState>(
  {
    hash: { type: String, required: true },
    secret: { type: String, required: true },
    status: {
      type: String,
      enum: Object.values(OrderCodeStatus),
      default: OrderCodeStatus.PENDING,
    },
    attempts: { type: Number, default: 0, min: 0 },
    issuedAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, default: null },
    usedAt: { type: Date, default: null },
    verifiedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    verifiedRole: { type: String, default: null },
    lockedUntil: { type: Date, default: null },
    arrivedAt: { type: Date, default: null },
  },
  { _id: false }
);

const orderSecuritySchema = new Schema<IOrderSecurity>(
  {
    orderId: { type: Schema.Types.ObjectId, ref: 'Order', required: true, unique: true },
    pickup: { type: codeStateSchema, required: true },
    delivery: { type: codeStateSchema, required: true },
  },
  { timestamps: true }
);

export const OrderSecurity = mongoose.model<IOrderSecurity>(
  'OrderSecurity',
  orderSecuritySchema
);

// ── Helpers criptográficos ───────────────────────────────────────────

/**
 * Genera un código numérico criptográficamente seguro.
 *
 * `crypto.randomInt` y no `Math.random()`: el segundo es un PRNG sembrado
 * con el reloj, así que quien vea unos pocos códigos puede predecir los
 * siguientes — y aquí un código adivinado es un pedido cerrado sin haberlo
 * entregado. El rango se pide completo (0..10^n) y se rellena con ceros,
 * de modo que "000042" es tan probable como cualquier otro y no hay sesgo
 * por módulo.
 */
export function generateOrderCode(length: number = config.orderFlow.code.length): string {
  const digits = Math.min(Math.max(length, 4), 10);
  const max = 10 ** digits;
  return String(crypto.randomInt(0, max)).padStart(digits, '0');
}

/**
 * Huella determinista de un código, ligada al pedido y a la etapa.
 *
 * Se usa HMAC con la clave del servidor —no un hash desnudo— porque el
 * espacio de un código de 6 dígitos es un millón de valores: sin clave,
 * cualquiera con acceso de lectura a la base construiría la tabla entera
 * en segundos y leería todos los códigos vigentes.
 */
export function hashOrderCode(
  orderId: string,
  kind: OrderCodeKind,
  code: string
): string {
  return crypto
    .createHmac('sha256', config.security.encryptionKey)
    .update(`${orderId}:${kind}:${code.trim()}`)
    .digest('hex');
}

/** Comparación en tiempo constante de dos huellas. */
export function codeHashesMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a ?? '', 'utf8');
  const bufB = Buffer.from(b ?? '', 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/** Normaliza lo que teclea el usuario: solo dígitos, sin espacios. */
export function normalizeOrderCode(raw: string): string {
  return (raw ?? '').replace(/\D/g, '');
}

// ── Helper de bitácora ───────────────────────────────────────────────

/**
 * Log an order event
 */
export async function logOrderEvent(
  orderId: string,
  action: string,
  userId: string,
  userRole: string,
  description: string,
  ip: string,
  userAgent: string,
  extra?: {
    deviceId?: string;
    previousValue?: Record<string, any>;
    newValue?: Record<string, any>;
    location?: { lat: number; lng: number };
  }
): Promise<void> {
  try {
    await OrderEvent.create({
      orderId,
      action,
      userId,
      userRole,
      description,
      ip,
      userAgent,
      ...extra,
    });
  } catch (error) {
    console.error('[ORDER_EVENT] Failed to log order event:', error);
  }
}
