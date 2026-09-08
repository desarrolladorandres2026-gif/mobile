import mongoose, { Schema, Document, Types } from 'mongoose';
import bcrypt from 'bcryptjs';
import { UserRole } from '../types';
import { hashPassword, verifyPassword } from '../security';

export interface IUser extends Document {
  name: string;
  phone?: string;
  email?: string;
  password?: string;
  googleId?: string;
  role: UserRole;
  /**
   * Grants the right to edit pricing, verify cash remittances and run
   * settlements. Separate from `role` on purpose: not every admin should
   * be able to change what the platform charges, and an audit trail is
   * only meaningful when the set of people who can act is narrow.
   */
  isFinanceAdmin: boolean;
  avatar?: string;
  isActive: boolean;
  isVerified: boolean;
  otpCode?: string;
  otpExpires?: Date;
  /**
   * True once the phone was confirmed via WhatsApp Business OTP and the user
   * logged in successfully with it. From that point the phone is locked for
   * self-service edits — only an admin override (`admin.service.overrideUserContact`)
   * can change it, so a verified identity can't be silently swapped by an
   * attacker who compromises the session.
   */
  phoneVerified: boolean;
  emailOtpCode?: string;
  emailOtpExpires?: Date;
  /** Same lock as `phoneVerified`, but for email OTP login. */
  emailVerified: boolean;
  refreshToken?: string;

  // ── Security fields ──
  failedLoginAttempts: number;
  lockedUntil?: Date;
  lastLoginAt?: Date;
  lastLoginIp?: string;
  passwordChangedAt?: Date;

  // ── 2FA fields ──
  twoFactorEnabled: boolean;
  twoFactorSecret?: string;
  recoveryCodes?: string[];
  twoFactorVerifiedAt?: Date;

  // ── Device tracking ──
  trustedDevices: string[];
  lastDeviceId?: string;
  /**
   * Tokens de push de Expo, uno por dispositivo con sesión iniciada. Se
   * registran al conceder el permiso de notificaciones y se borran al
   * cerrar sesión o cuando Expo informa que dejaron de ser válidos
   * (`DeviceNotRegistered`). `select: false`: es dato de dispositivo, no
   * se expone en la API de perfil.
   */
  pushTokens: { token: string; platform: string; updatedAt: Date }[];
  marketingConsent: boolean;
  marketingConsentAt?: Date;
  marketingChannels: string[];

  // ── Seguridad y Acceso: Cargo, Roles, estado administrativo ──
  // Capa fina de RBAC, adicional a `role` (que sigue siendo el tipo de
  // cuenta: client/business/driver/admin y no cambia). Solo tiene efecto
  // real para cuentas administrativas — ver authorization.service.ts, que
  // es el único lugar que combina `role` + `positionId` + `roleIds` en la
  // lista de permisos efectivos.
  positionId?: mongoose.Types.ObjectId;
  roleIds: mongoose.Types.ObjectId[];
  /**
   * Bloqueo administrativo explícito (distinto de `isActive`, que también
   * se apaga por autoservicio o antifraude). Un usuario bloqueado no puede
   * autenticarse ni usar sesiones existentes — ver `authenticate` — y solo
   * un administrador con `users:block` puede revertirlo.
   */
  isBlocked: boolean;

  /**
   * Código propio para invitar. Se genera al registrarse.
   *
   * Antes la app compartía el código fijo `BIENVENIDO` para todo el mundo,
   * así que no había forma de saber quién trajo a quién: la función se
   * llamaba "referidos" y no refería a nadie.
   */
  referralCode?: string;
  /** Quién trajo a este usuario. Se fija una vez y no cambia. */
  referredBy?: Types.ObjectId | null;
  /** Cuándo se pagó la recompensa por esta invitación, si se pagó. */
  referralRewardedAt?: Date | null;
  deactivatedAt?: Date;
  createdBy?: mongoose.Types.ObjectId;
  updatedBy?: mongoose.Types.ObjectId;

  createdAt: Date;
  updatedAt: Date;
  comparePassword(candidatePassword: string): Promise<boolean>;
  /** ACTIVO / INACTIVO / BLOQUEADO derivado de isActive + isBlocked. */
  status: 'active' | 'inactive' | 'blocked';
}

const userSchema = new Schema<IUser>(
  {
    name: {
      type: String,
      required: [true, 'El nombre es requerido'],
      trim: true,
      minlength: [2, 'El nombre debe tener al menos 2 caracteres'],
      maxlength: [100, 'El nombre no puede exceder 100 caracteres'],
    },
    phone: {
      type: String,
      // Opcional solo para cuentas creadas con Google: quedan sin celular
      // hasta que completan la pantalla de verificación obligatoria.
      required: [function (this: IUser) { return !this.googleId; }, 'El número de celular es requerido'],
      unique: true,
      sparse: true,
      trim: true,
      match: [/^(\+57)?[0-9]{10}$/, 'Número de celular inválido'],
    },
    email: {
      type: String,
      unique: true,
      sparse: true,
      trim: true,
      lowercase: true,
      match: [/^\S+@\S+\.\S+$/, 'Email inválido'],
    },
    password: {
      type: String,
      required: [function (this: IUser) { return !this.googleId; }, 'La contraseña es requerida'],
      minlength: [6, 'La contraseña debe tener al menos 6 caracteres'],
      select: false,
    },
    googleId: {
      type: String,
      unique: true,
      sparse: true,
      select: false,
    },
    role: {
      type: String,
      enum: Object.values(UserRole),
      default: UserRole.CLIENT,
    },
    isFinanceAdmin: {
      type: Boolean,
      default: false,
    },
    avatar: {
      type: String,
      default: null,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    isVerified: {
      type: Boolean,
      default: true,
    },
    otpCode: {
      type: String,
      select: false,
    },
    otpExpires: {
      type: Date,
      select: false,
    },
    phoneVerified: {
      type: Boolean,
      default: false,
    },
    emailOtpCode: {
      type: String,
      select: false,
    },
    emailOtpExpires: {
      type: Date,
      select: false,
    },
    emailVerified: {
      type: Boolean,
      default: false,
    },
    refreshToken: {
      type: String,
      select: false,
    },

    // ── Security fields ──
    failedLoginAttempts: {
      type: Number,
      default: 0,
      select: false,
    },
    lockedUntil: {
      type: Date,
      select: false,
    },
    lastLoginAt: {
      type: Date,
    },
    lastLoginIp: {
      type: String,
      select: false,
    },
    passwordChangedAt: {
      type: Date,
    },

    // ── 2FA fields ──
    twoFactorEnabled: {
      type: Boolean,
      default: false,
    },
    twoFactorSecret: {
      type: String,
      select: false,
    },
    recoveryCodes: {
      type: [String],
      select: false,
    },
    twoFactorVerifiedAt: {
      type: Date,
      select: false,
    },

    // ── Device tracking ──
    trustedDevices: {
      type: [String],
      default: [],
      select: false,
    },
    lastDeviceId: {
      type: String,
      select: false,
    },
    pushTokens: {
      type: [
        new Schema(
          {
            token: { type: String, required: true },
            platform: { type: String, default: 'unknown' },
            updatedAt: { type: Date, default: Date.now },
          },
          { _id: false }
        ),
      ],
      default: [],
      select: false,
    },
    marketingConsent: { type: Boolean, default: false },
    marketingConsentAt: { type: Date, default: null },
    marketingChannels: { type: [String], default: [] },

    // ── Seguridad y Acceso ──
    positionId: { type: Schema.Types.ObjectId, ref: 'Position' },
    roleIds: { type: [Schema.Types.ObjectId], ref: 'Role', default: [] },
    isBlocked: { type: Boolean, default: false },
    referralCode: { type: String, unique: true, sparse: true, uppercase: true, trim: true },
    referredBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    referralRewardedAt: { type: Date, default: null },
    deactivatedAt: { type: Date },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform(_doc: any, ret: Record<string, any>) {
        delete ret.password;
        delete ret.googleId;
        delete ret.otpCode;
        delete ret.otpExpires;
        delete ret.emailOtpCode;
        delete ret.emailOtpExpires;
        delete ret.refreshToken;
        delete ret.failedLoginAttempts;
        delete ret.lockedUntil;
        delete ret.lastLoginIp;
        delete ret.twoFactorSecret;
        delete ret.recoveryCodes;
        delete ret.twoFactorVerifiedAt;
        delete ret.trustedDevices;
        delete ret.lastDeviceId;
        delete ret.pushTokens;
        delete ret.__v;
        return ret;
      },
    },
  }
);

userSchema.virtual('status').get(function (this: IUser) {
  if (this.isBlocked) return 'blocked';
  return this.isActive ? 'active' : 'inactive';
});

// Hash password before saving using Argon2id
userSchema.pre('save', async function (next) {
  if (!this.isModified('password') || !this.password) return next();

  // Use Argon2id for new password hashes
  this.password = await hashPassword(this.password);
  this.passwordChangedAt = new Date();
  next();
});

// Compare password method - supports both bcrypt (legacy) and argon2id
userSchema.methods.comparePassword = async function (
  candidatePassword: string
): Promise<boolean> {
  // Cuentas creadas con Google pueden no tener contraseña.
  if (!this.password) return false;

  // Argon2id hashes start with $argon2
  if (this.password.startsWith('$argon2')) {
    return verifyPassword(this.password, candidatePassword);
  }

  // Legacy bcrypt support - on successful verify, rehash with argon2id
  const isMatch = await bcrypt.compare(candidatePassword, this.password);

  if (isMatch) {
    // Migrate to argon2id on next save
    this.password = candidatePassword; // Will be hashed by pre-save hook
    await this.save();
  }

  return isMatch;
};

// Indexes
userSchema.index({ role: 1 });
userSchema.index({ isActive: 1 });
userSchema.index({ twoFactorEnabled: 1 });
userSchema.index({ positionId: 1 });
userSchema.index({ roleIds: 1 });

export const User = mongoose.model<IUser>('User', userSchema);
