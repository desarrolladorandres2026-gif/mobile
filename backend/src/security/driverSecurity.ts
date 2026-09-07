import mongoose, { Schema, Document } from 'mongoose';

// ── Driver Verification Model ──

export enum VerificationType {
  DOCUMENT_ID = 'document_id',
  SELFIE = 'selfie',
  PROFILE_PHOTO = 'profile_photo',
  BIOMETRIC = 'biometric',
  RANDOM_SELFIE = 'random_selfie',
}

export enum VerificationStatus {
  PENDING = 'pending',
  APPROVED = 'approved',
  REJECTED = 'rejected',
  EXPIRED = 'expired',
}

export interface IDriverVerification extends Document {
  driverId: string;
  userId: string;
  type: VerificationType;
  status: VerificationStatus;
  imageUrl: string;
  reviewedBy?: string;
  reviewedAt?: Date;
  rejectionReason?: string;
  metadata?: Record<string, any>;
  expiresAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const driverVerificationSchema = new Schema<IDriverVerification>(
  {
    driverId: { type: String, required: true, index: true },
    userId: { type: String, required: true },
    type: {
      type: String,
      enum: Object.values(VerificationType),
      required: true,
    },
    status: {
      type: String,
      enum: Object.values(VerificationStatus),
      default: VerificationStatus.PENDING,
    },
    imageUrl: { type: String, required: true },
    reviewedBy: { type: String },
    reviewedAt: { type: Date },
    rejectionReason: { type: String },
    metadata: { type: Schema.Types.Mixed },
    expiresAt: { type: Date },
  },
  { timestamps: true }
);

driverVerificationSchema.index({ driverId: 1, type: 1, status: 1 });

export const DriverVerification = mongoose.model<IDriverVerification>(
  'DriverVerification',
  driverVerificationSchema
);

// ── Driver Location Log ──

export interface IDriverLocationLog extends Document {
  driverId: string;
  lat: number;
  lng: number;
  accuracy: number;
  speed?: number;
  heading?: number;
  isMocked: boolean;
  timestamp: Date;
}

const driverLocationLogSchema = new Schema<IDriverLocationLog>(
  {
    driverId: { type: String, required: true, index: true },
    lat: { type: Number, required: true },
    lng: { type: Number, required: true },
    accuracy: { type: Number, required: true },
    speed: { type: Number },
    heading: { type: Number },
    isMocked: { type: Boolean, default: false },
    timestamp: { type: Date, default: Date.now },
  },
  { timestamps: false }
);

// TTL index - auto-delete after 30 days
driverLocationLogSchema.index({ timestamp: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });
driverLocationLogSchema.index({ driverId: 1, timestamp: -1 });

export const DriverLocationLog = mongoose.model<IDriverLocationLog>(
  'DriverLocationLog',
  driverLocationLogSchema
);

// ── Driver Security Service ──

export class DriverSecurityService {
  /**
   * Submit verification document
   */
  async submitVerification(
    driverId: string,
    userId: string,
    type: VerificationType,
    imageUrl: string,
    metadata?: Record<string, any>
  ): Promise<IDriverVerification> {
    // Invalidate previous verification of same type
    await DriverVerification.updateMany(
      { driverId, type, status: VerificationStatus.PENDING },
      { status: VerificationStatus.EXPIRED }
    );

    return DriverVerification.create({
      driverId,
      userId,
      type,
      imageUrl,
      metadata,
      expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000), // 90 days
    });
  }

  /**
   * Review a verification
   */
  async reviewVerification(
    verificationId: string,
    reviewedBy: string,
    approved: boolean,
    rejectionReason?: string
  ): Promise<IDriverVerification | null> {
    return DriverVerification.findByIdAndUpdate(
      verificationId,
      {
        status: approved ? VerificationStatus.APPROVED : VerificationStatus.REJECTED,
        reviewedBy,
        reviewedAt: new Date(),
        rejectionReason,
      },
      { new: true }
    );
  }

  /**
   * Check if driver has all required verifications
   */
  async hasRequiredVerifications(driverId: string): Promise<{
    complete: boolean;
    missing: VerificationType[];
  }> {
    const required = [
      VerificationType.DOCUMENT_ID,
      VerificationType.SELFIE,
      VerificationType.PROFILE_PHOTO,
    ];

    const approved = await DriverVerification.find({
      driverId,
      status: VerificationStatus.APPROVED,
      type: { $in: required },
      $or: [
        { expiresAt: { $gt: new Date() } },
        { expiresAt: null },
      ],
    }).distinct('type');

    const missing = required.filter((r) => !approved.includes(r));

    return {
      complete: missing.length === 0,
      missing,
    };
  }

  /**
   * Request random selfie verification during operation
   */
  async requestRandomVerification(driverId: string): Promise<boolean> {
    // Check if there's already a pending random verification
    const existing = await DriverVerification.findOne({
      driverId,
      type: VerificationType.RANDOM_SELFIE,
      status: VerificationStatus.PENDING,
    });

    if (existing) return false;

    // Will be fulfilled when driver submits selfie
    return true;
  }

  /**
   * Log driver location
   */
  async logLocation(
    driverId: string,
    lat: number,
    lng: number,
    accuracy: number,
    speed?: number,
    heading?: number,
    isMocked?: boolean
  ): Promise<void> {
    await DriverLocationLog.create({
      driverId,
      lat,
      lng,
      accuracy,
      speed,
      heading,
      isMocked: isMocked || false,
    });
  }

  /**
   * Get driver's recent location history
   */
  async getLocationHistory(
    driverId: string,
    minutes: number = 60
  ): Promise<any[]> {
    return DriverLocationLog.find({
      driverId,
      timestamp: { $gte: new Date(Date.now() - minutes * 60 * 1000) },
    })
      .sort({ timestamp: -1 })
      .lean();
  }

  /**
   * Get verification status for a driver
   */
  async getVerificationStatus(driverId: string): Promise<any[]> {
    return DriverVerification.find({ driverId })
      .sort({ createdAt: -1 })
      .lean();
  }
}

export const driverSecurityService = new DriverSecurityService();
