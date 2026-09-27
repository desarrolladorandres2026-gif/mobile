import mongoose, { Schema, Document, Types } from 'mongoose';

/**
 * Historial de seguridad de las cuentas que entran al panel de comercios
 * (dueños y su personal). Lo lee el centro de seguridad del panel admin.
 *
 * No vive en `AuditLog` por dos razones. Ese es *capped* (1 GB para toda la
 * plataforma): el historial de un comercio desaparecería por volumen, no por
 * política. Y no sabe de negocios: no hay forma barata de pedirle "todo lo del
 * comercio X". `AuditLog` sigue siendo el rastro de lo que hacen los admins.
 *
 * Tampoco sale de `Session`: su índice TTL borra las sesiones vencidas y
 * revocadas en cuanto pasa su `expiresAt`, así que ahí no queda historia.
 *
 * Inmutable: no se edita ni se borra desde la aplicación (ver los hooks de
 * abajo). Solo lo retira el TTL al cumplir `SECURITY_EVENT_RETENTION_DAYS`.
 * Los hooks frenan a Mongoose, no a `collection.*` ni a `bulkWrite`: la
 * garantía fuerte es un usuario de Mongo sin update/delete sobre la colección.
 * Nunca guarda contraseñas, tokens, códigos TOTP ni secretos.
 */
export enum SecurityEventType {
  LOGIN_SUCCESS = 'LOGIN_SUCCESS',
  LOGIN_FAILED = 'LOGIN_FAILED',
  LOGOUT = 'LOGOUT',
  NEW_DEVICE = 'NEW_DEVICE',
  NEW_IP = 'NEW_IP',
  TWO_FACTOR_SUCCESS = 'TWO_FACTOR_SUCCESS',
  TWO_FACTOR_FAILED = 'TWO_FACTOR_FAILED',
  /** Cerrada por el sistema: reuso de token, cambio de contraseña, tope de sesiones. */
  SESSION_REVOKED = 'SESSION_REVOKED',
  /** La persona cerró otra de sus sesiones desde su panel. */
  REMOTE_LOGOUT = 'REMOTE_LOGOUT',
  PASSWORD_CHANGED = 'PASSWORD_CHANGED',
  SECURITY_SETTINGS_CHANGED = 'SECURITY_SETTINGS_CHANGED',
  /** Un administrador de ZIPP cerró sesiones de la cuenta. */
  ADMIN_SESSION_REVOCATION = 'ADMIN_SESSION_REVOCATION',
}

export const SECURITY_EVENT_TYPES = Object.values(SecurityEventType);

export type SecurityEventResult = 'success' | 'failure' | 'info';

/**
 * 12 meses (decisión del 2026-09-26). El TTL de Mongo se fija al crear el
 * índice: cambiar este número exige `collMod` sobre `createdAt_1`, no basta
 * con desplegar.
 */
export const SECURITY_EVENT_RETENTION_DAYS = 365;

export interface ISecurityEvent extends Document {
  userId: Types.ObjectId;
  /**
   * Foto de los negocios a los que la cuenta tenía acceso cuando pasó. Un
   * empleado dado de baja deja su historia en el negocio donde trabajaba, y
   * uno nuevo no arrastra la de antes de entrar.
   */
  businessIds: Types.ObjectId[];
  type: SecurityEventType;
  result: SecurityEventResult;
  ip: string;
  userAgent: string;
  sessionId: string | null;
  deviceId: string | null;
  /** Foto del dispositivo: la sesión que lo describía se borra a los días. */
  device: { platform: string; os: string; browser: string; browserVersion?: string } | null;
  /** Código del motivo (`password_changed`, `reuse_detected`, `admin`…). */
  reason: string | null;
  /** Motivo escrito por el administrador, cuando lo hay. */
  note: string | null;
  actorId: Types.ObjectId | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

const securityEventSchema = new Schema<ISecurityEvent>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    businessIds: { type: [Schema.Types.ObjectId], default: [] },
    type: { type: String, enum: SECURITY_EVENT_TYPES, required: true },
    result: { type: String, enum: ['success', 'failure', 'info'], default: 'info' },
    ip: { type: String, default: 'unknown', maxlength: 64 },
    userAgent: { type: String, default: 'unknown', maxlength: 512 },
    sessionId: { type: String, default: null },
    deviceId: { type: String, default: null, maxlength: 64 },
    device: {
      type: new Schema(
        {
          platform: String,
          os: String,
          browser: String,
          browserVersion: String,
        },
        { _id: false }
      ),
      default: null,
    },
    reason: { type: String, default: null, maxlength: 64 },
    note: { type: String, default: null, maxlength: 500 },
    actorId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// El centro de seguridad pide "lo de este negocio, lo más reciente primero",
// con o sin filtro de tipo.
securityEventSchema.index({ businessIds: 1, createdAt: -1 });
securityEventSchema.index({ businessIds: 1, type: 1, createdAt: -1 });
// Historial de una cuenta y "¿esta IP ya se había visto?" (NEW_IP).
securityEventSchema.index({ userId: 1, createdAt: -1 });
securityEventSchema.index({ userId: 1, ip: 1 });
securityEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: SECURITY_EVENT_RETENTION_DAYS * 24 * 60 * 60 });

const immutable = () => new Error('SecurityEvent es inmutable: no se edita ni se borra');

securityEventSchema.pre('save', function (next) {
  next(this.isNew ? undefined : immutable());
});
// `doc.deleteOne()` es middleware de documento, no de query.
securityEventSchema.pre('deleteOne', { document: true, query: false }, function (next) {
  next(immutable());
});
for (const op of [
  'updateOne',
  'updateMany',
  'findOneAndUpdate',
  'replaceOne',
  'findOneAndReplace',
  'deleteOne',
  'deleteMany',
  'findOneAndDelete',
] as const) {
  securityEventSchema.pre(op, { document: false, query: true }, function (next) {
    next(immutable());
  });
}

export const SecurityEvent = mongoose.model<ISecurityEvent>('SecurityEvent', securityEventSchema);
