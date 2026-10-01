import { realtimeInvalidatePlugin } from '../realtime/invalidate';
import mongoose, { Schema, Document, Types } from 'mongoose';
import bcrypt from 'bcryptjs';
import { UserRole } from '../types';
import { hashPassword, verifyPassword } from '../security';
import { phoneSetter } from '../utils/phone';

export type DocumentType = 'CC' | 'CE' | 'PPT' | 'PASAPORTE';
export const DOCUMENT_TYPES: readonly DocumentType[] = ['CC', 'CE', 'PPT', 'PASAPORTE'];

export interface IUser extends Document {
  /**
   * El nombre que se muestra en todas partes (paneles, domiciliario,
   * pedidos). Si llegan `firstName`/`lastName`, se recalcula con ellos; las
   * cuentas anteriores a Mi cuenta solo tienen este.
   */
  name: string;
  firstName?: string;
  lastName?: string;
  /** Para facturar a nombre del cliente. Opcional. */
  documentType?: DocumentType;
  documentNumber?: string;
  /**
   * Medianoche UTC del día de nacimiento. Se guarda una sola vez: decide si
   * puede pedir productos +18, así que después solo la corrige soporte.
   */
  birthDate?: Date;
  phone?: string;
  email?: string;
  /**
   * Correo para el comprobante de pago, solo cuando la cuenta no tiene
   * `email` (registro por celular). Se pide una sola vez en el primer pago
   * y desde ahí solo se cambia en Mi cuenta — nunca vuelve a preguntarse
   * en el flujo de pago. Sin verificación por OTP a propósito: no es la
   * identidad de la cuenta, es solo el destino del recibo de Wompi.
   */
  receiptEmail?: string;
  password?: string;
  googleId?: string;
  appleId?: string;
  facebookId?: string;
  role: UserRole;
  /**
   * Grants the right to edit pricing, verify cash remittances and run
   * settlements. Separate from `role` on purpose: not every admin should
   * be able to change what the platform charges, and an audit trail is
   * only meaningful when the set of people who can act is narrow.
   */
  /** @deprecated usa el permiso `finance:manage` (rol Finanzas). */
  isFinanceAdmin: boolean;
  avatar?: string;
  isActive: boolean;
  isVerified: boolean;
  /**
   * OTP de login/recuperación por WhatsApp. Se guarda el HMAC, nunca el
   * código: quien lea la base no puede usarlo. Ver `security/otp.ts`.
   */
  otpCode?: string;
  otpExpires?: Date;
  /** Intentos gastados contra el OTP vigente; al llegar al tope se invalida. */
  otpAttempts?: number;
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
  emailOtpAttempts?: number;
  /** Same lock as `phoneVerified`, but for email OTP login. */
  emailVerified: boolean;
  /**
   * Celular que el usuario pidió asociar y todavía no confirmó.
   *
   * `phone` solo cambia cuando llega el OTP enviado a este número: antes
   * `PATCH /auth/profile` escribía `phone` directamente y el número quedaba
   * "de" esa cuenta sin que nadie demostrara tenerlo.
   */
  pendingPhone?: string;
  pendingPhoneOtpCode?: string;
  pendingPhoneOtpExpires?: Date;
  pendingPhoneOtpAttempts?: number;

  // ── Security fields ──
  failedLoginAttempts: number;
  lockedUntil?: Date;
  lastLoginAt?: Date;
  lastLoginIp?: string;
  passwordChangedAt?: Date;
  /**
   * La contraseña actual es una temporal generada por un admin
   * (`resetUserPassword`, S10). No hay envío de correo/SMS en el repo, así
   * que el panel sigue viendo el valor en claro una sola vez; esto acota el
   * riesgo: la cuenta tiene que cambiarla en su próximo login y caduca sola.
   */
  mustChangePassword?: boolean;
  passwordExpiresAt?: Date;

  // ── 2FA fields ──
  twoFactorEnabled: boolean;
  twoFactorSecret?: string;
  recoveryCodes?: string[];
  twoFactorVerifiedAt?: Date;
  /** Último paso TOTP aceptado: un mismo código no sirve dos veces. */
  twoFactorLastStep?: number;
  /**
   * Reto de segundo factor pendiente. Lo abre cualquier camino que haya
   * superado el primer factor (contraseña, Google, Apple, OTP) en una cuenta
   * con 2FA; la sesión solo se emite al resolverlo. Ver `security/mfa.ts`.
   */
  mfaChallengeHash?: string;
  mfaChallengeExpires?: Date;
  mfaChallengeAttempts?: number;
  mfaChallengeMethod?: string;

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
  /** Fecha en que la cuenta se anonimizó (supresión de datos). No hay vuelta atrás. */
  anonymizedAt?: Date;
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
    firstName: { type: String, trim: true, maxlength: 60 },
    lastName: { type: String, trim: true, maxlength: 60 },
    documentType: { type: String, enum: [...DOCUMENT_TYPES] },
    documentNumber: { type: String, trim: true, maxlength: 20 },
    birthDate: { type: Date },
    phone: {
      type: String,
      // Opcional para cuentas Google/Apple/Facebook (quedan sin celular
      // hasta que completan la pantalla de verificación obligatoria) y para
      // admin/business, que ahora entran por correo y contraseña, no por
      // celular — ver `email` más abajo y `auth.service.ts::login`.
      required: [
        function (this: IUser) {
          return !this.googleId && !this.appleId && !this.facebookId
            && this.role !== UserRole.ADMIN && this.role !== UserRole.BUSINESS;
        },
        'El número de celular es requerido',
      ],
      unique: true,
      sparse: true,
      trim: true,
      // Se normaliza al escribir y al consultar (Mongoose aplica el setter a
      // los filtros), así que `+57 310…` y `310…` son el mismo documento.
      // El `match` sigue admitiendo el formato heredado con `+57`: un
      // documento viejo sin migrar tiene que poder guardarse, no quedar
      // bloqueado por su propio teléfono.
      set: phoneSetter,
      match: [/^(\+57)?[0-9]{10}$/, 'Número de celular inválido'],
    },
    email: {
      type: String,
      // Requerido para admin/business: es su identificador de login desde
      // que los paneles admin y business dejaron de aceptar celular.
      required: [
        function (this: IUser) { return this.role === UserRole.ADMIN || this.role === UserRole.BUSINESS; },
        'El correo es requerido para esta cuenta',
      ],
      unique: true,
      sparse: true,
      trim: true,
      lowercase: true,
      match: [/^\S+@\S+\.\S+$/, 'Email inválido'],
    },
    receiptEmail: {
      type: String,
      trim: true,
      lowercase: true,
      match: [/^\S+@\S+\.\S+$/, 'Email inválido'],
    },
    password: {
      type: String,
      required: [function (this: IUser) { return !this.googleId && !this.appleId && !this.facebookId; }, 'La contraseña es requerida'],
      minlength: [6, 'La contraseña debe tener al menos 6 caracteres'],
      select: false,
    },
    googleId: {
      type: String,
      unique: true,
      sparse: true,
      select: false,
    },
    appleId: {
      type: String,
      unique: true,
      sparse: true,
      select: false,
    },
    facebookId: {
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
    /** @deprecated Fase 1: el poder financiero es el permiso `finance:manage` del rol Finanzas. Se migra con 019 y se borra en una 020. */
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
    otpAttempts: { type: Number, select: false },
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
    emailOtpAttempts: { type: Number, select: false },
    emailVerified: {
      type: Boolean,
      default: false,
    },
    // `refreshToken` ya no existe: la fuente de verdad es `Session.tokenHash`
    // (SHA-256). Guardar el token en claro aquí anulaba el hash de la
    // sesión y dejaba un solo token válido por usuario.
    pendingPhone: {
      type: String,
      trim: true,
      set: phoneSetter,
      match: [/^[0-9]{10}$/, 'Número de celular inválido'],
    },
    pendingPhoneOtpCode: { type: String, select: false },
    pendingPhoneOtpExpires: { type: Date, select: false },
    pendingPhoneOtpAttempts: { type: Number, select: false },

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
    mustChangePassword: {
      type: Boolean,
      default: false,
    },
    passwordExpiresAt: {
      type: Date,
      select: false,
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
    twoFactorLastStep: { type: Number, select: false },
    mfaChallengeHash: { type: String, select: false },
    mfaChallengeExpires: { type: Date, select: false },
    mfaChallengeAttempts: { type: Number, select: false },
    mfaChallengeMethod: { type: String, select: false },

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
    anonymizedAt: { type: Date },
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
        delete ret.appleId;
        delete ret.facebookId;
        delete ret.otpCode;
        delete ret.otpExpires;
        delete ret.otpAttempts;
        delete ret.emailOtpCode;
        delete ret.emailOtpExpires;
        delete ret.emailOtpAttempts;
        delete ret.pendingPhoneOtpCode;
        delete ret.pendingPhoneOtpExpires;
        delete ret.pendingPhoneOtpAttempts;
        delete ret.twoFactorLastStep;
        delete ret.mfaChallengeHash;
        delete ret.mfaChallengeExpires;
        delete ret.mfaChallengeAttempts;
        delete ret.mfaChallengeMethod;
        // Vestigio de antes de la migración 004: si un documento viejo aún
        // lo trae, no sale nunca por la API.
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

userSchema.plugin(realtimeInvalidatePlugin, { resource: 'users' });
export const User = mongoose.model<IUser>('User', userSchema);
