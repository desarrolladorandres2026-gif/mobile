/**
 * Lo que devuelve `/admin/businesses/:id/security/*`
 * (backend: `services/businessSecurity.service.ts`). Ningún campo trae
 * tokens ni hashes; el identificador de dispositivo llega recortado.
 */

export type BusinessRole = 'owner' | 'manager' | 'operator' | 'cashier';
export type SessionStatus = 'active' | 'revoked' | 'expired';
export type EventResult = 'success' | 'failure' | 'info';

export interface MemberRef {
  id: string;
  name: string;
  email: string | null;
  businessRole: BusinessRole | null;
}

export interface SecurityEventRow {
  id: string;
  type: string;
  result: EventResult;
  createdAt: string;
  ip: string;
  device: { platform?: string; os?: string; browser?: string; browserVersion?: string } | null;
  deviceShortId: string | null;
  sessionId: string | null;
  reason: string | null;
  note: string | null;
  user: MemberRef;
  actor: { id: string; name: string } | null;
  metadata: Record<string, unknown>;
}

export interface SecuritySummary {
  business: { id: string; name: string; panelSeenAt: string | null };
  /** Sesiones abiertas ahora mismo desde Zipp Negocios (la app de escritorio). */
  installations: Array<{ userId: string; name: string | null; appVersion: string; lastActivity: string }>;
  activeSessions: number;
  unknownActiveSessions: number;
  knownDevices: number;
  newDevices30d: number;
  failedAttempts7d: number;
  lastSuccessfulLogin: SecurityEventRow | null;
  lastSecurityEvent: SecurityEventRow | null;
  members: Array<{
    userId: string;
    name: string;
    email: string | null;
    businessRole: BusinessRole;
    accountRole: string;
    twoFactorEnabled: boolean;
    passwordChangedAt: string | null;
    lastLoginAt: string | null;
  }>;
}

export interface DeviceInfo {
  recordId: string | null;
  shortId: string | null;
  identified: boolean;
  isNew: boolean;
  platform: string;
  os: string;
  osVersion: string | null;
  browser: string;
  browserVersion: string | null;
}

export interface SessionRow {
  id: string;
  user: MemberRef;
  device: DeviceInfo;
  ip: string;
  lastIp: string;
  createdAt: string;
  lastActivity: string;
  expiresAt: string;
  status: SessionStatus;
  mfa: boolean;
  authMethod: string | null;
  revokedAt: string | null;
  revokedReason: string | null;
  revokedBy: { id: string; name: string } | null;
}

export interface DeviceRow {
  id: string;
  shortId: string | null;
  identified: boolean;
  isNew: boolean;
  trusted: boolean;
  platform: string;
  os: string;
  osVersion: string | null;
  browser: string;
  browserVersion: string | null;
  firstSeen: string;
  lastSeen: string;
  firstIp: string | null;
  lastIp: string | null;
  loginCount: number;
  activeSessions: number;
  user: MemberRef;
}

export interface PageInfo {
  page: number;
  limit: number;
  total: number;
  pages: number;
}

export interface SessionFilters {
  status: 'active' | 'revoked' | 'expired' | 'all';
  userId: string;
  search: string;
  ip: string;
  from: string;
  to: string;
  unidentified: boolean;
}

export interface EventFilters {
  type: string;
  userId: string;
  ip: string;
  from: string;
  to: string;
}
