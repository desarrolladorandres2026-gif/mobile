import mongoose, { Schema, Document } from 'mongoose';

// ── Risk Score Levels ──
export enum RiskLevel {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
  CRITICAL = 'critical',
}

export enum FraudAlertStatus {
  OPEN = 'open',
  INVESTIGATING = 'investigating',
  RESOLVED = 'resolved',
  DISMISSED = 'dismissed',
}

export enum FraudAlertType {
  MULTIPLE_ACCOUNTS_DEVICE = 'multiple_accounts_device',
  SIMULTANEOUS_USAGE = 'simultaneous_usage',
  MOCK_LOCATION = 'mock_location',
  SUSPICIOUS_LOCATION_CHANGE = 'suspicious_location_change',
  PROMOTION_ABUSE = 'promotion_abuse',
  MASS_ACCOUNT_CREATION = 'mass_account_creation',
  AUTOMATED_ACTIVITY = 'automated_activity',
  DEVICE_CHANGE = 'device_change',
  UNUSUAL_ORDER_PATTERN = 'unusual_order_pattern',
  VELOCITY_ANOMALY = 'velocity_anomaly',
}

// ── Fraud Alert Model ──

export interface IFraudAlert extends Document {
  userId: string;
  type: FraudAlertType;
  status: FraudAlertStatus;
  riskLevel: RiskLevel;
  riskScore: number;
  description: string;
  evidence: Record<string, any>;
  actionTaken?: string;
  resolvedBy?: string;
  resolvedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const fraudAlertSchema = new Schema<IFraudAlert>(
  {
    userId: { type: String, required: true, index: true },
    type: {
      type: String,
      enum: Object.values(FraudAlertType),
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: Object.values(FraudAlertStatus),
      default: FraudAlertStatus.OPEN,
      index: true,
    },
    riskLevel: {
      type: String,
      enum: Object.values(RiskLevel),
      required: true,
    },
    riskScore: { type: Number, required: true, min: 0, max: 100 },
    description: { type: String, required: true },
    evidence: { type: Schema.Types.Mixed },
    actionTaken: { type: String },
    resolvedBy: { type: String },
    resolvedAt: { type: Date },
  },
  { timestamps: true }
);

fraudAlertSchema.index({ status: 1, riskLevel: 1, createdAt: -1 });
fraudAlertSchema.index({ userId: 1, createdAt: -1 });

export const FraudAlert = mongoose.model<IFraudAlert>('FraudAlert', fraudAlertSchema);

// ── User Risk Score Model ──

export interface IUserRiskProfile extends Document {
  userId: string;
  riskScore: number;
  riskLevel: RiskLevel;
  factors: {
    multipleDevices: number;
    failedLogins: number;
    locationAnomalies: number;
    promotionUsage: number;
    accountAge: number;
    orderPatterns: number;
  };
  isBlocked: boolean;
  blockedReason?: string;
  blockedAt?: Date;
  lastAssessment: Date;
  alertCount: number;
}

const userRiskProfileSchema = new Schema<IUserRiskProfile>(
  {
    userId: { type: String, required: true, unique: true },
    riskScore: { type: Number, default: 0, min: 0, max: 100 },
    riskLevel: {
      type: String,
      enum: Object.values(RiskLevel),
      default: RiskLevel.LOW,
    },
    factors: {
      multipleDevices: { type: Number, default: 0 },
      failedLogins: { type: Number, default: 0 },
      locationAnomalies: { type: Number, default: 0 },
      promotionUsage: { type: Number, default: 0 },
      accountAge: { type: Number, default: 0 },
      orderPatterns: { type: Number, default: 0 },
    },
    isBlocked: { type: Boolean, default: false },
    blockedReason: { type: String },
    blockedAt: { type: Date },
    lastAssessment: { type: Date, default: Date.now },
    alertCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

export const UserRiskProfile = mongoose.model<IUserRiskProfile>(
  'UserRiskProfile',
  userRiskProfileSchema
);

// ── Antifraude Service ──

// Track IP-to-account mappings
const ipAccountMap = new Map<string, Set<string>>();
const deviceAccountMap = new Map<string, Set<string>>();

export class AntiFraudService {
  /**
   * Check for multiple accounts from same device
   */
  async checkMultipleAccounts(
    userId: string,
    deviceId: string,
    ip: string
  ): Promise<{ suspicious: boolean; alert?: Partial<IFraudAlert> }> {
    // Track device-to-account mapping
    if (!deviceAccountMap.has(deviceId)) {
      deviceAccountMap.set(deviceId, new Set());
    }
    deviceAccountMap.get(deviceId)!.add(userId);

    // Track IP-to-account mapping
    if (!ipAccountMap.has(ip)) {
      ipAccountMap.set(ip, new Set());
    }
    ipAccountMap.get(ip)!.add(userId);

    const deviceAccounts = deviceAccountMap.get(deviceId)!;
    const ipAccounts = ipAccountMap.get(ip)!;

    if (deviceAccounts.size > 2) {
      return {
        suspicious: true,
        alert: {
          userId,
          type: FraudAlertType.MULTIPLE_ACCOUNTS_DEVICE,
          riskLevel: RiskLevel.HIGH,
          riskScore: 75,
          description: `${deviceAccounts.size} cuentas detectadas desde el mismo dispositivo`,
          evidence: {
            deviceId,
            accountIds: Array.from(deviceAccounts),
            ip,
          },
        },
      };
    }

    if (ipAccounts.size > 5) {
      return {
        suspicious: true,
        alert: {
          userId,
          type: FraudAlertType.MASS_ACCOUNT_CREATION,
          riskLevel: RiskLevel.MEDIUM,
          riskScore: 60,
          description: `${ipAccounts.size} cuentas detectadas desde la misma IP`,
          evidence: { ip, accountCount: ipAccounts.size },
        },
      };
    }

    return { suspicious: false };
  }

  /**
   * Detect mock/fake GPS location
   */
  async checkMockLocation(
    userId: string,
    lat: number,
    lng: number,
    accuracy: number,
    isMocked?: boolean
  ): Promise<{ suspicious: boolean; alert?: Partial<IFraudAlert> }> {
    // Direct mock flag from device
    if (isMocked) {
      return {
        suspicious: true,
        alert: {
          userId,
          type: FraudAlertType.MOCK_LOCATION,
          riskLevel: RiskLevel.CRITICAL,
          riskScore: 95,
          description: 'Ubicación GPS falsa detectada (mock location activo)',
          evidence: { lat, lng, accuracy, isMocked },
        },
      };
    }

    // Suspiciously low accuracy can indicate spoofing
    if (accuracy < 1) {
      return {
        suspicious: true,
        alert: {
          userId,
          type: FraudAlertType.MOCK_LOCATION,
          riskLevel: RiskLevel.HIGH,
          riskScore: 80,
          description: 'Precisión GPS sospechosamente alta (posible spoofing)',
          evidence: { lat, lng, accuracy },
        },
      };
    }

    return { suspicious: false };
  }

  /**
   * Check for suspicious location jumps (teleporting)
   */
  async checkLocationVelocity(
    userId: string,
    newLat: number,
    newLng: number,
    lastLat: number,
    lastLng: number,
    timeDiffSeconds: number
  ): Promise<{ suspicious: boolean; alert?: Partial<IFraudAlert> }> {
    if (timeDiffSeconds <= 0) return { suspicious: false };

    // Calculate distance in km using Haversine formula
    const R = 6371;
    const dLat = ((newLat - lastLat) * Math.PI) / 180;
    const dLng = ((newLng - lastLng) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos((lastLat * Math.PI) / 180) *
        Math.cos((newLat * Math.PI) / 180) *
        Math.sin(dLng / 2) *
        Math.sin(dLng / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    const distanceKm = R * c;

    // Speed in km/h
    const speedKmH = (distanceKm / timeDiffSeconds) * 3600;

    // More than 200 km/h is suspicious for a delivery driver
    if (speedKmH > 200) {
      return {
        suspicious: true,
        alert: {
          userId,
          type: FraudAlertType.SUSPICIOUS_LOCATION_CHANGE,
          riskLevel: RiskLevel.HIGH,
          riskScore: 85,
          description: `Cambio de ubicación sospechoso: ${distanceKm.toFixed(1)}km en ${timeDiffSeconds}s (${speedKmH.toFixed(0)}km/h)`,
          evidence: {
            fromLat: lastLat,
            fromLng: lastLng,
            toLat: newLat,
            toLng: newLng,
            distanceKm,
            speedKmH,
            timeDiffSeconds,
          },
        },
      };
    }

    return { suspicious: false };
  }

  /**
   * Detect automated activity (bot detection)
   */
  async checkAutomatedActivity(
    userId: string,
    requestTimestamps: number[]
  ): Promise<{ suspicious: boolean; alert?: Partial<IFraudAlert> }> {
    if (requestTimestamps.length < 10) return { suspicious: false };

    // Check for perfectly regular intervals (bots)
    const intervals: number[] = [];
    for (let i = 1; i < requestTimestamps.length; i++) {
      intervals.push(requestTimestamps[i] - requestTimestamps[i - 1]);
    }

    const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    const variance =
      intervals.reduce((sum, i) => sum + Math.pow(i - avgInterval, 2), 0) / intervals.length;
    const stdDev = Math.sqrt(variance);

    // Very low variance = likely automated
    if (stdDev < 50 && avgInterval < 1000) {
      return {
        suspicious: true,
        alert: {
          userId,
          type: FraudAlertType.AUTOMATED_ACTIVITY,
          riskLevel: RiskLevel.HIGH,
          riskScore: 80,
          description: 'Patrón de actividad automatizada detectado',
          evidence: {
            avgInterval,
            stdDev,
            requestCount: requestTimestamps.length,
          },
        },
      };
    }

    return { suspicious: false };
  }

  /**
   * Calculate overall risk score for a user
   */
  async assessUserRisk(userId: string): Promise<IUserRiskProfile> {
    let profile = await UserRiskProfile.findOne({ userId });

    if (!profile) {
      profile = await UserRiskProfile.create({ userId });
    }

    // Count open/recent alerts
    const alertCount = await FraudAlert.countDocuments({
      userId,
      status: { $in: [FraudAlertStatus.OPEN, FraudAlertStatus.INVESTIGATING] },
    });

    // Calculate weighted risk score
    const factors = profile.factors;
    const weightedScore =
      factors.multipleDevices * 15 +
      factors.failedLogins * 10 +
      factors.locationAnomalies * 20 +
      factors.promotionUsage * 10 +
      factors.orderPatterns * 15 +
      alertCount * 5;

    const riskScore = Math.min(100, weightedScore);
    let riskLevel: RiskLevel;

    if (riskScore >= 80) riskLevel = RiskLevel.CRITICAL;
    else if (riskScore >= 60) riskLevel = RiskLevel.HIGH;
    else if (riskScore >= 30) riskLevel = RiskLevel.MEDIUM;
    else riskLevel = RiskLevel.LOW;

    profile.riskScore = riskScore;
    profile.riskLevel = riskLevel;
    profile.alertCount = alertCount;
    profile.lastAssessment = new Date();

    // Auto-block for critical risk
    if (riskLevel === RiskLevel.CRITICAL && !profile.isBlocked) {
      profile.isBlocked = true;
      profile.blockedReason = 'Bloqueado automáticamente por riesgo crítico';
      profile.blockedAt = new Date();
    }

    await profile.save();
    return profile;
  }

  /**
   * Create a fraud alert
   */
  async createAlert(alertData: Partial<IFraudAlert>): Promise<IFraudAlert> {
    const alert = await FraudAlert.create(alertData);

    // Update risk profile
    if (alertData.userId) {
      await this.assessUserRisk(alertData.userId);
    }

    return alert;
  }

  /**
   * Resolve a fraud alert
   */
  async resolveAlert(
    alertId: string,
    resolvedBy: string,
    actionTaken: string,
    status: FraudAlertStatus = FraudAlertStatus.RESOLVED
  ): Promise<IFraudAlert | null> {
    return FraudAlert.findByIdAndUpdate(
      alertId,
      {
        status,
        resolvedBy,
        resolvedAt: new Date(),
        actionTaken,
      },
      { new: true }
    );
  }

  /**
   * Get alerts with filters
   */
  async getAlerts(filters: {
    status?: FraudAlertStatus;
    riskLevel?: RiskLevel;
    type?: FraudAlertType;
    userId?: string;
    page?: number;
    limit?: number;
  }): Promise<{ alerts: any[]; total: number }> {
    const query: any = {};
    if (filters.status) query.status = filters.status;
    if (filters.riskLevel) query.riskLevel = filters.riskLevel;
    if (filters.type) query.type = filters.type;
    if (filters.userId) query.userId = filters.userId;

    const page = filters.page || 1;
    const limit = filters.limit || 20;
    const skip = (page - 1) * limit;

    const [alerts, total] = await Promise.all([
      FraudAlert.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      FraudAlert.countDocuments(query),
    ]);

    return { alerts, total };
  }
}

export const antiFraudService = new AntiFraudService();
