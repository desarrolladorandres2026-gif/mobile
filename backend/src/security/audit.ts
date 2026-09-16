import mongoose, { Schema, Document } from 'mongoose';
import { Request } from 'express';

// ── Audit Action Types ──
export enum AuditAction {
  // Auth events
  LOGIN_SUCCESS = 'login_success',
  LOGIN_FAILED = 'login_failed',
  LOGOUT = 'logout',
  REGISTER = 'register',
  PASSWORD_CHANGE = 'password_change',
  PASSWORD_RESET = 'password_reset',
  OTP_SENT = 'otp_sent',
  OTP_VERIFIED = 'otp_verified',
  OTP_FAILED = 'otp_failed',
  TOKEN_REFRESH = 'token_refresh',

  // 2FA events
  TOTP_ENABLED = 'totp_enabled',
  TOTP_DISABLED = 'totp_disabled',
  TOTP_VERIFIED = 'totp_verified',
  TOTP_FAILED = 'totp_failed',

  // Session events
  SESSION_CREATED = 'session_created',
  SESSION_REVOKED = 'session_revoked',
  SESSION_REVOKED_ALL = 'session_revoked_all',
  NEW_DEVICE_DETECTED = 'new_device_detected',

  // User management
  USER_ACTIVATED = 'user_activated',
  USER_DEACTIVATED = 'user_deactivated',
  USER_BLOCKED = 'user_blocked',
  USER_UNBLOCKED = 'user_unblocked',
  ROLE_CHANGED = 'role_changed',
  PROFILE_UPDATED = 'profile_updated',
  USER_CONTACT_OVERRIDDEN = 'user_contact_overridden',

  // ── Seguridad y Acceso: Cargos, Roles, asignaciones ──
  POSITION_CREATED = 'position_created',
  POSITION_UPDATED = 'position_updated',
  POSITION_DELETED = 'position_deleted',
  RBAC_ROLE_CREATED = 'rbac_role_created',
  RBAC_ROLE_UPDATED = 'rbac_role_updated',
  RBAC_ROLE_DELETED = 'rbac_role_deleted',
  RBAC_ROLE_PERMISSIONS_CHANGED = 'rbac_role_permissions_changed',
  USER_POSITION_ASSIGNED = 'user_position_assigned',
  USER_ROLES_ASSIGNED = 'user_roles_assigned',
  PRIVILEGE_ESCALATION_BLOCKED = 'privilege_escalation_blocked',

  // Order events
  ORDER_CREATED = 'order_created',
  ORDER_MODIFIED = 'order_modified',
  ORDER_CANCELLED = 'order_cancelled',
  ORDER_STATUS_CHANGED = 'order_status_changed',

  // Traspaso físico del pedido: códigos, evidencias, chat y llamadas.
  // Cada uno es un hecho que alguien puede tener que reconstruir meses
  // después ante un reclamo, así que se auditan por separado y no como
  // un genérico "order_modified".
  ORDER_CODE_ISSUED = 'order_code_issued',
  ORDER_CODE_VERIFIED = 'order_code_verified',
  ORDER_CODE_FAILED = 'order_code_failed',
  ORDER_CODE_BLOCKED = 'order_code_blocked',
  ORDER_CODE_REVEALED = 'order_code_revealed',
  ORDER_EVIDENCE_UPLOADED = 'order_evidence_uploaded',
  ORDER_EVIDENCE_VIEWED = 'order_evidence_viewed',
  ORDER_DRIVER_ARRIVED = 'order_driver_arrived',
  ORDER_CHAT_MESSAGE = 'order_chat_message',
  ORDER_CHAT_READ_BY_ADMIN = 'order_chat_read_by_admin',
  ORDER_CALL_STARTED = 'order_call_started',
  ORDER_CALL_ENDED = 'order_call_ended',

  // Financial events
  PAYMENT_PROCESSED = 'payment_processed',
  PAYMENT_METHOD_CHANGED = 'payment_method_changed',
  // El efectivo lo recibe una persona, no una pasarela: la única prueba
  // de que ese dinero cambió de manos es este registro. Va aparte de
  // PAYMENT_PROCESSED porque es lo primero que se audita ante un faltante.
  CASH_COLLECTION_CONFIRMED = 'cash_collection_confirmed',
  CASH_COLLECTION_DISPUTED = 'cash_collection_disputed',
  CASH_COLLECTION_BLOCKED = 'cash_collection_blocked',
  CASH_INCIDENT_REVIEWED = 'cash_incident_reviewed',
  CASH_INCIDENT_RESOLVED = 'cash_incident_resolved',
  CASH_DEBT_LIMIT_BLOCKED = 'cash_debt_limit_blocked',
  REFUND_ISSUED = 'refund_issued',
  COMMISSION_ADJUSTED = 'commission_adjusted',
  PAYOUT_PROCESSED = 'payout_processed',

  // Business events
  BUSINESS_CREATED = 'business_created',
  BUSINESS_UPDATED = 'business_updated',
  BUSINESS_DEACTIVATED = 'business_deactivated',

  // Driver events
  DRIVER_APPROVED = 'driver_approved',
  DRIVER_SUSPENDED = 'driver_suspended',
  DRIVER_VERIFICATION = 'driver_verification',

  // Security events
  BRUTE_FORCE_DETECTED = 'brute_force_detected',
  SUSPICIOUS_ACTIVITY = 'suspicious_activity',
  ACCOUNT_LOCKED = 'account_locked',
  ACCOUNT_UNLOCKED = 'account_unlocked',
  FRAUD_ALERT = 'fraud_alert',

  // Data events
  RECORD_DELETED = 'record_deleted',
  PERMISSION_CHANGED = 'permission_changed',
  SETTINGS_CHANGED = 'settings_changed',
  PROMOTION_CREATED = 'promotion_created',
  PROMOTION_UPDATED = 'promotion_updated',
  AD_CAMPAIGN_CREATED = 'ad_campaign_created',
  AD_CAMPAIGN_UPDATED = 'ad_campaign_updated',
  AD_CAMPAIGN_CANCELLED = 'ad_campaign_cancelled',
  AD_CAMPAIGN_DELETED = 'ad_campaign_deleted',
  PROMO_BANNER_CREATED = 'promo_banner_created',
  PROMO_BANNER_UPDATED = 'promo_banner_updated',
  PROMO_BANNER_DELETED = 'promo_banner_deleted',
  PROMO_BANNER_REORDERED = 'promo_banner_reordered',
  CURATED_HOME_BLOCK_CREATED = 'curated_home_block_created',
  CURATED_HOME_BLOCK_UPDATED = 'curated_home_block_updated',
  CURATED_HOME_BLOCK_DELETED = 'curated_home_block_deleted',
  DOCUMENT_REVIEWED = 'document_reviewed',
  PQRS_ANSWERED = 'pqrs_answered',
  DATA_REQUEST_RESOLVED = 'data_request_resolved',
}

export enum AuditSeverity {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
  CRITICAL = 'critical',
}

export interface IAuditLog extends Document {
  userId?: string;
  role?: string;
  action: AuditAction;
  entity: string;
  entityId?: string;
  severity: AuditSeverity;
  description: string;
  ip: string;
  userAgent: string;
  metadata?: Record<string, any>;
  sessionId?: string;
  timestamp: Date;
}

const auditLogSchema = new Schema<IAuditLog>(
  {
    userId: { type: String, index: true },
    role: { type: String },
    action: {
      type: String,
      enum: Object.values(AuditAction),
      required: true,
      index: true,
    },
    entity: { type: String, required: true, index: true },
    entityId: { type: String },
    severity: {
      type: String,
      enum: Object.values(AuditSeverity),
      default: AuditSeverity.LOW,
    },
    description: { type: String, required: true },
    ip: { type: String, required: true },
    userAgent: { type: String, default: 'unknown' },
    metadata: { type: Schema.Types.Mixed },
    sessionId: { type: String },
    timestamp: { type: Date, default: Date.now, index: true },
  },
  {
    timestamps: false,
    capped: { size: 1073741824, max: 5000000 }, // 1GB cap, 5M docs max
  }
);

// Compound indexes for efficient queries
auditLogSchema.index({ userId: 1, timestamp: -1 });
auditLogSchema.index({ action: 1, timestamp: -1 });
auditLogSchema.index({ severity: 1, timestamp: -1 });
auditLogSchema.index({ entity: 1, entityId: 1, timestamp: -1 });

export const AuditLog = mongoose.model<IAuditLog>('AuditLog', auditLogSchema);

// ── Audit Logger Service ──

function getClientIP(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') return forwarded.split(',')[0].trim();
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

interface AuditEntry {
  action: AuditAction;
  entity: string;
  entityId?: string;
  severity?: AuditSeverity;
  description: string;
  metadata?: Record<string, any>;
  userId?: string;
  role?: string;
}

export async function logAudit(req: Request, entry: AuditEntry): Promise<void> {
  try {
    const user = (req as any).user;
    await AuditLog.create({
      userId: entry.userId || user?._id?.toString(),
      role: entry.role || user?.role,
      action: entry.action,
      entity: entry.entity,
      entityId: entry.entityId,
      severity: entry.severity || AuditSeverity.LOW,
      description: entry.description,
      ip: getClientIP(req),
      userAgent: req.headers['user-agent'] || 'unknown',
      metadata: {
        ...entry.metadata,
        method: req.method,
        path: req.originalUrl,
      },
      sessionId: (req as any).sessionId,
    });
  } catch (error) {
    // Audit logging should never break the app
    console.error('[AUDIT] Failed to write audit log:', error);
  }
}

/**
 * Log audit without request context (for system events)
 */
export async function logSystemAudit(entry: AuditEntry): Promise<void> {
  try {
    await AuditLog.create({
      userId: entry.userId || 'system',
      role: entry.role || 'system',
      action: entry.action,
      entity: entry.entity,
      entityId: entry.entityId,
      severity: entry.severity || AuditSeverity.LOW,
      description: entry.description,
      ip: 'system',
      userAgent: 'system',
      metadata: entry.metadata,
    });
  } catch (error) {
    console.error('[AUDIT] Failed to write system audit log:', error);
  }
}
