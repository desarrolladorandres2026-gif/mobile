import mongoose, { Schema, Document } from 'mongoose';
import crypto from 'crypto';

// ── Session Model ──

export interface ISession extends Document {
  userId: string;
  tokenHash: string;          // SHA256 hash of refresh token
  deviceId: string;
  deviceInfo: {
    platform: string;
    os: string;
    browser: string;
    appVersion?: string;
  };
  ip: string;
  userAgent: string;
  location?: {
    lat: number;
    lng: number;
    city?: string;
  };
  isActive: boolean;
  lastActivity: Date;
  createdAt: Date;
  expiresAt: Date;
}

const sessionSchema = new Schema<ISession>(
  {
    userId: { type: String, required: true, index: true },
    tokenHash: { type: String, required: true, unique: true },
    deviceId: { type: String, required: true },
    deviceInfo: {
      platform: { type: String, default: 'unknown' },
      os: { type: String, default: 'unknown' },
      browser: { type: String, default: 'unknown' },
      appVersion: { type: String },
    },
    ip: { type: String, required: true },
    userAgent: { type: String, default: 'unknown' },
    location: {
      lat: { type: Number },
      lng: { type: Number },
      city: { type: String },
    },
    isActive: { type: Boolean, default: true },
    lastActivity: { type: Date, default: Date.now },
    expiresAt: { type: Date, required: true, index: { expireAfterSeconds: 0 } },
  },
  { timestamps: true }
);

sessionSchema.index({ userId: 1, isActive: 1 });
sessionSchema.index({ userId: 1, deviceId: 1 });

export const Session = mongoose.model<ISession>('Session', sessionSchema);

// ── Device Fingerprint Model ──

export interface IDeviceFingerprint extends Document {
  userId: string;
  deviceId: string;
  fingerprint: string;
  isTrusted: boolean;
  firstSeen: Date;
  lastSeen: Date;
  loginCount: number;
  metadata: Record<string, any>;
}

const deviceFingerprintSchema = new Schema<IDeviceFingerprint>(
  {
    userId: { type: String, required: true, index: true },
    deviceId: { type: String, required: true },
    fingerprint: { type: String, required: true },
    isTrusted: { type: Boolean, default: false },
    firstSeen: { type: Date, default: Date.now },
    lastSeen: { type: Date, default: Date.now },
    loginCount: { type: Number, default: 1 },
    metadata: { type: Schema.Types.Mixed },
  },
  { timestamps: true }
);

deviceFingerprintSchema.index({ userId: 1, deviceId: 1 }, { unique: true });

export const DeviceFingerprint = mongoose.model<IDeviceFingerprint>(
  'DeviceFingerprint',
  deviceFingerprintSchema
);

// ── Session Management Service ──

/**
 * Parse User-Agent for device info
 */
function parseUserAgent(ua: string): ISession['deviceInfo'] {
  const info: ISession['deviceInfo'] = {
    platform: 'unknown',
    os: 'unknown',
    browser: 'unknown',
  };

  // Detect platform
  if (/mobile|android|iphone|ipad/i.test(ua)) info.platform = 'mobile';
  else if (/tablet/i.test(ua)) info.platform = 'tablet';
  else info.platform = 'desktop';

  // Detect OS
  if (/android/i.test(ua)) info.os = 'Android';
  else if (/iphone|ipad|ipod/i.test(ua)) info.os = 'iOS';
  else if (/windows/i.test(ua)) info.os = 'Windows';
  else if (/mac/i.test(ua)) info.os = 'macOS';
  else if (/linux/i.test(ua)) info.os = 'Linux';

  // Detect browser
  if (/expo/i.test(ua)) info.browser = 'Expo';
  else if (/chrome/i.test(ua)) info.browser = 'Chrome';
  else if (/firefox/i.test(ua)) info.browser = 'Firefox';
  else if (/safari/i.test(ua)) info.browser = 'Safari';
  else if (/edge/i.test(ua)) info.browser = 'Edge';

  return info;
}

/**
 * Generate device ID from request info
 */
export function generateDeviceId(userAgent: string, ip: string, extraData?: string): string {
  const data = `${userAgent}|${extraData || 'default'}`;
  return crypto.createHash('sha256').update(data).digest('hex').substring(0, 32);
}

/**
 * Hash a token for storage
 */
function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export class SessionManager {
  /**
   * Create a new session for a user
   */
  async createSession(
    userId: string,
    refreshToken: string,
    ip: string,
    userAgent: string,
    deviceId?: string
  ): Promise<{ session: ISession; isNewDevice: boolean }> {
    const tokenHash = hashToken(refreshToken);
    const actualDeviceId = deviceId || generateDeviceId(userAgent, ip);
    const deviceInfo = parseUserAgent(userAgent);

    // Check if this is a new device
    let isNewDevice = false;
    const existingDevice = await DeviceFingerprint.findOne({
      userId,
      deviceId: actualDeviceId,
    });

    if (!existingDevice) {
      isNewDevice = true;
      await DeviceFingerprint.create({
        userId,
        deviceId: actualDeviceId,
        fingerprint: hashToken(userAgent + ip),
        isTrusted: false,
        loginCount: 1,
      });
    } else {
      existingDevice.lastSeen = new Date();
      existingDevice.loginCount += 1;
      await existingDevice.save();
    }

    // Create session (7 days expiry)
    const session = await Session.create({
      userId,
      tokenHash,
      deviceId: actualDeviceId,
      deviceInfo,
      ip,
      userAgent,
      isActive: true,
      lastActivity: new Date(),
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });

    return { session, isNewDevice };
  }

  /**
   * Validate and rotate a refresh token (Refresh Token Rotation)
   */
  async rotateRefreshToken(
    oldRefreshToken: string,
    newRefreshToken: string
  ): Promise<ISession | null> {
    const oldHash = hashToken(oldRefreshToken);
    const newHash = hashToken(newRefreshToken);

    const session = await Session.findOne({ tokenHash: oldHash, isActive: true });
    if (!session) {
      // Token reuse detected! Revoke ALL sessions for this user (security breach)
      const compromised = await Session.findOne({ tokenHash: oldHash });
      if (compromised) {
        await Session.updateMany(
          { userId: compromised.userId },
          { isActive: false }
        );
        console.error(`[SECURITY] Refresh token reuse detected for user ${compromised.userId}. All sessions revoked.`);
      }
      return null;
    }

    session.tokenHash = newHash;
    session.lastActivity = new Date();
    session.expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await session.save();

    return session;
  }

  /**
   * Revoke a specific session
   */
  async revokeSession(sessionId: string, userId: string): Promise<boolean> {
    const result = await Session.findOneAndUpdate(
      { _id: sessionId, userId },
      { isActive: false }
    );
    return !!result;
  }

  /**
   * Revoke all sessions for a user (except current)
   */
  async revokeAllSessions(userId: string, exceptTokenHash?: string): Promise<number> {
    const filter: any = { userId, isActive: true };
    if (exceptTokenHash) {
      filter.tokenHash = { $ne: hashToken(exceptTokenHash) };
    }
    const result = await Session.updateMany(filter, { isActive: false });
    return result.modifiedCount;
  }

  /**
   * Get active sessions for a user
   */
  async getActiveSessions(userId: string): Promise<any[]> {
    return Session.find({ userId, isActive: true })
      .sort({ lastActivity: -1 })
      .lean();
  }

  /**
   * Check for simultaneous usage (different IPs at the same time)
   */
  async checkSimultaneousUsage(userId: string, currentIp: string): Promise<boolean> {
    const recentSessions = await Session.find({
      userId,
      isActive: true,
      lastActivity: { $gte: new Date(Date.now() - 5 * 60 * 1000) }, // Last 5 min
      ip: { $ne: currentIp },
    });
    return recentSessions.length > 0;
  }

  /**
   * Get user's registered devices
   */
  async getUserDevices(userId: string): Promise<any[]> {
    return DeviceFingerprint.find({ userId }).sort({ lastSeen: -1 }).lean();
  }

  /**
   * Trust a device
   */
  async trustDevice(userId: string, deviceId: string): Promise<boolean> {
    const result = await DeviceFingerprint.findOneAndUpdate(
      { userId, deviceId },
      { isTrusted: true }
    );
    return !!result;
  }

  /**
   * Remove a device
   */
  async removeDevice(userId: string, deviceId: string): Promise<boolean> {
    // Revoke all sessions from this device
    await Session.updateMany({ userId, deviceId }, { isActive: false });
    const result = await DeviceFingerprint.findOneAndDelete({ userId, deviceId });
    return !!result;
  }
}

export const sessionManager = new SessionManager();
