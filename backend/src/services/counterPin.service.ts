import mongoose, { Schema, Document } from 'mongoose';
import { User, Business, BusinessStaff, BusinessRole, normalizeStaffRole } from '../models';
import { AppError } from '../middlewares/errorHandler';
import { hashPassword, verifyPassword } from '../security/password';
import { hasTwoFactor } from './mfa.service';

/**
 * PIN de 6 dígitos del mostrador (decisión 2026-10-10).
 *
 * Desde la sesión de mostrador, el representante legal o un administrador
 * eligen su nombre y teclean su PIN para abrir su panel. Reemplaza al correo
 * y la contraseña en ese paso, así que carga con lo que ellos protegían:
 *
 *   - Lo crea cada persona desde su propia cuenta completa, con su
 *     contraseña (y el representante legal con 2FA activo). Nadie conoce el
 *     PIN de otro: así la auditoría prueba quién actuó.
 *   - Se elige la persona y luego el PIN. Un PIN que identificara a alguien
 *     tendría que ser único por negocio, y "ese PIN ya está en uso" le
 *     revelaría a quien lo crea el PIN de otra persona.
 *   - Un millón de combinaciones solo aguantan con un freno: 5 fallos por
 *     persona y equipo bloquean 15 min (cada bloqueo dura el doble), y 10 por
 *     persona en cualquier equipo bloquean una hora, para que cambiar de
 *     equipo no reinicie la cuenta. El dueño se entera de cada bloqueo.
 */

export const PIN_LENGTH = 6;

/** PINs que cualquiera prueba primero. Además de esta lista se rechazan repetidos y escaleras. */
const COMMON_PINS = new Set(['123123', '121212', '112233', '102030', '111222', '123321', '654321', '696969', '200000']);

/** ¿Es un PIN aceptable? Devuelve el motivo si no lo es. */
export function pinProblem(pin: string): string | null {
  if (!new RegExp(`^\\d{${PIN_LENGTH}}$`).test(pin)) return `El PIN son ${PIN_LENGTH} dígitos.`;
  if (/^(\d)\1+$/.test(pin)) return 'El PIN no puede repetir el mismo dígito.';
  const digits = pin.split('').map(Number);
  const step = digits[1] - digits[0];
  if ((step === 1 || step === -1) && digits.every((d, i) => i === 0 || d - digits[i - 1] === step)) {
    return 'El PIN no puede ser una escalera (123456, 987654…).';
  }
  if (COMMON_PINS.has(pin)) return 'Ese PIN es demasiado común. Elige otro.';
  return null;
}

// ── Intentos ──
//
// Revisión de seguridad 2026-10-10 sobre la primera versión:
//   - El intento se RESERVA de forma atómica antes de verificar el PIN. Antes
//     se anotaba después del argon2 con `findOne` → `$set`: una ráfaga en
//     paralelo pasaba toda el chequeo y probaba decenas de PIN por bloqueo.
//   - Los topes son por persona Y negocio: con uno global, cualquier
//     empleado dejaba bloqueado el PIN del dueño en todos sus locales.
//   - Hay un tope diario que no se olvida solo: 9 fallos por hora, repetidos
//     cada hora, eran ~216 intentos al día sin bloqueo ni aviso. Ese tope
//     bloquea hasta que el dueño lo levante (o la persona cambie su PIN).
//   - El dueño se entera desde el 3.er fallo del día, no solo al bloquear.
//   - El `deviceId` lo pone el cliente, así que el tope por equipo frena al
//     despistado, no al atacante: los que mandan son el horario y el diario.

interface ICounterPinAttempt extends Document {
  key: string;
  count: number;
  firstAttemptAt: Date;
  lockedUntil?: Date | null;
  lockLevel: number;
  updatedAt: Date;
  /** Cuándo se puede borrar la fila: después de su ventana, su bloqueo y la memoria de la escalada. */
  expiresAt: Date;
}

const counterPinAttemptSchema = new Schema<ICounterPinAttempt>({
  key: { type: String, required: true, unique: true },
  count: { type: Number, default: 0 },
  firstAttemptAt: { type: Date },
  lockedUntil: { type: Date, default: null },
  lockLevel: { type: Number, default: 0 },
  updatedAt: { type: Date },
  expiresAt: { type: Date },
});
// Solo limpia, y nunca antes de que venza un bloqueo: la corrección la da
// comparar `lockedUntil` contra el reloj.
counterPinAttemptSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const CounterPinAttempt = mongoose.model<ICounterPinAttempt>('CounterPinAttempt', counterPinAttemptSchema);

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** Tras esto sin fallos, la escalada vuelve a empezar. */
const LOCK_LEVEL_MEMORY_MS = DAY;
/** "Hasta que el dueño lo levante": treinta días, de sobra para que alguien lo note. */
const HARD_LOCK_MS = 30 * DAY;

interface Limit {
  key: string;
  max: number;
  windowMs: number;
  lockMs: (level: number) => number;
  /** Bloqueo que solo levanta el dueño o un PIN nuevo. */
  hard?: boolean;
}

function limitsFor(targetUserId: string, businessId: string, deviceId: string): Limit[] {
  const who = `${targetUserId}|${businessId}`;
  return [
    { key: `device:${who}|${deviceId}`, max: 5, windowMs: HOUR, lockMs: (l) => Math.min(15 * MINUTE * 2 ** l, 8 * HOUR) },
    { key: `hour:${who}`, max: 10, windowMs: HOUR, lockMs: (l) => Math.min(HOUR * 2 ** l, 8 * HOUR) },
    { key: `day:${who}`, max: 20, windowMs: DAY, lockMs: () => HARD_LOCK_MS, hard: true },
  ];
}

/** Fallos del día a partir de los cuales el dueño recibe aviso (una vez por día). */
export const PIN_ALERT_AFTER_FAILURES = 3;

export type PinReservation =
  | { ok: true; counts: Record<string, number>; levels: Record<string, number>; dayCount: number; limits: Limit[] }
  | { ok: false; retryAfterMs: number; hard: boolean };

/**
 * Reserva un intento contra cada tope, de forma atómica, ANTES de verificar.
 *
 * Una fila bloqueada no casa con el filtro y el upsert choca con el índice
 * único (11000): eso es "bloqueado". Una reserva que ya pasa del tope (la
 * ráfaga en paralelo) también se rechaza sin llegar a verificar el PIN.
 */
export async function reservePinAttempt(targetUserId: string, businessId: string, deviceId: string): Promise<PinReservation> {
  const now = new Date();
  const limits = limitsFor(targetUserId, businessId, deviceId);
  const counts: Record<string, number> = {};
  const levels: Record<string, number> = {};

  for (const limit of limits) {
    let row: ICounterPinAttempt | null = null;
    try {
      row = await CounterPinAttempt.findOneAndUpdate(
        { key: limit.key, $or: [{ lockedUntil: null }, { lockedUntil: { $lte: now } }] },
        [
          {
            $set: {
              _fresh: {
                $or: [
                  { $eq: [{ $ifNull: ['$firstAttemptAt', null] }, null] },
                  { $gt: [{ $subtract: [now, '$firstAttemptAt'] }, limit.windowMs] },
                  { $ne: [{ $ifNull: ['$lockedUntil', null] }, null] },
                ],
              },
              lockLevel: {
                $cond: [
                  { $gt: [{ $subtract: [now, { $ifNull: ['$updatedAt', now] }] }, LOCK_LEVEL_MEMORY_MS] },
                  0,
                  { $ifNull: ['$lockLevel', 0] },
                ],
              },
            },
          },
          {
            $set: {
              count: { $cond: ['$_fresh', 1, { $add: [{ $ifNull: ['$count', 0] }, 1] }] },
              firstAttemptAt: { $cond: ['$_fresh', now, '$firstAttemptAt'] },
              lockedUntil: null,
              updatedAt: now,
              expiresAt: new Date(now.getTime() + limit.windowMs + LOCK_LEVEL_MEMORY_MS),
            },
          },
          { $unset: '_fresh' },
        ],
        { upsert: true, new: true }
      );
    } catch (error) {
      if ((error as { code?: number }).code !== 11000) throw error;
    }

    if (!row || row.count > limit.max) {
      // Deshace lo ya reservado en los topes anteriores: este intento no ocurre.
      await releasePinAttempt(limits.slice(0, limits.indexOf(limit)).filter((l) => counts[l.key] !== undefined));
      const locked = await CounterPinAttempt.find({ key: { $in: limits.map((l) => l.key) } });
      const retryAfterMs = locked.reduce(
        (max, r) => Math.max(max, r.lockedUntil ? r.lockedUntil.getTime() - now.getTime() : 0),
        // Pasarse del tope sin bloqueo escrito todavía: la ráfaga. Un minuto.
        MINUTE
      );
      const hard = locked.some((r) => r.key.startsWith('day:') && !!r.lockedUntil && r.lockedUntil > now);
      return { ok: false, retryAfterMs, hard };
    }
    counts[limit.key] = row.count;
    levels[limit.key] = row.lockLevel ?? 0;
  }

  return { ok: true, counts, levels, dayCount: counts[limits[2].key], limits };
}

async function releasePinAttempt(limits: Limit[]): Promise<void> {
  if (!limits.length) return;
  await CounterPinAttempt.updateMany({ key: { $in: limits.map((l) => l.key) }, count: { $gt: 0 } }, { $inc: { count: -1 } });
}

/**
 * Un PIN correcto: deshace la reserva y borra los fallos de ese equipo. Los
 * topes horario y diario conservan los fallos anteriores: acertar una vez no
 * le regala al que adivina otra tanda.
 */
export async function settlePinSuccess(reservation: Extract<PinReservation, { ok: true }>): Promise<void> {
  const [device, ...rest] = reservation.limits;
  await CounterPinAttempt.deleteOne({ key: device.key });
  await releasePinAttempt(rest);
}

/**
 * Un PIN fallido: la reserva ya contó el intento; aquí solo se bloquea el
 * tope que llegó a su máximo. Devuelve qué bloqueó, para avisar una vez.
 */
export async function settlePinFailure(
  reservation: Extract<PinReservation, { ok: true }>
): Promise<{ locked: boolean; hard: boolean; lockMs: number }> {
  const now = Date.now();
  let locked = false;
  let hard = false;
  let lockMs = 0;
  for (const limit of reservation.limits) {
    if (reservation.counts[limit.key] < limit.max) continue;
    const ms = limit.lockMs(reservation.levels[limit.key] ?? 0);
    const result = await CounterPinAttempt.updateOne(
      { key: limit.key, lockedUntil: null },
      {
        $set: { lockedUntil: new Date(now + ms), count: 0, expiresAt: new Date(now + ms + LOCK_LEVEL_MEMORY_MS) },
        $inc: { lockLevel: 1 },
      }
    );
    if (result.modifiedCount === 1) {
      locked = true;
      hard ||= !!limit.hard;
      lockMs = Math.max(lockMs, ms);
    }
  }
  return { locked, hard, lockMs };
}

/** Levanta todos los bloqueos de una persona en un negocio (el dueño, o al cambiar el PIN). */
export async function unlockPin(targetUserId: string, businessId?: string): Promise<void> {
  const escape = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const who = businessId ? `${escape(targetUserId)}\\|${escape(businessId)}` : `${escape(targetUserId)}\\|`;
  await CounterPinAttempt.deleteMany({ key: { $regex: `^(device|hour|day):${who}` } });
}
// ── PIN de cada persona ──

/**
 * Hash de un PIN que no existe: verificar contra él cuesta lo mismo que
 * contra uno real, para que el tiempo de respuesta no diga quién tiene PIN.
 */
let decoyHash: Promise<string> | null = null;
const decoy = () => (decoyHash ??= hashPassword('decoy-pin-never-matches'));

export async function verifyPin(storedHash: string | undefined, pin: string): Promise<boolean> {
  if (!storedHash) {
    await verifyPassword(await decoy(), pin);
    return false;
  }
  return verifyPassword(storedHash, pin);
}

/** Fechas en los formatos que la gente usa como PIN: DDMMAA, MMDDAA, AAMMDD y DDMMAAAA recortado. */
function birthDatePins(birthDate: Date | undefined): string[] {
  if (!birthDate) return [];
  const d = String(birthDate.getUTCDate()).padStart(2, '0');
  const m = String(birthDate.getUTCMonth() + 1).padStart(2, '0');
  const yyyy = String(birthDate.getUTCFullYear());
  const yy = yyyy.slice(2);
  return [`${d}${m}${yy}`, `${m}${d}${yy}`, `${yy}${m}${d}`, `${d}${m}${yyyy}`.slice(0, 6), `${yyyy}`.padEnd(6, '0').slice(0, 6)];
}

/** ¿Sale el PIN de los datos de la persona? Celular (inicio o final) o fecha de nacimiento. */
function personalPinProblem(pin: string, user: { phone?: string; birthDate?: Date }): string | null {
  const phoneDigits = (user.phone ?? '').replace(/\D/g, '');
  if (phoneDigits.length >= 6 && (phoneDigits.endsWith(pin) || phoneDigits.slice(-10).startsWith(pin))) {
    return 'El PIN no puede salir de tu número de celular.';
  }
  if (birthDatePins(user.birthDate).includes(pin)) return 'El PIN no puede ser tu fecha de nacimiento.';
  return null;
}

/**
 * Cierra las sesiones elevadas abiertas de una persona. Cambiar o quitar el
 * PIN es lo que hace quien cree que se lo vieron: sin esto, la sesión que
 * abrió el que lo vio seguiría viva hasta dos horas.
 */
async function revokeElevatedSessions(userId: string): Promise<void> {
  const { Session, sessionManager } = await import('../security/sessions');
  const open = await Session.find({ userId, isActive: true, elevatedFrom: { $ne: null } }).select('_id');
  for (const session of open) await sessionManager.revokeSession(session._id.toString(), userId, 'user_revoked');
}

/**
 * Crea o cambia el PIN propio. Se llama desde una sesión completa propia (la
 * ruta lleva `rejectCounterScope`, que también rechaza una sesión elevada) y
 * pide la contraseña actual: un PIN abre un panel desde el mostrador, así
 * que no basta con tener una sesión abierta. Quien sea propietario de algún
 * negocio necesita 2FA activo, porque el PIN lo reemplaza en el mostrador.
 */
export async function setOwnPin(userId: string, pin: string, currentPassword: string): Promise<void> {
  const problem = pinProblem(pin);
  if (problem) throw new AppError(problem, 400, 'PIN_WEAK');

  const user = await User.findById(userId).select('+password +twoFactorEnabled +twoFactorSecret');
  if (!user) throw new AppError('Usuario no encontrado', 404);
  if (!user.password || !(await user.comparePassword(currentPassword))) {
    throw new AppError('Contraseña incorrecta', 401, 'REAUTH_FAILED');
  }

  const personal = personalPinProblem(pin, user);
  if (personal) throw new AppError(personal, 400, 'PIN_WEAK');

  const isOwner = !!(await Business.exists({ ownerId: user._id }));
  if (isOwner && !hasTwoFactor(user)) {
    throw new AppError(
      'Activa la verificación en dos pasos antes de crear tu PIN de representante legal.',
      403,
      'TWO_FACTOR_SETUP_REQUIRED'
    );
  }

  await User.updateOne(
    { _id: user._id },
    { $set: { counterPinHash: await hashPassword(pin), counterPinSetAt: new Date() } }
  );
  // Un PIN nuevo deja atrás lo que pasó con el anterior: sus bloqueos (el
  // dueño no tiene que esperar si fue él quien se equivocó) y sus sesiones.
  await unlockPin(userId);
  await revokeElevatedSessions(userId);
}

export async function removeOwnPin(userId: string): Promise<void> {
  await User.updateOne({ _id: userId }, { $unset: { counterPinHash: 1 }, $set: { counterPinSetAt: null } });
  await unlockPin(userId);
  await revokeElevatedSessions(userId);
}

export interface CounterPerson {
  userId: string;
  name: string;
  role: BusinessRole.OWNER | BusinessRole.MANAGER;
}

/**
 * Quién puede entrar con PIN en este negocio: el propietario y los
 * administradores activos que ya crearon el suyo. Solo nombre y papel; nada
 * de correo ni teléfono, porque lo ve cualquiera frente al mostrador.
 */
export async function counterPeople(businessId: string): Promise<CounterPerson[]> {
  const business = await Business.findById(businessId).select('ownerId isArchived');
  if (!business || business.isArchived) return [];

  const managers = await BusinessStaff.find({ businessId, isActive: true, status: 'active' }).select('userId role');
  const managerIds = managers
    .filter((row) => normalizeStaffRole(row.role) === BusinessRole.MANAGER)
    .map((row) => row.userId);

  const users = await User.find({
    _id: { $in: [business.ownerId, ...managerIds] },
    counterPinSetAt: { $ne: null },
    isActive: true,
    isBlocked: { $ne: true },
  }).select('name');

  const ownerId = business.ownerId.toString();
  return users
    .map((u) => ({
      userId: u._id.toString(),
      name: u.name,
      role: u._id.toString() === ownerId ? BusinessRole.OWNER : BusinessRole.MANAGER,
    }) as CounterPerson)
    // El representante legal primero, luego los administradores por nombre.
    .sort((a, b) => (a.role === b.role ? a.name.localeCompare(b.name) : a.role === BusinessRole.OWNER ? -1 : 1));
}
