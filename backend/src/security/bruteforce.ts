import mongoose, { Schema, Document } from 'mongoose';

/**
 * Freno a los intentos de acceso por fuerza bruta.
 *
 * Vivía en dos `Map` de memoria del proceso, con una nota que decía
 * "reemplazar por Redis en producción". El problema no era la elegancia:
 * un contador de intentos fallidos que se borra al reiniciar convierte
 * cualquier despliegue en una amnistía, y con dos instancias de PM2 cada
 * una contaba la mitad de los intentos, así que el atacante disponía del
 * doble antes del bloqueo.
 *
 * Está en Mongo y no en Redis porque Mongo ya es una dependencia de este
 * proyecto y Redis no. Un intento de acceso ya escribe en la base de datos
 * de todas formas —hay que leer el usuario—, así que el coste añadido de
 * una lectura indexada más no cambia nada, y evita montar y operar una
 * pieza de infraestructura entera para dos contadores.
 */

export interface ILoginAttempt extends Document {
  scope: 'ip' | 'user';
  key: string;
  count: number;
  firstAttemptAt: Date;
  lockedUntil?: Date;
  updatedAt: Date;
}

const loginAttemptSchema = new Schema<ILoginAttempt>({
  scope: { type: String, enum: ['ip', 'user'], required: true },
  key: { type: String, required: true },
  count: { type: Number, default: 0 },
  firstAttemptAt: { type: Date, default: Date.now },
  lockedUntil: { type: Date },
  updatedAt: { type: Date, default: Date.now },
});

loginAttemptSchema.index({ scope: 1, key: 1 }, { unique: true });

// Una hora cubre de sobra la ventana de quince minutos y el bloqueo máximo
// de treinta. El TTL solo limpia: la corrección la da la comparación de
// `lockedUntil` contra el reloj, que no depende de cuándo pase el barrendero
// de Mongo.
loginAttemptSchema.index({ updatedAt: 1 }, { expireAfterSeconds: 60 * 60 });

export const LoginAttempt = mongoose.model<ILoginAttempt>('LoginAttempt', loginAttemptSchema);

// ── Configuración ──
const MAX_ATTEMPTS_PER_IP = 20;
const MAX_ATTEMPTS_PER_USER = 5;
const WINDOW_MS = 15 * 60 * 1000;
const LOCK_DURATION_BASE_MS = 60 * 1000;
const LOCK_MULTIPLIER = 2;
const MAX_LOCK_DURATION_MS = 30 * 60 * 1000;

/**
 * Borra todos los contadores.
 *
 * Las pruebas lo necesitan entre casos: sin esto, los inicios de sesión
 * fallidos de una suite bloquean a la siguiente.
 */
export async function resetBruteForce(): Promise<void> {
  await LoginAttempt.deleteMany({});
}

export interface BruteForceCheckResult {
  allowed: boolean;
  retryAfterMs?: number;
  reason?: string;
}

/** ¿Se puede intentar entrar, o hay un bloqueo vivo? */
export async function checkBruteForce(
  ip: string,
  userIdentifier: string
): Promise<BruteForceCheckResult> {
  const now = Date.now();

  const [ipRecord, userRecord] = await Promise.all([
    LoginAttempt.findOne({ scope: 'ip', key: ip }).lean(),
    LoginAttempt.findOne({ scope: 'user', key: userIdentifier }).lean(),
  ]);

  if (ipRecord?.lockedUntil && now < ipRecord.lockedUntil.getTime()) {
    return {
      allowed: false,
      retryAfterMs: ipRecord.lockedUntil.getTime() - now,
      reason: 'Demasiados intentos desde esta IP. Intenta más tarde.',
    };
  }

  if (userRecord?.lockedUntil && now < userRecord.lockedUntil.getTime()) {
    return {
      allowed: false,
      retryAfterMs: userRecord.lockedUntil.getTime() - now,
      reason: 'Cuenta temporalmente bloqueada por múltiples intentos fallidos.',
    };
  }

  return { allowed: true };
}

/** Suma un intento fallido a un contador y decide si toca bloquear. */
async function bump(
  scope: 'ip' | 'user',
  key: string,
  maxAttempts: number
): Promise<{ count: number; lockedForMs?: number }> {
  const now = new Date();
  const existing = await LoginAttempt.findOne({ scope, key });

  // Fuera de la ventana, el contador empieza de cero: quien falló una vez
  // hace media hora no está atacando nada.
  const stale = existing && now.getTime() - existing.firstAttemptAt.getTime() > WINDOW_MS;
  const count = !existing || stale ? 1 : existing.count + 1;
  const firstAttemptAt = !existing || stale ? now : existing.firstAttemptAt;

  let lockedUntil: Date | undefined;
  let lockedForMs: number | undefined;

  if (count >= maxAttempts) {
    // El bloqueo se duplica en cada tanda: molesta poco a quien se equivocó
    // de contraseña y mucho a quien está probando una lista.
    lockedForMs = Math.min(
      LOCK_DURATION_BASE_MS * Math.pow(LOCK_MULTIPLIER, Math.floor(count / maxAttempts)),
      MAX_LOCK_DURATION_MS
    );
    lockedUntil = new Date(now.getTime() + lockedForMs);
  }

  await LoginAttempt.updateOne(
    { scope, key },
    { $set: { count, firstAttemptAt, updatedAt: now, ...(lockedUntil ? { lockedUntil } : {}) } },
    { upsert: true }
  );

  return { count, lockedForMs };
}

/** Registra un intento fallido contra la IP y contra la cuenta. */
export async function recordFailedAttempt(
  ip: string,
  userIdentifier: string
): Promise<BruteForceCheckResult> {
  const [, user] = await Promise.all([
    bump('ip', ip, MAX_ATTEMPTS_PER_IP),
    bump('user', userIdentifier, MAX_ATTEMPTS_PER_USER),
  ]);

  if (user.lockedForMs) {
    return {
      allowed: false,
      retryAfterMs: user.lockedForMs,
      reason: `Cuenta bloqueada temporalmente. Intenta en ${Math.ceil(user.lockedForMs / 1000)} segundos.`,
    };
  }

  const remaining = MAX_ATTEMPTS_PER_USER - user.count;
  return {
    allowed: true,
    reason: remaining <= 2 ? `${remaining} intento(s) restante(s) antes del bloqueo.` : undefined,
  };
}

/**
 * Limpia tras un acceso correcto.
 *
 * La cuenta se libera del todo; la IP solo baja un punto. Detrás de una
 * misma IP hay una casa entera o un café: que uno acierte no demuestra que
 * los otros diecinueve intentos fueran legítimos.
 */
export async function clearAttempts(ip: string, userIdentifier: string): Promise<void> {
  await LoginAttempt.deleteOne({ scope: 'user', key: userIdentifier });

  const ipRecord = await LoginAttempt.findOne({ scope: 'ip', key: ip });
  if (!ipRecord) return;

  const count = Math.max(0, ipRecord.count - 1);
  if (count === 0) {
    await LoginAttempt.deleteOne({ _id: ipRecord._id });
    return;
  }

  await LoginAttempt.updateOne({ _id: ipRecord._id }, { $set: { count, updatedAt: new Date() } });
}

/** Intentos que le quedan a una cuenta antes del bloqueo. */
export async function getRemainingAttempts(userIdentifier: string): Promise<number> {
  const record = await LoginAttempt.findOne({ scope: 'user', key: userIdentifier }).lean();
  if (!record) return MAX_ATTEMPTS_PER_USER;
  return Math.max(0, MAX_ATTEMPTS_PER_USER - record.count);
}
