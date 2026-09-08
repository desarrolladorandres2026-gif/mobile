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
  /** La plataforma la pidió y el domiciliario todavía no ha mandado nada. */
  REQUESTED = 'requested',
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
  /** Ausente mientras la verificación está solicitada y sin responder. */
  imageUrl?: string;
  /** Plazo para responder una verificación solicitada. */
  dueAt?: Date;
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
    // No es obligatoria: una verificación solicitada existe antes de que
    // haya foto, y es justo ese hueco —pedida y sin responder— el que
    // permite exigirla.
    imageUrl: { type: String },
    dueAt: { type: Date },
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
   * Sube la selfie y la deja pendiente de revisión, en un solo paso.
   *
   * Va a una carpeta aparte de los avatares: esta foto no es la imagen
   * pública de nadie, es una prueba de identidad que se pidió por sospecha
   * y que solo debería ver quien la revisa.
   */
  async fulfillWithImage(
    driverId: string,
    type: VerificationType,
    buffer: Buffer,
    metadata?: Record<string, any>
  ): Promise<IDriverVerification | null> {
    const { cloudinary } = await import('../config');

    const url = await new Promise<string>((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder: 'zipp/verifications',
          resource_type: 'image',
          transformation: [
            { width: 800, height: 800, crop: 'limit' },
            { quality: 'auto', fetch_format: 'auto' },
          ],
        },
        (error: unknown, result: { secure_url: string } | undefined) => {
          if (error || !result) {
            reject(new Error('No se pudo subir la imagen'));
            return;
          }
          resolve(result.secure_url);
        }
      );
      stream.end(buffer);
    });

    return this.fulfillVerification(driverId, type, url, metadata);
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
   * Pide una verificación en mitad del turno.
   *
   * Existe para responder una pregunta que las verificaciones del alta no
   * pueden: la cuenta se aprobó una vez, pero ¿quién conduce la moto hoy?
   * Prestar la cuenta a un tercero sin documentos ni antecedentes es el
   * fraude más fácil de esta operación, y el único momento en que se puede
   * detectar es mientras está ocurriendo.
   *
   * Crea la solicitud de verdad, con su plazo. La versión anterior de este
   * método solo miraba si ya había una pendiente y devolvía un booleano sin
   * escribir nada: nadie podía enterarse de que se le había pedido algo.
   */
  async requestVerification(
    driverId: string,
    userId: string,
    type: VerificationType = VerificationType.RANDOM_SELFIE,
    windowMinutes = 15
  ): Promise<IDriverVerification | null> {
    // Una sola a la vez. Acumular solicitudes sin responder no aporta
    // información nueva y convierte el bloqueo en algo imposible de
    // resolver para quien lo sufre.
    const existing = await DriverVerification.findOne({
      driverId,
      type,
      status: { $in: [VerificationStatus.REQUESTED, VerificationStatus.PENDING] },
    });

    if (existing) return null;

    return DriverVerification.create({
      driverId,
      userId,
      type,
      status: VerificationStatus.REQUESTED,
      dueAt: new Date(Date.now() + windowMinutes * 60 * 1000),
    });
  }

  /** Compatibilidad con el nombre anterior. */
  async requestRandomVerification(
    driverId: string,
    userId: string
  ): Promise<IDriverVerification | null> {
    return this.requestVerification(driverId, userId, VerificationType.RANDOM_SELFIE);
  }

  /**
   * El domiciliario responde a una verificación que se le pidió.
   *
   * Pasa de "solicitada" a "pendiente de revisión": la foto ya está, falta
   * que alguien la mire. Mientras tanto deja de estar bloqueado, porque el
   * retraso a partir de aquí es de la plataforma y no suyo.
   */
  async fulfillVerification(
    driverId: string,
    type: VerificationType,
    imageUrl: string,
    metadata?: Record<string, any>
  ): Promise<IDriverVerification | null> {
    return DriverVerification.findOneAndUpdate(
      { driverId, type, status: VerificationStatus.REQUESTED },
      { status: VerificationStatus.PENDING, imageUrl, metadata },
      { new: true }
    );
  }

  /**
   * ¿Tiene una verificación pedida cuyo plazo ya venció?
   *
   * Es la única consecuencia real de todo esto. Sin una puerta que consulte
   * esta pregunta, pedir una selfie es mandar una notificación que se puede
   * ignorar, y quien está usando la cuenta de otro la ignorará.
   */
  async hasOverdueVerification(driverId: string): Promise<IDriverVerification | null> {
    return DriverVerification.findOne({
      driverId,
      status: VerificationStatus.REQUESTED,
      dueAt: { $lt: new Date() },
    });
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
